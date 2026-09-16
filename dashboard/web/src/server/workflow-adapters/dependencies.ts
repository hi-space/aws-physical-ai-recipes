import { realDeps, type ControllerDeps } from '../workflow/controller';
import { artifactPublisher, cancelArtifactCollectors } from './artifacts';
import { dispatchWorkflow, completeWorkflow } from './dispatch';
import { runtimeEnvironment, groupRuntime, mintMetricsCapability } from '../runtime';
import { getJobSet, createJobSet, deleteJobSet } from '../k8s/resources';
import { validateTaskImagePolicy } from '../services/profile-binding';
import { enqueueWorkflowWebhook } from '../services/webhooks';
import { getRepo } from '../store/repo';
import { productionTopologyInventory } from './topology';

export function productionControllerDeps(): ControllerDeps {
  const base = realDeps();
  return {
    ...base, artifactPublisher, dispatchWorkflow,
    completeWorkflow: async (workflow, context) => {
      await completeWorkflow(workflow, context);
      context.signal.throwIfAborted();
      await enqueueWorkflowWebhook(await getRepo().getWorkflow(workflow.id) ?? workflow);
    },
    validateTaskPolicy: validateTaskImagePolicy,
    topologyInventory: productionTopologyInventory,
    cancelArtifacts: cancelArtifactCollectors,
    artifactBucket: process.env.DASHBOARD_ARTIFACT_BUCKET,
    runtimeImage: process.env.TASK_RUNTIME_IMAGE,
    runtimeCommand: '/opt/pai/runtime',
    runtimeEnvironment: (workflow, task, epoch, attempt) => {
      const environment = runtimeEnvironment(workflow, task, epoch, attempt);
      if (workflow.spec.workflow.mlflow) {
        environment.PAI_RUNTIME_MLFLOW_URI = `${process.env.RUNTIME_API_URL}/tracking`;
        environment.PAI_RUNTIME_MLFLOW_TOKEN = mintMetricsCapability(workflow, task, epoch, attempt);
      }
      return environment;
    },
    groupRuntime,
    k8s: { ...base.k8s, getJobSet, createJobSet, deleteJobSet },
  };
}
