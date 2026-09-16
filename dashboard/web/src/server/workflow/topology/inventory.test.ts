import { expect, it } from 'vitest';
import type { Node, Pod } from '../../k8s/resources';
import type { Workflow } from '../../store/types';
import { createTopologyInventory } from './inventory';
const registration = { namespace: 'n', queue: 'q', revision: 'r1', nodeSelector: { 'pai.aws/pool': 'training' }, levels: [{ key: 'zone', label: 'topology.kubernetes.io/zone' }] };
const now = new Date('2026-09-16T00:00:00Z');
const wf = { namespace: 'n', spec: { workflow: { queue: 'q' } } } as Workflow;
const node: Node = { metadata: { name: 'n1', uid: 'uid', labels: { 'pai.aws/pool': 'training' } },
  status: { allocatable: { cpu: '8', memory: '8Gi', pods: '10', 'nvidia.com/gpu': '2' }, conditions: [{ type: 'Ready', status: 'True' }] } };
it('reads registered pool nodes and subtracts effective requests including sidecar init, limits defaults and overhead', async () => {
  const pod = { metadata: { name: 'occupied' }, spec: { nodeName: 'n1',
    containers: [{ name: 'main', image: 'x', resources: { requests: { cpu: '2', memory: '1Gi' }, limits: { 'nvidia.com/gpu': '1' } } }],
    initContainers: [
      { name: 'sidecar', image: 'x', restartPolicy: 'Always', resources: { requests: { cpu: '1' } } },
      { name: 'init', image: 'x', resources: { requests: { cpu: '4', memory: '2Gi' } } },
    ], overhead: { cpu: '100m' },
  } } as unknown as Pod;
  const reader = createTopologyInventory([registration], { now: () => now,
    listNodes: async selector => { expect(selector).toBe('pai.aws/pool=training'); return [node, { ...node, metadata: { name: 'foreign', uid: 'f', labels: {} } }]; },
    listPods: async () => [pod, { ...pod, status: { phase: 'Succeeded' } }, { ...pod, spec: { ...pod.spec, nodeName: undefined } }],
  });
  const i = await reader(wf, new AbortController().signal);
  expect(i.nodes).toHaveLength(1);
  expect(i.nodes[0].available.cpu).toBeCloseTo(2.9);
  expect(i.nodes[0].available.memory).toBe(6 * 1024 ** 3);
  expect(i.nodes[0].available['nvidia.com/gpu']).toBe(1);
  expect(i.nodes[0].available.pods).toBe(9);
});
it('fails closed on unregistered queue, aborted reads, duplicate registrations and incomplete resource accounting', async () => {
  const options = { now: () => now, listNodes: async () => [node], listPods: async () => [] };
  expect(() => createTopologyInventory([registration, registration], options)).toThrow(/duplicate/);
  const reader = createTopologyInventory([registration], options);
  await expect(reader({ ...wf, namespace: 'foreign' }, new AbortController().signal)).rejects.toThrow(/not registered/);
  await expect(reader(wf, AbortSignal.abort())).rejects.toThrow();
  const unknown = createTopologyInventory([registration], { ...options, listPods: async () => [{ metadata: { name: 'pod' }, spec: { nodeName: 'n1', containers: [], resources: { requests: { cpu: '1' } } } } as Pod] });
  expect((await unknown(wf, new AbortController().signal)).nodes[0].unavailableReason).toMatch(/pod-level resources/);
});
