import type { Node, Pod } from './resources';
import { k8sJson } from './client';
import { listNodes, listPods } from './resources';

export async function getNode(name: string): Promise<Node> {
  return k8sJson<Node>(`/api/v1/nodes/${encodeURIComponent(name)}`);
}

/** The Kubernetes node backed by an EC2 instance, matched on the providerID suffix; undefined when not (yet) joined. */
export async function findNodeByInstanceId(instanceId: string): Promise<Node | undefined> {
  return (await listNodes()).find((n) => extractInstanceId(n.spec?.providerID) === instanceId);
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
