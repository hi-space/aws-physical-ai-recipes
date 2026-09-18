import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DescribeClusterResponse } from '@aws-sdk/client-sagemaker';

vi.mock('../aws/hyperpod', () => ({ describeNode: vi.fn(), rebootNodes: vi.fn(), replaceNodes: vi.fn() }));
vi.mock('../k8s/node-ops', () => ({ findNodeByInstanceId: vi.fn(), listPodsOnNode: vi.fn() }));
vi.mock('../k8s/client', () => ({ SYSTEM_NAMESPACES: new Set(['kube-system', 'hyperpod-observability']) }));
import * as hp from '../aws/hyperpod';
import { findNodeByInstanceId, listPodsOnNode } from '../k8s/node-ops';
import { executeNodeRecovery, planNodeRecovery } from './node-recovery';

const eksCluster = { ClusterName: 'hp-eks', ClusterStatus: 'InService', NodeRecovery: 'Automatic', Orchestrator: { Eks: { ClusterArn: 'arn:eks' } } } as unknown as DescribeClusterResponse;
const slurmCluster = { ClusterName: 'hp-slurm', ClusterStatus: 'InService', NodeRecovery: 'Automatic', Orchestrator: { Slurm: {} } } as unknown as DescribeClusterResponse;
const id = 'i-00f3cbe8dfee6b675';
const k8sNode = { metadata: { name: 'hyperpod-' + id, uid: 'u1', labels: { 'sagemaker.amazonaws.com/node-health-status': 'Schedulable' } }, spec: { providerID: `aws:///use1-az4/sagemaker/cluster/hp-${id}` }, status: { conditions: [{ type: 'Ready', status: 'True' }], capacity: { 'nvidia.com/gpu': '1' } } };
const pod = (namespace: string, name: string, phase: string, owner: string, uid: string, wf?: string) => ({ metadata: { namespace, name, uid, ownerReferences: [{ kind: owner, name: 'x' }], labels: wf ? { 'pai.aws/workflow-id': wf } : {} }, spec: {}, status: { phase } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hp.describeNode).mockResolvedValue({ NodeDetails: { InstanceId: id, InstanceGroupName: 'gpu-g5-8x', InstanceType: 'ml.g5.8xlarge', InstanceStatus: { Status: 'Running' }, LaunchTime: new Date('2026-09-10T00:00:00Z') } } as never);
  vi.mocked(findNodeByInstanceId).mockResolvedValue(k8sNode as never);
  vi.mocked(listPodsOnNode).mockResolvedValue([pod('kube-system', 'aws-node-1', 'Running', 'DaemonSet', 'p1')] as never);
  vi.mocked(hp.rebootNodes).mockResolvedValue({ Successful: [id], Failed: [] } as never);
  vi.mocked(hp.replaceNodes).mockResolvedValue({ Successful: [id], Failed: [] } as never);
});

