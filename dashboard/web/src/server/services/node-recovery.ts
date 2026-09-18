import { createHash } from 'node:crypto';
import type { DescribeClusterResponse } from '@aws-sdk/client-sagemaker';
import { HttpError } from '../errors';
import * as hp from '../aws/hyperpod';
import { SYSTEM_NAMESPACES } from '../k8s/client';
import { findNodeByInstanceId, listPodsOnNode } from '../k8s/node-ops';

/** Label the workflow adapters put on every run pod (see src/server/workflow-adapters). */
const WORKFLOW_LABEL_KEY = 'pai.aws/workflow-id';
export type RecoveryAction = 'reboot' | 'replace';
export const RECOVERY_API: Record<RecoveryAction, string> = { reboot: 'BatchRebootClusterNodes', replace: 'BatchReplaceClusterNodes' };

export interface NodeRecoveryPlan {
  observedAt: string;
  action: RecoveryAction;
  /** SageMaker API the execute step will call. */
  api: string;
  node: {
    instanceId: string;
    group?: string;
    instanceType?: string;
    /** DescribeClusterNode.InstanceStatus.Status (Running, Pending, SystemUpdating, …) */
    instanceStatus?: string;
    instanceStatusMessage?: string;
    launchTime?: string;
    /** Kubernetes side (EKS clusters only, when the instance has joined). */
    k8sName?: string;
    health?: string;
    ready?: boolean;
    unschedulable?: boolean;
    gpuCapacity?: number;
  };
  cluster: { name: string; orchestrator: 'eks' | 'slurm'; status?: string; nodeRecovery?: string };
  pods: Array<{ namespace: string; name: string; phase?: string; owner?: string; workflowId?: string }>;
  /** `code` is translated by the UI; `params` carry the values; `message` is an English fallback for API clients. */
  blockers: Array<{ code: 'instance_not_running' | 'cluster_not_in_service' | 'not_in_cluster'; message: string; params?: Record<string, string> }>;
  warnings: Array<{ code: 'running_pods' | 'k8s_node_missing'; message: string; params?: Record<string, string> }>;
  token: string;
}

export interface NodeRecoveryResult {
  appliedAt: string;
  api: string;
  successful: string[];
  failed: { nodeId?: string; code?: string; message?: string }[];
}

export async function planNodeRecovery(cluster: DescribeClusterResponse, instanceId: string, action: RecoveryAction): Promise<NodeRecoveryPlan> {
  const observedAt = new Date().toISOString();
  const clusterName = cluster.ClusterName ?? '';
  const orchestrator: 'eks' | 'slurm' = cluster.Orchestrator?.Eks ? 'eks' : 'slurm';
  const blockers: NodeRecoveryPlan['blockers'] = [];
  const warnings: NodeRecoveryPlan['warnings'] = [];

  let details: Awaited<ReturnType<typeof hp.describeNode>>['NodeDetails'];
  try {
    details = (await hp.describeNode(clusterName, instanceId)).NodeDetails;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    blockers.push({ code: 'not_in_cluster', message: `DescribeClusterNode failed: ${message}`, params: { instanceId, cluster: clusterName, error: message } });
  }
  const instanceStatus = details?.InstanceStatus?.Status;
  if (details && instanceStatus !== 'Running') {
    blockers.push({ code: 'instance_not_running', message: `Instance status is ${instanceStatus ?? 'unknown'}`, params: { status: instanceStatus ?? 'unknown' } });
  }
  if (cluster.ClusterStatus !== 'InService') {
    blockers.push({ code: 'cluster_not_in_service', message: `Cluster status is ${cluster.ClusterStatus ?? 'unknown'}`, params: { status: cluster.ClusterStatus ?? 'unknown' } });
  }

  // Kubernetes view (EKS only): health label, readiness and the pods that will be terminated.
  let k8s: NodeRecoveryPlan['node'] extends infer N ? Partial<N> : never = {};
  let podUids: string[] = [];
  let pods: NodeRecoveryPlan['pods'] = [];
  if (orchestrator === 'eks' && details) {
    const node = await findNodeByInstanceId(instanceId).catch(() => undefined);
    if (!node) {
      warnings.push({ code: 'k8s_node_missing', message: 'No Kubernetes node with this instance id; pods on it cannot be listed.' });
    } else {
      k8s = {
        k8sName: node.metadata.name,
        health: node.metadata.labels?.['sagemaker.amazonaws.com/node-health-status'],
        ready: node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
        unschedulable: node.spec?.unschedulable ?? false,
        gpuCapacity: Number(node.status?.capacity?.['nvidia.com/gpu'] ?? 0),
      };
      const all = await listPodsOnNode(node.metadata.name);
      podUids = all.map((p) => p.metadata.uid ?? '').sort();
      pods = all.map((pod) => {
        const namespace = pod.metadata.namespace ?? 'default';
        const owner = pod.metadata.ownerReferences?.[0]?.kind.toLowerCase();
        return { namespace, name: pod.metadata.name, phase: pod.status?.phase, owner, workflowId: pod.metadata.labels?.[WORKFLOW_LABEL_KEY] };
      });
      const running = pods.filter((p) => !SYSTEM_NAMESPACES.has(p.namespace) && p.owner !== 'daemonset' && (p.phase === 'Running' || p.phase === 'Pending'));
      if (running.length) {
        const list = running.map((p) => `${p.namespace}/${p.name}${p.workflowId ? ` (${p.workflowId})` : ''}`).join(', ');
        warnings.push({ code: 'running_pods', message: `${running.length} running pod(s) will be terminated: ${list}`, params: { count: String(running.length), pods: list } });
      }
    }
  }

  const token = createHash('sha256').update([clusterName, instanceId, action, instanceStatus ?? '', k8s.health ?? '', podUids.join(',')].join('|')).digest('hex');
  return {
    observedAt, action, api: RECOVERY_API[action],
    node: {
      instanceId, group: details?.InstanceGroupName, instanceType: details?.InstanceType, instanceStatus,
      instanceStatusMessage: details?.InstanceStatus?.Message, launchTime: details?.LaunchTime?.toISOString(), ...k8s,
    },
    cluster: { name: clusterName, orchestrator, status: cluster.ClusterStatus, nodeRecovery: cluster.NodeRecovery },
    pods, blockers, warnings, token,
  };
}

export async function executeNodeRecovery(cluster: DescribeClusterResponse, instanceId: string, action: RecoveryAction, token: string, acknowledgeRunningPods: boolean): Promise<NodeRecoveryResult> {
  const current = await planNodeRecovery(cluster, instanceId, action);
  if (current.token !== token) throw new HttpError(409, 'Node state has changed. Review the plan again.', 'node_state_changed');
  if (current.blockers.length) throw new HttpError(409, `Cannot execute: ${current.blockers.map((b) => b.message).join('; ')}`, current.blockers[0].code);
  if (current.warnings.some((w) => w.code === 'running_pods') && !acknowledgeRunningPods) throw new HttpError(400, 'Running pods will be terminated. Acknowledge before proceeding.', 'ack_required');
  const out = action === 'reboot' ? await hp.rebootNodes(current.cluster.name, [instanceId]) : await hp.replaceNodes(current.cluster.name, [instanceId]);
  return {
    appliedAt: new Date().toISOString(), api: RECOVERY_API[action],
    successful: out.Successful ?? [],
    failed: (out.Failed ?? []).map((f) => ({ nodeId: f.NodeId, code: f.ErrorCode, message: f.Message })),
  };
}
