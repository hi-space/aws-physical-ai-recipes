import { createHash } from 'node:crypto';
import { currentBackend } from '../backends/context';
import { k8sGetOrNull } from '../k8s/client';
import { listNodes, listPods, type Node, type Pod } from '../k8s/resources';
import type { Workflow } from '../store/types';
import { queueForNamespace } from '../workflow/compile';
import { createTopologyInventory } from '../workflow/topology/inventory';
import { TopologyError } from '../workflow/topology/planner';
import type { TopologyLevel } from '../workflow/topology/types';

interface Resource {
  metadata: { name: string; uid?: string; labels?: Record<string, string> };
  spec?: {
    clusterQueue?: string; stopPolicy?: string;
    namespaceSelector?: { matchLabels?: Record<string, string>; matchExpressions?: { key: string; operator: string; values?: string[] }[] };
    resourceGroups?: { flavors: { name: string }[] }[];
    nodeLabels?: Record<string, string>; topologyName?: string;
    levels?: { nodeLabel: string }[];
  };
}
export interface ProductionTopologyReaders {
  get(path: string): Promise<Resource | null>;
  nodes(selector?: string): Promise<Node[]>;
  pods(): Promise<Pod[]>;
  backendId(): string;
  now(): Date;
}
const real: ProductionTopologyReaders = {
  get: k8sGetOrNull, nodes: listNodes, pods: () => listPods(),
  backendId: () => currentBackend()?.id ?? 'default', now: () => new Date(),
};
function fail(message: string): never { throw new TopologyError('CONFIG', message); }
const aliases: Record<string, string> = {
  'topology.k8s.aws/zone-id': 'zone',
  'topology.kubernetes.io/zone': 'zone',
  'kubernetes.io/hostname': 'node',
};
function namespaceMatches(selector: NonNullable<Resource['spec']>['namespaceSelector'], labels: Record<string, string>) {
  if (!selector) return false;
  if (Object.entries(selector.matchLabels ?? {}).some(([key, value]) => labels[key] !== value)) return false;
  return (selector.matchExpressions ?? []).every(expression => {
    const present = Object.hasOwn(labels, expression.key), value = labels[expression.key];
    if (expression.operator === 'In') return present && !!expression.values?.includes(value);
    if (expression.operator === 'NotIn') return !present || !expression.values?.includes(value);
    if (expression.operator === 'Exists') return present;
    if (expression.operator === 'DoesNotExist') return !present;
    return fail('Unsupported ClusterQueue namespace selector');
  });
}

/** Backend-local, read-only registration derived from the actual governed queue/flavors/Topology. */
export async function productionTopologyInventory(workflow: Workflow, signal: AbortSignal, readers = real) {
  signal.throwIfAborted();
  const backendId = workflow.backendId ?? 'default';
  if (readers.backendId() !== backendId) fail('Topology inventory backend context does not match the workflow');
  const queue = queueForNamespace(workflow.namespace, workflow.spec.workflow.queue);
  if (!queue) fail('Native topology requires the project admission queue');
  const [namespace, local] = await Promise.all([
    readers.get(`/api/v1/namespaces/${encodeURIComponent(workflow.namespace)}`),
    readers.get(`/apis/kueue.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(workflow.namespace)}/localqueues/${encodeURIComponent(queue)}`),
  ]);
  if (!namespace?.metadata.uid || !local?.metadata.uid || !local.spec?.clusterQueue) fail('Project namespace/LocalQueue registration is unavailable');
  const cluster = await readers.get(`/apis/kueue.x-k8s.io/v1beta1/clusterqueues/${encodeURIComponent(local.spec.clusterQueue)}`);
  if (!cluster?.metadata.uid || !namespaceMatches(cluster.spec?.namespaceSelector, namespace.metadata.labels ?? {})) fail('ClusterQueue does not authorize the project namespace');
  if ([local.spec.stopPolicy, cluster.spec?.stopPolicy].some(policy => policy && policy !== 'None')) fail('Project admission queue is stopped');
  const flavorNames = [...new Set(cluster.spec?.resourceGroups?.flatMap(group => group.flavors.map(flavor => flavor.name)) ?? [])].sort();
  if (!flavorNames.length) fail('ClusterQueue has no registered resource flavors');
  const flavors = await Promise.all(flavorNames.map(name => readers.get(`/apis/kueue.x-k8s.io/v1beta1/resourceflavors/${encodeURIComponent(name)}`)));
  if (flavors.some(flavor => !flavor?.metadata.uid || !flavor.spec?.topologyName || !Object.keys(flavor.spec.nodeLabels ?? {}).length)) fail('Every queue flavor must declare its node selector and registered topology');
  const known = flavors as Resource[];
  const topologyNames = [...new Set(known.map(flavor => flavor.spec!.topologyName!))];
  if (topologyNames.length !== 1) fail('Queue flavors do not share one registered physical hierarchy');
  const topology = await readers.get(`/apis/kueue.x-k8s.io/v1beta1/topologies/${encodeURIComponent(topologyNames[0])}`);
  if (!topology?.metadata.uid || !topology.spec?.levels?.length) fail('Registered Kueue Topology is unavailable');
  const levels: TopologyLevel[] = topology.spec.levels.map(level => ({ key: aliases[level.nodeLabel] ?? level.nodeLabel, label: level.nodeLabel }));
  if (new Set(levels.map(level => level.key)).size !== levels.length) fail('Registered topology has ambiguous level aliases');
  const selectors = known.map(flavor => flavor.spec!.nodeLabels!);
  // Only common labels form the broad query; the complete flavor union is enforced below.
  const common = Object.fromEntries(Object.entries(selectors[0]).filter(([key, value]) => selectors.every(selector => selector[key] === value)));
  if (!Object.keys(common).length) fail('Queue flavors have no shared registered pool selector');
  const revision = createHash('sha256').update(JSON.stringify({
    backendId, namespace: namespace.metadata.uid, queue: [local.metadata.uid, local.spec],
    clusterQueue: [cluster.metadata.uid, cluster.spec], flavors: known.map(value => [value.metadata.uid, value.spec]),
    topology: [topology.metadata.uid, topology.spec],
  })).digest('hex');
  signal.throwIfAborted();
  return createTopologyInventory([{ namespace: workflow.namespace, queue, revision, nodeSelector: common, levels }], {
    listNodes: async selector => (await readers.nodes(selector)).filter(node =>
      selectors.some(flavor => Object.entries(flavor).every(([key, value]) => node.metadata.labels?.[key] === value))),
    listPods: readers.pods, now: readers.now,
  })(workflow, signal);
}
