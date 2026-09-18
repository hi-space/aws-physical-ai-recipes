import { createHash } from 'node:crypto';
import { HttpError } from '../errors';
import * as nodeOps from '../k8s/node-ops';
import { SYSTEM_NAMESPACES } from '../k8s/client';
import { listPodsOnNode } from '../k8s/node-ops';
import type { DescribeClusterResponse } from '@aws-sdk/client-sagemaker';

/** Label the workflow adapters put on every run pod (see src/server/workflow-adapters). */
const WORKFLOW_LABEL_KEY = 'pai.aws/workflow-id';

export interface NodeRecoveryPlan {
  observedAt: string;
  node: {
    name: string;
    instanceId?: string;
    group?: string;
    health?: string;
    ready: boolean;
    unschedulable: boolean;
    gpuCapacity: number;
  };
  cluster: {
    /** DescribeCluster.NodeRecovery: 'Automatic' | 'None' */
    nodeRecovery?: string;
  };
  pods: Array<{
    namespace: string;
    name: string;
    phase?: string;
    owner?: 'daemonset' | 'job' | 'pod' | string;
    workflowId?: string;
  }>;
  /** `code` is translated by the UI; `params` carry the values; `message` is an English fallback for API clients. */
  blockers: Array<{ code: 'node_recovery_disabled' | 'not_hyperpod_node' | 'already_pending' | 'cluster_mismatch'; message: string; params?: Record<string, string> }>;
  warnings: Array<{ code: 'running_pods'; message: string; params?: Record<string, string> }>;
  token: string;
}

export interface NodeRecoveryResult {
  appliedAt: string;
  label: string;
  node: {
    name: string;
    health?: string;
  };
}