describe('planNodeRecovery', () => {
  it('copies DescribeClusterNode facts and the Kubernetes view; DaemonSet/system pods do not warn', async () => {
    const plan = await planNodeRecovery(eksCluster, id, 'reboot');
    expect(plan.api).toBe('BatchRebootClusterNodes');
    expect(plan.node).toMatchObject({ instanceId: id, group: 'gpu-g5-8x', instanceType: 'ml.g5.8xlarge', instanceStatus: 'Running', launchTime: '2026-09-10T00:00:00.000Z', k8sName: 'hyperpod-' + id, health: 'Schedulable', ready: true, gpuCapacity: 1 });
    expect(plan.cluster).toEqual({ name: 'hp-eks', orchestrator: 'eks', status: 'InService', nodeRecovery: 'Automatic' });
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.pods).toHaveLength(1);
  });
  it('warns about running non-DaemonSet pods outside system namespaces and names their workflow', async () => {
    vi.mocked(listPodsOnNode).mockResolvedValue([pod('rl', 'wf-1-train-abc', 'Running', 'Job', 'p2', 'wf-1'), pod('rl', 'wf-0-done', 'Succeeded', 'Job', 'p3', 'wf-0')] as never);
    const plan = await planNodeRecovery(eksCluster, id, 'replace');
    expect(plan.warnings).toEqual([{ code: 'running_pods', message: expect.stringContaining('rl/wf-1-train-abc (wf-1)'), params: { count: '1', pods: 'rl/wf-1-train-abc (wf-1)' } }]);
    expect(plan.pods.find((p) => p.name === 'wf-1-train-abc')?.workflowId).toBe('wf-1');
  });
  it('blocks when the instance is not Running or the cluster is not InService, and when DescribeClusterNode fails', async () => {
    vi.mocked(hp.describeNode).mockResolvedValue({ NodeDetails: { InstanceStatus: { Status: 'SystemUpdating' } } } as never);
    let plan = await planNodeRecovery({ ...eksCluster, ClusterStatus: 'Updating' } as never, id, 'reboot');
    expect(plan.blockers.map((b) => b.code)).toEqual(['instance_not_running', 'cluster_not_in_service']);
    expect(plan.blockers[0].params).toEqual({ status: 'SystemUpdating' });
    vi.mocked(hp.describeNode).mockRejectedValue(new Error('ResourceNotFound'));
    plan = await planNodeRecovery(eksCluster, id, 'reboot');
    expect(plan.blockers.map((b) => b.code)).toEqual(['not_in_cluster']);
  });
  it('for Slurm clusters skips Kubernetes entirely; for EKS warns when the node has not joined', async () => {
    const slurm = await planNodeRecovery(slurmCluster, id, 'reboot');
    expect(findNodeByInstanceId).not.toHaveBeenCalled();
    expect(slurm.cluster.orchestrator).toBe('slurm');
    expect(slurm.node.k8sName).toBeUndefined();
    vi.mocked(findNodeByInstanceId).mockResolvedValue(undefined);
    const eks = await planNodeRecovery(eksCluster, id, 'reboot');
    expect(eks.warnings.map((w) => w.code)).toEqual(['k8s_node_missing']);
  });
  it('token changes with instance status, health label and pod set', async () => {
    const a = (await planNodeRecovery(eksCluster, id, 'reboot')).token;
    vi.mocked(listPodsOnNode).mockResolvedValue([pod('kube-system', 'aws-node-1', 'Running', 'DaemonSet', 'p9')] as never);
    const b = (await planNodeRecovery(eksCluster, id, 'reboot')).token;
    expect(a).not.toBe(b);
    expect((await planNodeRecovery(eksCluster, id, 'replace')).token).not.toBe(b);
  });
});

describe('executeNodeRecovery', () => {
  it('calls the matching SageMaker API once the token matches and returns its Successful/Failed lists', async () => {
    const token = (await planNodeRecovery(eksCluster, id, 'replace')).token;
    const out = await executeNodeRecovery(eksCluster, id, 'replace', token, false);
    expect(hp.replaceNodes).toHaveBeenCalledWith('hp-eks', [id]);
    expect(hp.rebootNodes).not.toHaveBeenCalled();
    expect(out).toMatchObject({ api: 'BatchReplaceClusterNodes', successful: [id], failed: [] });
  });
  it('409 node_state_changed on a stale token; 409 blocker code when blocked; 400 ack_required for running pods', async () => {
    await expect(executeNodeRecovery(eksCluster, id, 'reboot', 'stale', false)).rejects.toMatchObject({ status: 409, code: 'node_state_changed' });
    vi.mocked(listPodsOnNode).mockResolvedValue([pod('rl', 'wf-1-train', 'Running', 'Job', 'p2', 'wf-1')] as never);
    const token = (await planNodeRecovery(eksCluster, id, 'reboot')).token;
    await expect(executeNodeRecovery(eksCluster, id, 'reboot', token, false)).rejects.toMatchObject({ status: 400, code: 'ack_required' });
    await executeNodeRecovery(eksCluster, id, 'reboot', token, true);
    expect(hp.rebootNodes).toHaveBeenCalledWith('hp-eks', [id]);
    vi.mocked(hp.describeNode).mockResolvedValue({ NodeDetails: { InstanceStatus: { Status: 'Pending' } } } as never);
    const blocked = (await planNodeRecovery(eksCluster, id, 'reboot')).token;
    await expect(executeNodeRecovery(eksCluster, id, 'reboot', blocked, true)).rejects.toMatchObject({ status: 409, code: 'instance_not_running' });
  });
  it('surfaces per-node API failures instead of hiding them', async () => {
    vi.mocked(hp.rebootNodes).mockResolvedValue({ Successful: [], Failed: [{ NodeId: id, ErrorCode: 'InvalidNodeStatus', Message: 'node is updating' }] } as never);
    const token = (await planNodeRecovery(eksCluster, id, 'reboot')).token;
    expect((await executeNodeRecovery(eksCluster, id, 'reboot', token, false)).failed).toEqual([{ nodeId: id, code: 'InvalidNodeStatus', message: 'node is updating' }]);
  });
});
