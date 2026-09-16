import { expect, it } from 'vitest';
import { workflowSchema } from '../schema';
import { planTopology } from './planner';
import { observePlacement } from './observe';
const now = new Date('2026-09-16T00:00:00Z');
const spec = workflowSchema.parse({ workflow: { name: 'w', tasks: [{ name: 'task', image: 'x', command: ['true'] }], resources: { default: { cpu: 1, topology: [{ key: 'rack' }] } } } });
const inventory = { namespace: 'n', queue: 'q', revision: '1', observedAt: now.toISOString(), levels: [{ key: 'rack', label: 'fabric/rack' }],
  nodes: [{ name: 'node', uid: 'uid', labels: { 'fabric/rack': 'a', 'sagemaker.amazonaws.com/node-health-status': 'Schedulable' },
    ready: true, taints: [], available: { cpu: 2, pods: 10 } }] };
const plan = planTopology({ spec, tasks: spec.workflow.tasks, inventory, namespace: 'n', queue: 'q', workflowId: 'wf', epoch: 'e', now });
const pod = { metadata: { name: 'pod', labels: { 'pai.aws/task': 'task', 'pai.aws/workflow-id': 'wf', 'pai.aws/epoch': 'e' } }, spec: { containers: [], nodeName: 'node' } };
it('reports observed bindings while rejecting relabeling and same-name node replacement', () => {
  const observed = observePlacement(plan, inventory, spec, spec.workflow.tasks, [pod], now);
  expect(observed.issue).toBeUndefined(); expect(observed.pods[0].node).toBe('node');
  for (const change of [{ uid: 'new-uid' }, { labels: { ...inventory.nodes[0].labels, 'fabric/rack': 'b' } }, { ready: false }]) {
    const next = { ...inventory, nodes: [{ ...inventory.nodes[0], ...change }] };
    expect(observePlacement(plan, next, spec, spec.workflow.tasks, [pod], now).issue).toBeDefined();
  }
});
it('does not treat missing or stale inventory as placement success', () => {
  expect(() => observePlacement(plan, { ...inventory, observedAt: '2020-01-01' }, spec, spec.workflow.tasks, [pod], now)).toThrow(/STALE/);
  expect(observePlacement(plan, { ...inventory, nodes: [] }, spec, spec.workflow.tasks, [pod], now).issue).toMatch(/unavailable/);
  expect(observePlacement(plan, { ...inventory, revision: '2' }, spec, spec.workflow.tasks, [pod], now).issue).toMatch(/registration|registered/);
});