export async function planNodeRecovery(
  cluster: DescribeClusterResponse,
  nodeName: string,
  action: 'reboot' | 'replace',
): Promise<NodeRecoveryPlan> {
  const observedAt = new Date().toISOString();
  const node = await nodeOps.getNode(nodeName);
  const groupLabel = node.metadata.labels?.['sagemaker.amazonaws.com/instance-group-name'];
  const instanceId = nodeOps.extractInstanceId(node.spec?.providerID);
  const health = node.metadata.labels?.['sagemaker.amazonaws.com/node-health-status'];
  const ready = node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;
  const unschedulable = node.spec?.unschedulable ?? false;
  const gpuCapacity = Number(node.status?.capacity?.['nvidia.com/gpu'] ?? 0);

  // Fetch pods on this node
  const allPods = await listPodsOnNode(nodeName);

  // Categorize pods: mark DaemonSet-owned and system-namespace pods
  const pods = allPods.map((pod) => {
    const podNamespace = pod.metadata.namespace ?? 'default';
    const ownerRef = pod.metadata.ownerReferences?.find((o) => o.kind);
    const owner = ownerRef?.kind.toLowerCase();
    const workflowId =
      !SYSTEM_NAMESPACES.has(podNamespace) && owner !== 'daemonset'
        ? pod.metadata.labels?.[WORKFLOW_LABEL_KEY]
        : undefined;
    return {
      namespace: podNamespace,
      name: pod.metadata.name,
      phase: pod.status?.phase,
      owner: owner,
      workflowId,
    };
  });

  const blockers: NodeRecoveryPlan['blockers'] = [];
  const warnings: NodeRecoveryPlan['warnings'] = [];

  // Blocker: node_recovery_disabled
  if (cluster.NodeRecovery !== 'Automatic') {
    blockers.push({
      code: 'node_recovery_disabled',
      message: `Cluster NodeRecovery is not Automatic (current: ${cluster.NodeRecovery ?? 'not set'})`,
      params: { current: cluster.NodeRecovery ?? 'None' },
    });
  }

  // Blocker: not_hyperpod_node
  if (!groupLabel) {
    blockers.push({
      code: 'not_hyperpod_node',
      message: 'Node is not part of a HyperPod instance group (missing sagemaker.amazonaws.com/instance-group-name label)',
    });
  }

  // Blocker: cluster_mismatch — the node carries the HyperPod cluster it belongs to; refuse when it is another cluster
  const nodeCluster = node.metadata.labels?.['sagemaker.amazonaws.com/cluster-name'];
  if (nodeCluster && cluster.ClusterName && nodeCluster !== cluster.ClusterName) {
    blockers.push({ code: 'cluster_mismatch', message: `Node belongs to cluster ${nodeCluster}, not ${cluster.ClusterName}`, params: { node: nodeCluster, cluster: cluster.ClusterName } });
  }

  // Blocker: already_pending
  const targetLabel = action === 'reboot' ? 'UnschedulablePendingReboot' : 'UnschedulablePendingReplacement';
  if (health === targetLabel) {
    blockers.push({
      code: 'already_pending',
      message: `Node is already labeled with ${targetLabel}`,
      params: { label: targetLabel },
    });
  }

  // Warning: running_pods (non-DaemonSet pods in non-system namespaces)
  const runningPods = pods.filter(
    (p) =>
      !SYSTEM_NAMESPACES.has(p.namespace) &&
      p.owner !== 'daemonset' &&
      (p.phase === 'Running' || p.phase === 'Pending'),
  );

  if (runningPods.length > 0) {
    const podList = runningPods
      .map((p) => `${p.namespace}/${p.name}${p.workflowId ? ` (${p.workflowId})` : ''}`)
      .join(', ');
    warnings.push({
      code: 'running_pods',
      message: `${runningPods.length} running pod(s) will be terminated: ${podList}`,
      params: { count: String(runningPods.length), pods: podList },
    });
  }

  // Generate token: hash of (node uid, current health label, sorted pod uids)
  const token = generateToken(
    node.metadata.uid ?? '',
    health ?? '',
    allPods
      .map((p) => p.metadata.uid ?? '')
      .sort()
      .join(','),
  );

  return {
    observedAt,
    node: {
      name: nodeName,
      instanceId,
      group: groupLabel,
      health,
      ready,
      unschedulable,
      gpuCapacity,
    },
    cluster: {
      nodeRecovery: cluster.NodeRecovery,
    },
    pods,
    blockers,
    warnings,
    token,
  };
}

export async function executeNodeRecovery(
  cluster: DescribeClusterResponse,
  nodeName: string,
  action: 'reboot' | 'replace',
  token: string,
  acknowledgeRunningPods: boolean,
): Promise<NodeRecoveryResult> {
  // Re-verify the plan
  const currentPlan = await planNodeRecovery(cluster, nodeName, action);

  // Verify token
  if (currentPlan.token !== token) {
    throw new HttpError(409, 'Node state has changed. Please review the plan again.', 'node_state_changed');
  }

  // Check for blockers
  if (currentPlan.blockers.length > 0) {
    throw new HttpError(
      409,
      `Cannot execute: ${currentPlan.blockers.map((b) => b.message).join('; ')}`,
      currentPlan.blockers[0]?.code ?? 'blocker_present',
    );
  }

  // Check for running_pods warning
  const runningPodsWarning = currentPlan.warnings.find((w) => w.code === 'running_pods');
  if (runningPodsWarning && !acknowledgeRunningPods) {
    throw new HttpError(400, 'Running pods will be terminated. Please acknowledge before proceeding.', 'ack_required');
  }

  // Apply the label
  const targetLabel = action === 'reboot' ? 'UnschedulablePendingReboot' : 'UnschedulablePendingReplacement';
  const updatedNode = await nodeOps.setNodeHealthLabel(nodeName, targetLabel);

  return {
    appliedAt: new Date().toISOString(),
    label: targetLabel,
    node: {
      name: updatedNode.metadata.name,
      health: updatedNode.metadata.labels?.['sagemaker.amazonaws.com/node-health-status'],
    },
  };
}

function generateToken(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
