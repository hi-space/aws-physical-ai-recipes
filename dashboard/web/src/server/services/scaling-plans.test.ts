import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV, type Item } from '../store/dynamo';
import { clusterSpecHash } from '../aws/hyperpod';
import { executeScalePlan, planScale, reconcileScale, saveScalingPolicy, scaleSnapshot, type ScalingDeps, type ScalePlan } from './scaling-plans';
import { SCALE_ANNOTATION, type ScaleNode, type ScalePod } from './scaling-activity';
import type { ClusterNodeSummary, DescribeClusterResponse } from '@aws-sdk/client-sagemaker';
import { idleScalingTick } from './idle-scaling';

const cluster = 'hp-test', group = 'gpu', actor = 'admin';
const ids = ['i-00000000000000001', 'i-00000000000000002', 'i-00000000000000003'];
let repo: Repo, d: ScalingDeps, description: DescribeClusterResponse, nodes: ScaleNode[], pods: ScalePod[], instances: ClusterNodeSummary[], rows: Item[], complete: boolean;
let remove: ReturnType<typeof vi.fn>, increase: ReturnType<typeof vi.fn>, restore: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-16T18:00:00Z'));
  repo = new Repo(new MemoryKV()); rows = []; complete = true; pods = [];
  description = { ClusterName: cluster, ClusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/abcdefghijkl', ClusterStatus: 'InService',
    InstanceGroups: [{ InstanceGroupName: group, InstanceType: 'ml.g5.8xlarge', CurrentCount: 3, TargetCount: 3, Status: 'InService', ExecutionRole: 'role', LifeCycleConfig: { OnCreate: 'run.sh', SourceS3Uri: 's3://test/' } },
      { InstanceGroupName: 'cpu', InstanceType: 'ml.c5.4xlarge', CurrentCount: 1, TargetCount: 1, Status: 'InService' }] };
  instances = ids.map((id, index) => ({ InstanceId: id, InstanceGroupName: group, InstanceType: 'ml.g5.8xlarge', InstanceStatus: { Status: 'Running' }, LaunchTime: new Date(Date.now() - index * 1000) }));
  nodes = ids.map(id => ({ metadata: { name: `hyperpod-${id}`, uid: `uid-${id}`, resourceVersion: '1' }, spec: {},
    status: { conditions: [{ type: 'Ready', status: 'True' }] } }));
  remove = vi.fn(async (_name: string, selected: string[]) => ({ Successful: selected, Failed: [] }));
  increase = vi.fn(async () => undefined);
  restore = vi.fn(async (target, operationId) => {
    const node = nodes.find(n => n.metadata.uid === target.uid);
    if (node && node.metadata.annotations && node.metadata.annotations[SCALE_ANNOTATION] === operationId) { node.spec!.unschedulable = false; delete node.metadata.annotations[SCALE_ANNOTATION]; }
  });
  d = { repo, backendId: 'default', clusterName: cluster, now: () => new Date(), describe: async () => structuredClone(description),
    instances: async () => structuredClone(instances), nodes: async () => structuredClone(nodes), pods: async () => structuredClone(pods),
    activity: async () => ({ items: structuredClone(rows), complete, observedAt: new Date().toISOString() }),
    canCordon: async () => true,
    cordon: async (target, operationId) => {
      const node = nodes.find(n => n.metadata.uid === target.uid)!;
      if (node.metadata.resourceVersion !== target.resourceVersion) throw new Error('conflict');
      node.spec!.unschedulable = true; node.metadata.annotations = { [SCALE_ANNOTATION]: operationId }; node.metadata.resourceVersion = '2';
    }, restore, remove, increase };
});
afterEach(() => vi.useRealTimers());
async function policy(idleEnabled = false) {
  return saveScalingPolicy(cluster, { group, expectedVersion: 0, minCount: 1, baselineCount: 1, idleEnabled, idleMinutes: 1, observedSpecHash: clusterSpecHash(description) }, actor, d);
}
async function plan(count = 1, mode: 'manual' | 'idle' = 'manual') {
  return planScale(cluster, { group, count, expectedCount: 3, observedSpecHash: clusterSpecHash(description), mode }, actor, d);
}
async function prepared(): Promise<ScalePlan> {
  await policy(); const result = await plan();
  if (!('plan' in result) || !result.plan) throw new Error(JSON.stringify(result.blockers));
  return result.plan;
}
describe('reviewed HyperPod capacity operations', () => {
  it('requires explicit baseline policy, refuses below-floor requests, and plans without capacity or node mutations', async () => {
    expect((await plan()).status).toBe('BLOCKED');
    await policy(); expect((await plan(0)).status).toBe('BLOCKED');
    expect((await plan()).status).toBe('PLANNED');
    expect(remove).not.toHaveBeenCalled(); expect(nodes.every(n => !n.spec!.unschedulable)).toBe(true);
  });
  it('preserves the configured GPU baseline until an admin explicitly replaces it with a reviewed zero policy', async () => {
    await policy(); expect((await scaleSnapshot(cluster, group, d)).floor).toBe(1);
    expect((await plan(0)).status).toBe('BLOCKED');
    const saved = await saveScalingPolicy(cluster, { group, expectedVersion: 1, minCount: 0, baselineCount: 0, idleEnabled: false, idleMinutes: 1, observedSpecHash: clusterSpecHash(description) }, actor, d);
    expect(saved.protectedInstanceIds).toEqual([]);
    expect(saved.idleEnabled).toBe(false);
    expect((await scaleSnapshot(cluster, group, d)).floor).toBe(0);
    const reviewed = await plan(0);
    expect(reviewed.status).toBe('PLANNED');
    if (reviewed.status !== 'PLANNED') throw new Error('Expected reviewed zero plan');
    expect(reviewed.plan.targets.map(node => node.instanceId)).toEqual(ids);
    expect(remove).not.toHaveBeenCalled();
    expect((await executeScalePlan(cluster, reviewed.plan.id, actor, d)).status).toBe('ACCEPTED');
    expect(remove.mock.calls[0][1]).toEqual(ids);
    expect((await reconcileScale(cluster, reviewed.plan.id, d)).status).toBe('ACCEPTED');
    instances = []; nodes = [];
    description.InstanceGroups![0].CurrentCount = 0; description.InstanceGroups![0].TargetCount = 0;
    expect((await reconcileScale(cluster, reviewed.plan.id, d)).status).toBe('SUCCEEDED');
    const restart = await planScale(cluster, { group, count: 1, expectedCount: 0, observedSpecHash: clusterSpecHash(description), mode: 'manual' }, actor, d);
    expect(restart.status).toBe('PLANNED');
    if (restart.status !== 'PLANNED') throw new Error('Expected restart plan');
    await executeScalePlan(cluster, restart.plan.id, actor, d);
    expect(increase).toHaveBeenCalledWith(cluster, group, 1, 0, clusterSpecHash(description));
  });
  it('still blocks a zero-node plan if activity arrives or its reviewed policy changes', async () => {
    await saveScalingPolicy(cluster, { group, expectedVersion: 0, minCount: 0, baselineCount: 0, idleEnabled: false, idleMinutes: 1, observedSpecHash: clusterSpecHash(description) }, actor, d);
    const reviewed = await plan(0);
    if (reviewed.status !== 'PLANNED') throw new Error('Expected reviewed zero plan');
    rows.push({ pk: 'SESS#late', sk: 'META', status: 'READY', backendId: 'default' });
    expect((await executeScalePlan(cluster, reviewed.plan.id, actor, d)).status).toBe('BLOCKED');
    rows = [];
    const another = await plan(0);
    if (another.status !== 'PLANNED') throw new Error('Expected reviewed zero plan');
    await saveScalingPolicy(cluster, { group, expectedVersion: 1, minCount: 1, baselineCount: 1, idleEnabled: false, idleMinutes: 1, observedSpecHash: clusterSpecHash(description) }, actor, d);
    expect((await executeScalePlan(cluster, another.plan.id, actor, d)).status).toBe('BLOCKED');
    expect(remove).not.toHaveBeenCalled();
  });
  it('blocks reductions when an externally replaced or removed protected baseline cannot be identified', async () => {
    await policy(); instances = instances.slice(0, 2); nodes = nodes.slice(0, 2);
    description.InstanceGroups![0].CurrentCount = 2; description.InstanceGroups![0].TargetCount = 2;
    expect((await scaleSnapshot(cluster, group, d)).blockers.some(b => b.code === 'baseline_identity_changed')).toBe(true);
  });
  it.each([
    { pk: 'WF#w', sk: 'META', id: 'w', status: 'PENDING', backendId: 'default' },
    { pk: 'SESS#s', sk: 'META', id: 's', status: 'CLOSING', expiresAt: '2020-01-01', backendId: 'default' },
    { pk: 'WF#w', sk: 'TASK#train', phase: 'FINALIZING', workflowId: 'w' },
    { pk: 'DS#d', sk: 'FINALIZE#1' },
  ])('blocks active/uncertain activity %s even with no running user Pod', async record => {
    await policy(); rows.push(record);
    const result = await plan();
    expect(result.status).toBe('BLOCKED'); expect(result.blockers.length).toBeGreaterThan(0); expect(remove).not.toHaveBeenCalled();
  });
  it('blocks incomplete inventory, missing node UID and non-daemonset work in a system namespace', async () => {
    await policy(); complete = false; expect((await plan()).status).toBe('BLOCKED');
    complete = true; delete nodes[0].metadata.uid; expect((await plan()).status).toBe('BLOCKED');
    nodes[0].metadata.uid = `uid-${ids[0]}`;
    pods.push({ metadata: { name: 'important', namespace: 'kube-system' }, spec: { nodeName: nodes[0].metadata.name, containers: [] }, status: { phase: 'Running' } });
    expect((await plan()).status).toBe('BLOCKED');
  });
  it('rejects a stale/reused node name whose provider identity belongs to another instance', async () => {
    await policy(); nodes[0].spec!.providerID = 'aws:///us-east-1a/i-fffffffffffffffff';
    expect((await plan()).status).toBe('BLOCKED');
    expect(remove).not.toHaveBeenCalled();
  });
  it('maps HyperPod providers using the described cluster ID rather than its display name', async () => {
    nodes.forEach((node, index) => { node.spec!.providerID = `aws:///use1-az4/sagemaker/cluster/hyperpod-abcdefghijkl-${ids[index]}`; });
    const snapshot = await scaleSnapshot(cluster, group, d);
    expect(snapshot.blockers.some(b => b.code === 'node_mapping_unknown')).toBe(false);
    expect(snapshot.targets.map(t => t.instanceId)).toEqual(ids);
    expect(remove).not.toHaveBeenCalled(); expect(increase).not.toHaveBeenCalled();
    expect(nodes.every(n => !n.spec!.unschedulable)).toBe(true);
  });
  it('rejects a matching HyperPod instance from a different described cluster', async () => {
    nodes[0].spec!.providerID = `aws:///use1-az4/sagemaker/cluster/hyperpod-tqci9uwuwqiz-${ids[0]}`;
    const snapshot = await scaleSnapshot(cluster, group, d);
    expect(snapshot.blockers).toContainEqual(expect.objectContaining({ code: 'node_mapping_unknown', resources: [ids[0]] }));
    expect(snapshot.targets.some(t => t.instanceId === ids[0])).toBe(false);
    expect(remove).not.toHaveBeenCalled(); expect(increase).not.toHaveBeenCalled();
  });
  it('does not claim privileged execution-profile hosts are idle based only on ordinary Pod visibility', async () => {
    await policy(); nodes[0].metadata.labels = { 'pai.aws.node-restriction.kubernetes.io/execution-profile': 'trusted-host' };
    const result = await plan();
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers.some(b => b.code === 'host_execution_unobserved')).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
  it('detects full configuration changes even when target group count is unchanged', async () => {
    const p = await prepared();
    description.InstanceGroups![1].TargetCount = 2; description.InstanceGroups![1].CurrentCount = 2;
    expect((await executeScalePlan(cluster, p.id, actor, d)).status).toBe('BLOCKED');
    expect(remove).not.toHaveBeenCalled(); expect(increase).not.toHaveBeenCalled();
  });
  it('rechecks activity after cordoning and restores only its own nodes without deleting active work', async () => {
    const p = await prepared(), original = d.cordon;
    d.cordon = async (node, op) => { await original(node, op); rows = [{ pk: 'SESS#late', sk: 'META', id: 'late', status: 'READY', backendId: 'default' }]; };
    expect((await executeScalePlan(cluster, p.id, actor, d)).status).toBe('BLOCKED');
    expect(remove).not.toHaveBeenCalled(); expect(nodes.every(n => !n.spec!.unschedulable)).toBe(true);
  });
  it('sends only verified selected instance IDs, keeps baseline capacity untouched, and never repeats an accepted request', async () => {
    const p = await prepared();
    expect((await scaleSnapshot(cluster, group, d)).policy?.protectedInstanceIds).toEqual([ids[2]]);
    const first = await executeScalePlan(cluster, p.id, actor, d);
    expect(first.status).toBe('ACCEPTED');
    expect(remove.mock.calls[0][1]).toEqual(ids.slice(0, 2));
    expect(nodes[2].spec!.unschedulable).toBeUndefined();
    expect((await executeScalePlan(cluster, p.id, actor, d)).status).toBe('ACCEPTED');
    expect(remove).toHaveBeenCalledTimes(1);
    expect((await reconcileScale(cluster, p.id, d)).status).toBe('ACCEPTED'); // API reply is not observed completion
    instances = instances.slice(2); nodes = nodes.slice(2);
    description.InstanceGroups![0].CurrentCount = 1; description.InstanceGroups![0].TargetCount = 1;
    expect((await reconcileScale(cluster, p.id, d)).status).toBe('SUCCEEDED');
  });
  it('treats partial HTTP 200 as partial and restores only explicitly failed node cordons', async () => {
    const p = await prepared();
    remove.mockResolvedValue({ Successful: [ids[0]], Failed: [{ NodeId: ids[1], Code: 'ResourceInUse', Message: 'not deleted' }] });
    expect((await executeScalePlan(cluster, p.id, actor, d)).status).toBe('ACCEPTED');
    instances = instances.slice(1); nodes = nodes.slice(1);
    description.InstanceGroups![0].CurrentCount = 2; description.InstanceGroups![0].TargetCount = 2;
    expect((await reconcileScale(cluster, p.id, d)).status).toBe('PARTIAL');
    expect(nodes[0].spec!.unschedulable).toBe(false); expect(remove).toHaveBeenCalledTimes(1);
  });
  it('keeps ambiguous responses unknown without retry and handles definite authorization rejection without leaving owned cordons', async () => {
    const p = await prepared();
    remove.mockRejectedValue(new Error('transport timeout'));
    expect((await executeScalePlan(cluster, p.id, actor, d)).status).toBe('UNKNOWN');
    expect((await reconcileScale(cluster, p.id, d)).status).toBe('UNKNOWN');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(nodes.filter(n => n.spec!.unschedulable)).toHaveLength(2);
  });
  it('restores its own cordons on an authoritative AWS authorization failure', async () => {
    const p = await prepared();
    remove.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    expect((await executeScalePlan(cluster, p.id, actor, d)).status).toBe('FAILED');
    expect(nodes.every(n => !n.spec!.unschedulable)).toBe(true);
  });
  it('serializes administrators and atomically prevents changing a baseline during an operation', async () => {
    const p = await prepared();
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const original = d.cordon;
    d.cordon = async (node, op) => { entered(); await waiting; await original(node, op); };
    const executing = executeScalePlan(cluster, p.id, actor, d);
    await began;
    await expect(executeScalePlan(cluster, p.id, actor, d)).rejects.toThrow(/다른 관리자/);
    await expect(saveScalingPolicy(cluster, { group, expectedVersion: 1, minCount: 2, baselineCount: 2, idleEnabled: true, idleMinutes: 1, observedSpecHash: clusterSpecHash(description) }, actor, d)).rejects.toThrow();
    release(); await executing; expect(remove).toHaveBeenCalledTimes(1);
  });
  it('requires opt-in idle observations, resets after activity and never uses a zero idle timestamp as evidence', async () => {
    await policy(true);
    pods = [{ metadata: { name: 'user', namespace: 'team' }, spec: { nodeName: nodes[0].metadata.name, containers: [] }, status: { phase: 'Running' } }];
    await scaleSnapshot(cluster, group, d);
    pods = [];
    expect((await plan(1, 'idle')).status).toBe('BLOCKED');
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect((await plan(1, 'idle')).status).toBe('PLANNED');
    rows.push({ pk: 'WF#completed-late', sk: 'META', id: 'completed-late', backendId: 'default', status: 'SUCCEEDED', updatedAt: new Date().toISOString() });
    expect((await plan(1, 'idle')).status).toBe('BLOCKED');
  });
});

describe('idle worker execution', () => {
  const tick = () => idleScalingTick(undefined, { repo, run: async (_binding, _mode, action) => action(), scaling: () => d });
  it('does not execute or register a policy by default or while opted out', async () => {
    expect(await tick()).toEqual([]);
    await policy(false); vi.setSystemTime(new Date(Date.now() + 3600_000)); expect(await tick()).toEqual([]);
    expect(remove).not.toHaveBeenCalled(); expect(increase).not.toHaveBeenCalled();
  });
  it('keeps automatic scaling off for a zero policy until separately opted in, then uses all existing idle safeguards', async () => {
    await saveScalingPolicy(cluster, { group, expectedVersion: 0, minCount: 0, baselineCount: 0, idleEnabled: false, idleMinutes: 1, observedSpecHash: clusterSpecHash(description) }, actor, d);
    await tick(); vi.setSystemTime(new Date(Date.now() + 61_000)); await tick();
    expect(remove).not.toHaveBeenCalled();
    await saveScalingPolicy(cluster, { group, expectedVersion: 1, minCount: 0, baselineCount: 0, idleEnabled: true, idleMinutes: 1, observedSpecHash: clusterSpecHash(description) }, actor, d);
    await tick(); expect(remove).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect((await tick()).some(result => result.status === 'ACCEPTED')).toBe(true);
    expect(remove.mock.calls[0][1]).toEqual(ids);
  });
  it('executes an explicitly enabled idle policy to its protected baseline and reconciles without a second capacity request', async () => {
    await policy(true);
    expect((await tick()).some(r => r.status === 'ACCEPTED')).toBe(false);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect((await tick()).some(r => r.status === 'ACCEPTED')).toBe(true);
    expect(remove.mock.calls[0][1]).toEqual(ids.slice(0, 2));
    await tick(); expect(remove).toHaveBeenCalledTimes(1);
    instances = instances.slice(2); nodes = nodes.slice(2); description.InstanceGroups![0].CurrentCount = 1; description.InstanceGroups![0].TargetCount = 1;
    expect((await tick()).some(r => r.status === 'SUCCEEDED')).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('leaves capacity unchanged with uncertain activity or a changed backend configuration binding', async () => {
    await policy(true); await tick(); vi.setSystemTime(new Date(Date.now() + 61_000)); complete = false;
    await tick(); expect(remove).not.toHaveBeenCalled();
    complete = true; d.backendConfigHash = 'changed';
    await tick(); expect(remove).not.toHaveBeenCalled();
  });
  it('does not disguise an authoritative failure as a new automatic attempt on the next worker tick', async () => {
    await policy(true); await tick(); vi.setSystemTime(new Date(Date.now() + 61_000));
    remove.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    expect((await tick()).some(r => r.status === 'FAILED')).toBe(true);
    await tick(); await tick();
    expect(remove).toHaveBeenCalledTimes(1);
    expect((await scaleSnapshot(cluster, group, d)).idleReviewRequired).toBe(true);
  });
});
