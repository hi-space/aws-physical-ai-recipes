import { TOPOLOGY_ANNOTATION } from './topology/affinity';
import { compileTask, jobSetNameFor, LABEL_WF, type CompileContext, type CompiledTask } from './compile';
import type { GroupSpec, WorkflowSpec } from './schema';
import type { Job } from '../k8s/resources';
import type { JobSet } from './ports';
export function compileGroup(spec: WorkflowSpec, group: GroupSpec, ctx: CompileContext, epoch: string, taskContexts?: Record<string, CompileContext>): {
  jobSet: JobSet;
  tasks: CompiledTask[];
} {
  if (!ctx.runtimeCommand && !ctx.runtimeImage) throw new Error('JobSet groups require verified barrier runtime');
  if (ctx.topologyPlan && ctx.queue !== ctx.topologyPlan.queue) throw new Error('topology admission queue mismatch');
  const lead = group.tasks.find(t => t.lead);
  if (!lead) throw new Error('group requires a leader');
  const participants = group.tasks.flatMap(t => Array.from({
    length: t.parallelism
  }, (_, replicaIndex) => ({
    id: `${t.name}:${replicaIndex}`,
    task: t.name,
    replicaIndex,
    resource: t.resource
  })));
  const groupContext = {
    name: group.name,
    epoch,
    participants,
    members: group.tasks.flatMap(t => Array.from({
      length: t.parallelism
    }, (_, index) => `${t.name}:${index}`)),
    barrier: group.barrier,
    ignoreNonleadStatus: group.ignoreNonleadStatus,
    lead: lead.name
  };
  const tasks = group.tasks.map(t => compileTask(spec, t, {
    ...(taskContexts?.[t.name] ?? ctx),
    queue: undefined,
    epoch,
    group: groupContext
  }));
  const name = jobSetNameFor(ctx.workflowId, group.name, ctx.attempt);
  const labels = {
    [LABEL_WF]: ctx.workflowId,
    'pai.aws/group': group.name,
    'pai.aws/epoch': epoch,
    'pai.aws/attempt': String(ctx.attempt ?? 1),
    ...(ctx.queue ? {
      'kueue.x-k8s.io/queue-name': ctx.queue
    } : {}),
    ...(ctx.priority ? {
      'kueue.x-k8s.io/priority-class': ctx.priority
    } : {})
  };
  const replicatedJobs = tasks.map((t, index) => {
    const j = t.job as unknown as Job;
    delete j.spec.suspend;
    if (ctx.queue) {
      j.spec.template.metadata ??= { name: '' };
      j.spec.template.metadata.labels = {
        ...j.spec.template.metadata.labels, 'kueue.x-k8s.io/queue-name': ctx.queue,
      };
    }
    // JobSet coordinator owns child lifecycle; dashboard owns whole-group retries.
    const topology = group.topology ?? group.tasks[index].topology;
    if (topology) {
      j.spec.template.metadata ??= {
        name: ''
      };
      j.spec.template.metadata.annotations = {
        ...j.spec.template.metadata.annotations,
        [`kueue.x-k8s.io/podset-${topology.mode}-topology`]: topology.key
      };
    }
    return {
      name: group.tasks[index].name,
      replicas: 1,
      template: {
        metadata: {
          // HyperPod validates the label on every child Job. Kueue follows the
          // JobSet owner reference and keeps admission on that ancestor.
          labels: { ...j.metadata.labels, ...(ctx.queue ? { 'kueue.x-k8s.io/queue-name': ctx.queue } : {}) }
        },
        spec: j.spec
      }
    };
  });
  return {
    tasks,
    jobSet: {
      apiVersion: 'jobset.x-k8s.io/v1alpha2',
      kind: 'JobSet',
      metadata: {
        name,
        namespace: ctx.namespace,
        ...(ctx.topologyPlan ? { annotations: { [TOPOLOGY_ANNOTATION]: ctx.topologyPlan.hash } } : {}),
        labels
      },
      spec: {
        suspend: !!ctx.queue,
        replicatedJobs,
        failurePolicy: {
          maxRestarts: 0
        },
        successPolicy: {
          operator: 'All',
          targetReplicatedJobs: [lead.name]
        },
        network: {
          enableDNSHostnames: true
        },
        coordinator: {
          replicatedJob: lead.name,
          jobIndex: 0,
          podIndex: 0
        }
      }
    }
  };
}
