import { assertPlan } from './affinity';
import { describe, expect, it } from 'vitest';
import { taskSchema, workflowSchema, type WorkflowSpec } from '../schema';
import { planTopology, TopologyError } from './planner';
import { compileGroup } from '../groups';
import type { TopologyInventory, TopologyNode } from './types';
const time = '2026-09-16T00:00:00.000Z';
export const node = (name: string, zone: string, rack: string, cpu = 2): TopologyNode => ({
  name, uid: `${name}-uid`, labels: { 'topology.kubernetes.io/zone': zone, 'fabric/rack': rack,
    'sagemaker.amazonaws.com/node-health-status': 'Schedulable', 'kubernetes.io/hostname': name },
  ready: true, available: { cpu, memory: 1e10, pods: 100 }, taints: [],
});
export const inventory = (nodes: TopologyNode[]): TopologyInventory => ({
  namespace: 'n', queue: 'q', revision: 'r1', observedAt: time,
  levels: [{ key: 'zone', label: 'topology.kubernetes.io/zone' }, { key: 'rack', label: 'fabric/rack' }], nodes,
});
const topology = (zone: string, rack: string, requirementType = 'required') => [{ key: 'rack', group: rack, requirementType }, { key: 'zone', group: zone, requirementType }];
export function spec(resources: Record<string, unknown>, names = Object.keys(resources)): WorkflowSpec {
  const tasks = names.map((resource, i) => taskSchema.parse({ name: `t${i}`, resource, image: 'busybox', command: ['true'], lead: i === 0, group: 'g' }));
  return workflowSchema.parse({ workflow: { name: 'top', namespace: 'n', queue: 'q', resources,
    tasks, groups: [{ name: 'g', tasks }] } });
}
export function plan(s: WorkflowSpec, i: TopologyInventory, options = {}) {
  return planTopology({ spec: s, tasks: s.workflow.tasks, inventory: i, namespace: 'n', queue: 'q',
    workflowId: 'wf', epoch: 'epoch', now: new Date(time), ...options });
}
describe('OSMO native topology placement', () => {
  it('enforces same groups at multiple keys with one admission root and no pod affinity', () => {
    const s = spec({ a: { cpu: 2, topology: topology('all', 'model') } }, ['a', 'a']);
    const p = plan(s, inventory([node('n1', 'z1', 'r1'), node('n2', 'z1', 'r1'), node('n3', 'z1', 'r2')]));
    expect(p.tasks.t0.required).toEqual(p.tasks.t1.required);
    expect(p.tasks.t0.required).toEqual({ 'topology.kubernetes.io/zone': 'z1', 'fabric/rack': 'r1' });
    const compiled = compileGroup(s, s.workflow.groups![0], { backendId: 'training-backend', workflowId: 'wf', owner: 'alice', namespace: 'n', queue: 'q', epoch: 'epoch',
      datasetPaths: {}, credentialValues: {}, runtimeCommand: '/runtime', topologyPlan: p }, 'epoch');
    expect(compiled.jobSet.spec.suspend).toBe(true);
    expect(compiled.jobSet.metadata.labels?.['kueue.x-k8s.io/queue-name']).toBe('q');
    for (const child of compiled.jobSet.spec.replicatedJobs) {
      const pod = child.template.spec.template.spec as any;
      expect(child.template.metadata.labels?.['pai.aws/backend']).toBe('training-backend');
      expect(child.template.spec.template.metadata?.labels?.['pai.aws/backend']).toBe('training-backend');
      expect(pod.nodeName).toBeUndefined();
      expect(pod.affinity.podAffinity).toBeUndefined();
      const terms = pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms;
      expect(terms).toHaveLength(2);
      expect(terms.every((term: any) => term.matchFields.every((e: any) => e.values.length === 1))).toBe(true);
      expect(pod.nodeSelector).toMatchObject({ 'fabric/rack': 'r1', 'topology.kubernetes.io/zone': 'z1' });
      expect(child.template.spec.backoffLimit).toBe(0);
      expect(JSON.stringify(pod)).toContain('epoch');
    }
  });
  it('different groups can split racks but are not forced apart', () => {
    const s = spec({ a: { cpu: 2, topology: topology('all', 'a') }, b: { cpu: 2, topology: topology('all', 'b') } });
    const p = plan(s, inventory([node('n1', 'z1', 'r1'), node('n2', 'z1', 'r2')]));
    expect(p.tasks.t0.required['fabric/rack']).not.toBe(p.tasks.t1.required['fabric/rack']);
    const same = plan(s, inventory([node('n1', 'z1', 'r1', 4)]));
    expect(same.tasks.t0.required).toEqual(same.tasks.t1.required);
  });
  it('scopes reused fine group names under their coarse group and physical ancestry', () => {
    const s = spec({ a: { cpu: 2, nodesExcluded: ['n2'], topology: topology('a', 'same') }, b: { cpu: 2, nodesExcluded: ['n1'], topology: topology('b', 'same') } });
    const p = plan(s, inventory([node('n1', 'z1', 'local-rack'), node('n2', 'z2', 'local-rack')]));
    expect(p.tasks.t0.required['topology.kubernetes.io/zone']).toBe('z1');
    expect(p.tasks.t1.required['topology.kubernetes.io/zone']).toBe('z2');
    const impossible = spec({ a: { cpu: 2, topology: [{ key: 'rack' }] } }, ['a', 'a']);
    expect(() => plan(impossible, inventory([node('n1', 'z1', 'local-rack'), node('n2', 'z2', 'local-rack')]))).toThrow(/NO_FIT/);
  });
  it('preferred can fall back across domains without weakening a required zone', () => {
    const s = spec({ a: { cpu: 2, topology: [topology('all', 'same')[1], { key: 'rack', requirementType: 'preferred' }] } }, ['a', 'a']);
    const p = plan(s, inventory([node('n1', 'z1', 'r1'), node('n2', 'z1', 'r2')]));
    expect(p.relaxed).toEqual(expect.arrayContaining([expect.stringContaining('rack')]));
    expect(p.tasks.t0.required).toEqual({ 'topology.kubernetes.io/zone': 'z1' });
    expect(p.tasks.t0.preferred.length).toBeGreaterThan(0);
    expect(p.tasks.t0.required['fabric/rack']).toBeUndefined();
    expect(() => plan(s, inventory([node('n1', 'z1', 'r1'), node('n2', 'z2', 'r2')]))).toThrow(/NO_FIT/);
  });
  it('honors exclusions by node name even if hostname differs, readiness, taints, platform and GPU fit', () => {
    const s = spec({ a: { gpu: 1, platform: 'ml.g5.8xlarge', topology: [{ key: 'rack' }], nodesExcluded: ['excluded'] } });
    const nodes = ['excluded', 'unready', 'tainted', 'wrong-platform', 'fits'].map(name => ({ ...node(name, 'z1', 'r1'),
      labels: { ...node(name, 'z1', 'r1').labels, 'kubernetes.io/hostname': 'alias', 'node.kubernetes.io/instance-type': 'ml.g5.8xlarge' },
      available: { cpu: 10, pods: 10, 'nvidia.com/gpu': 1 } }));
    nodes[1].ready = false; nodes[2].taints = [{ key: 'dedicated', effect: 'NoSchedule' }];
    nodes[3].labels['node.kubernetes.io/instance-type'] = 'other';
    const p = plan(s, inventory(nodes));
    expect(p.tasks.t0.nodes.map(n => n.name)).toEqual(['fits']);
    expect(p.diagnostics.join(' ')).toMatch(/excluded/);
  });
  it('counts all replicas and non-topology members in the capacity witness', () => {
    const s = spec({ a: { cpu: 1, topology: [{ key: 'rack' }] }, b: { cpu: 2 } });
    s.workflow.tasks[0].parallelism = 2;
    expect(() => plan(s, inventory([node('n1', 'z1', 'r1', 3)]))).toThrow(/NO_FIT/);
  });
  it('rejects unknown keys, stale snapshots, conflicting requirement modes and cross-admission co-location precisely', () => {
    const s = spec({ a: { topology: [{ key: 'unknown' }] } });
    expect(() => plan(s, inventory([node('n1', 'z1', 'r1')]))).toThrow(/unregistered.*unknown/);
    const valid = spec({ a: { topology: [{ key: 'rack' }] } });
    expect(() => plan(valid, { ...inventory([]), observedAt: '2020-01-01' })).toThrow(/STALE/);
    const mixed = spec({ a: { topology: [{ key: 'rack' }] }, b: { topology: [{ key: 'rack', requirementType: 'preferred' }] } });
    expect(() => plan(mixed, inventory([]))).toThrow(/mixed.*required.*preferred/);
    const cross = spec({ a: { topology: [{ key: 'rack' }] } }, ['a', 'a']);
    cross.workflow.tasks[1].group = 'other';
    expect(() => plan(cross, inventory([]), { tasks: [cross.workflow.tasks[0]] })).toThrow(/single admission unit.*rack/);
  });
  it('distinguishes a search bound from proof of unsatisfiability and rejects queue-less launch', () => {
    const s = spec({ a: { cpu: 2, topology: [{ key: 'rack' }] } }, ['a', 'a']);
    expect(() => plan(s, inventory([node('n1', 'z1', 'r1', 4)]), { maxSearch: 1 })).toThrow(/SEARCH_LIMIT/);
    expect(() => plan(s, inventory([]), { queue: undefined })).toThrow(/admission queue/);
    expect(TopologyError).toBeDefined();
  });
});
it('permits independent admission groups whose entire topology ancestry is independent', () => {
  const s = spec({ a: { topology: topology('zone-a', 'same') }, b: { topology: topology('zone-b', 'same') } });
  s.workflow.tasks[1].group = 'another';
  const p = plan(s, inventory([node('n1', 'z1', 'r1')]), { tasks: [s.workflow.tasks[0]] });
  expect(Object.keys(p.tasks)).toEqual(['t0']);
});
it('replica co-location cannot collapse across equal rack labels in different physical parents', () => {
  const s = spec({ a: { cpu: 2, topology: [{ key: 'rack' }] } });
  s.workflow.tasks[0].parallelism = 2;
  expect(() => plan(s, inventory([node('n1', 'z1', 'r'), node('n2', 'z2', 'r')]))).toThrow(/NO_FIT/);
});
it('compiler rejects a stale epoch plan and preserves the legacy simple Kueue topology API', () => {
  const s = spec({ a: { cpu: 1, topology: [{ key: 'rack' }] } });
  const p = plan(s, inventory([node('n1', 'z1', 'r1')]));
  const ctx = { workflowId: 'wf', owner: 'alice', namespace: 'n', queue: 'q', datasetPaths: {}, credentialValues: {}, runtimeCommand: '/runtime' };
  expect(() => compileGroup(s, s.workflow.groups![0], { ...ctx, topologyPlan: p }, 'new-epoch')).toThrow(/epoch mismatch/);
  const simple = spec({ a: { cpu: 1 } });
  simple.workflow.groups![0].topology = { key: 'topology.kubernetes.io/zone', mode: 'required' };
  const root = compileGroup(simple, simple.workflow.groups![0], ctx, 'epoch').jobSet;
  expect(root.spec.replicatedJobs[0].template.spec.template.metadata?.annotations?.['kueue.x-k8s.io/podset-required-topology']).toBe('topology.kubernetes.io/zone');
});
it('adopts an unchanged plan after DynamoDB reorders Map keys but rejects changed hard domains', () => {
  const s = spec({ a: { topology: [{ key: 'rack' }] } });
  const p = plan(s, inventory([node('n1', 'z1', 'r1')]));
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
  const roundtrip = reorder(p);
  expect(() => assertPlan(roundtrip, 'wf', 'n', 'epoch')).not.toThrow();
  roundtrip.tasks.t0.required['fabric/rack'] = 'other';
  expect(() => assertPlan(roundtrip, 'wf', 'n', 'epoch')).toThrow(/integrity/);
});
