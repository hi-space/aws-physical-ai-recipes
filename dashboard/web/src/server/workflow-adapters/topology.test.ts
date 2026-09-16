import { beforeEach, expect, it, vi } from 'vitest';
import type { Workflow } from '../store/types';
import { productionTopologyInventory, type ProductionTopologyReaders } from './topology';

let resources: Record<string, unknown>, readers: ProductionTopologyReaders;
const workflow = { id: 'run', backendId: 'default', namespace: 'team-a', spec: { workflow: { queue: 'q-a' } } } as Workflow;
beforeEach(() => {
  resources = {
    '/api/v1/namespaces/team-a': { metadata: { name: 'team-a', uid: 'ns', labels: { 'kubernetes.io/metadata.name': 'team-a' } } },
    '/apis/kueue.x-k8s.io/v1beta1/namespaces/team-a/localqueues/q-a': { metadata: { name: 'q-a', uid: 'lq' }, spec: { clusterQueue: 'cq-a', stopPolicy: 'None' } },
    '/apis/kueue.x-k8s.io/v1beta1/clusterqueues/cq-a': { metadata: { name: 'cq-a', uid: 'cq' }, spec: {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'team-a' } }, resourceGroups: [{ flavors: [{ name: 'cpu' }, { name: 'gpu' }] }],
    } },
    '/apis/kueue.x-k8s.io/v1beta1/resourceflavors/cpu': { metadata: { name: 'cpu', uid: 'cpu' }, spec: { topologyName: 'registered', nodeLabels: { pool: 'hyperpod', type: 'cpu' } } },
    '/apis/kueue.x-k8s.io/v1beta1/resourceflavors/gpu': { metadata: { name: 'gpu', uid: 'gpu' }, spec: { topologyName: 'registered', nodeLabels: { pool: 'hyperpod', type: 'gpu' } } },
    // Actual deployment serves Topology in v1beta1/v1beta2, not v1alpha1.
    '/apis/kueue.x-k8s.io/v1beta1/topologies/registered': { metadata: { name: 'registered', uid: 'topology' }, spec: {
      levels: [{ nodeLabel: 'topology.k8s.aws/zone-id' }, { nodeLabel: 'kubernetes.io/hostname' }],
    } },
  };
  readers = {
    get: async path => (resources[path] ?? null) as Awaited<ReturnType<ProductionTopologyReaders['get']>>,
    backendId: () => 'default', now: () => new Date('2026-09-16T00:00:00Z'), pods: async () => [],
    nodes: vi.fn(async () => ['cpu', 'gpu', 'other'].map(type => ({
      metadata: { name: type, uid: type, labels: { pool: 'hyperpod', type, 'topology.k8s.aws/zone-id': 'use1-az4', 'kubernetes.io/hostname': type } },
      status: { allocatable: { cpu: '16', memory: '32Gi', pods: '29' }, conditions: [{ type: 'Ready', status: 'True' }] },
    }))),
  };
});
it('derives the hierarchy from registered flavors and excludes nodes outside the flavor union', async () => {
  const inventory = await productionTopologyInventory(workflow, new AbortController().signal, readers);
  expect(inventory.levels).toEqual([{ key: 'zone', label: 'topology.k8s.aws/zone-id' }, { key: 'node', label: 'kubernetes.io/hostname' }]);
  expect(inventory.nodes.map(node => node.name)).toEqual(['cpu', 'gpu']);
  expect(readers.nodes).toHaveBeenCalledWith('pool=hyperpod');
  expect(inventory.revision).toMatch(/^[a-f0-9]{64}$/);
});
it('rejects a same-named queue read from another backend and unauthorized namespace', async () => {
  readers.backendId = () => 'foreign';
  await expect(productionTopologyInventory(workflow, new AbortController().signal, readers)).rejects.toThrow(/backend context/);
  readers.backendId = () => 'default';
  (resources['/api/v1/namespaces/team-a'] as { metadata: { labels: Record<string, string> } }).metadata.labels = {};
  await expect(productionTopologyInventory(workflow, new AbortController().signal, readers)).rejects.toThrow(/authorize/);
});
it('fails closed when a flavor lacks topology or hierarchy reads are unavailable', async () => {
  delete (resources['/apis/kueue.x-k8s.io/v1beta1/resourceflavors/cpu'] as { spec: { topologyName?: string } }).spec.topologyName;
  await expect(productionTopologyInventory(workflow, new AbortController().signal, readers)).rejects.toThrow(/Every queue flavor/);
  expect(readers.nodes).not.toHaveBeenCalled();
});
it('registration identity changes with flavor policy but not status/resource-version churn', async () => {
  const first = await productionTopologyInventory(workflow, new AbortController().signal, readers);
  Object.assign(resources['/apis/kueue.x-k8s.io/v1beta1/clusterqueues/cq-a'] as object, { status: { pendingWorkloads: 3 }, resourceVersion: 'changed' });
  expect((await productionTopologyInventory(workflow, new AbortController().signal, readers)).revision).toBe(first.revision);
  (resources['/apis/kueue.x-k8s.io/v1beta1/resourceflavors/gpu'] as { spec: { nodeLabels: Record<string, string> } }).spec.nodeLabels.type = 'gpu-new';
  expect((await productionTopologyInventory(workflow, new AbortController().signal, readers)).revision).not.toBe(first.revision);
});
