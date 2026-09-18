import { forbidden } from '../errors';
import { k8sJson } from './client';
import type { Node, Pod } from './resources';
import { listPods } from './resources';

export async function getNode(name: string): Promise<Node> {
  return k8sJson<Node>(`/api/v1/nodes/${encodeURIComponent(name)}`);
}

export async function listPodsOnNode(name: string): Promise<Pod[]> {
  return listPods(undefined, undefined, `spec.nodeName=${name}`);
}

/**
 * EC2 instance id from `spec.providerID`. Plain EKS nodes use `aws:///<az>/i-…`; HyperPod nodes use
 * `aws:///<az-id>/sagemaker/cluster/hyperpod-<cluster-id>-i-…` (observed on a live cluster). Both end in the instance id.
 */
export function extractInstanceId(providerID?: string): string | undefined {
  if (!providerID || !providerID.startsWith('aws:///')) return undefined;
  return providerID.match(/(i-[0-9a-f]{8,17})$/)?.[1];
}

/**
 * Check if the node has the required HyperPod group label
 */
export function requiresHyperPodLabel(node: Node): void {
  const groupLabel = node.metadata.labels?.['sagemaker.amazonaws.com/instance-group-name'];
  if (!groupLabel) throw forbidden('Node is not part of a HyperPod instance group (missing sagemaker.amazonaws.com/instance-group-name label)');
}

/**
 * Apply a health status label to the node via PATCH merge-patch.
 * Label: sagemaker.amazonaws.com/node-health-status=<status>
 */
export async function setNodeHealthLabel(name: string, status: 'UnschedulablePendingReboot' | 'UnschedulablePendingReplacement'): Promise<Node> {
  const node = await getNode(name);
  requiresHyperPodLabel(node);
  const labels = { ...(node.metadata.labels ?? {}), 'sagemaker.amazonaws.com/node-health-status': status };
  return k8sJson<Node>(`/api/v1/nodes/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: { metadata: { labels } },
  });
}

/**
 * Set the node's unschedulable flag via PATCH merge-patch.
 */
export async function setCordon(name: string, unschedulable: boolean): Promise<Node> {
  return k8sJson<Node>(`/api/v1/nodes/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: { spec: { unschedulable } },
  });
}
