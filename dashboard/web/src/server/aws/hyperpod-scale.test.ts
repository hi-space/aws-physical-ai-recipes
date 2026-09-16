import { beforeEach, expect, it, vi } from 'vitest';
import { buildScaleSpec, clusterSpecHash, deleteIdleNodes, scaleGroup } from './hyperpod';
import type { DescribeClusterResponse } from '@aws-sdk/client-sagemaker';
const mocks = vi.hoisted(() => ({ describe: vi.fn(), send: vi.fn(), options: vi.fn() }));
vi.mock('./clients', () => ({ sagemaker: () => ({ send: mocks.describe }) }));
vi.mock('@aws-sdk/client-sagemaker', async original => ({
  ...await original<typeof import('@aws-sdk/client-sagemaker')>(),
  SageMakerClient: class { constructor(options: unknown) { mocks.options(options); } send = mocks.send; },
}));
let observed: DescribeClusterResponse;
beforeEach(() => {
  vi.stubEnv('AUTH_MODE', 'dev');
  observed = { ClusterName: 'cluster', ClusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/abcdefghijkl', ClusterStatus: 'InService', InstanceGroups: [
    { InstanceGroupName: 'cpu', InstanceType: 'ml.c5.4xlarge', CurrentCount: 1, TargetCount: 1, ExecutionRole: 'r', LifeCycleConfig: { OnCreate: 'x', SourceS3Uri: 's3://x' } },
    { InstanceGroupName: 'gpu', InstanceType: 'ml.g5.8xlarge', CurrentCount: 2, TargetCount: 2, ExecutionRole: 'r', LifeCycleConfig: { OnCreate: 'x', SourceS3Uri: 's3://x' } },
  ] };
  mocks.describe.mockReset().mockImplementation(async () => structuredClone(observed)); mocks.send.mockReset().mockResolvedValue({ Successful: ['i-00000000000000001'] }); mocks.options.mockReset();
});
it('checks the full observed spec and sends only the increasing group, with no automatic SDK retries', async () => {
  await scaleGroup('cluster', 'gpu', 3, 2, clusterSpecHash(observed));
  expect(mocks.send.mock.calls[0][0].constructor.name).toBe('UpdateClusterCommand');
  expect(mocks.send.mock.calls[0][0].input.InstanceGroups).toHaveLength(1);
  expect(mocks.send.mock.calls[0][0].input.InstanceGroups[0]).toMatchObject({ InstanceGroupName: 'gpu', InstanceCount: 3 });
  expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 }));
});
it('refuses a stale unrelated group/spec change and never uses random group downscale', async () => {
  const old = clusterSpecHash(observed); observed.InstanceGroups![0].ThreadsPerCore = 1;
  await expect(scaleGroup('cluster', 'gpu', 3, 2, old)).rejects.toThrow(/전체 설정/);
  await expect(scaleGroup('cluster', 'gpu', 1, 2, clusterSpecHash(observed))).rejects.toThrow(/개별 노드/);
  expect(mocks.send).not.toHaveBeenCalled();
});
it('deletes only the reviewed specific identities and rejects duplicate/malformed selections', async () => {
  const id = 'i-00000000000000001';
  await deleteIdleNodes('cluster', [id], clusterSpecHash(observed));
  expect(mocks.send.mock.calls[0][0].constructor.name).toBe('BatchDeleteClusterNodesCommand');
  expect(mocks.send.mock.calls[0][0].input).toEqual({ ClusterName: 'cluster', NodeIds: [id] });
  await expect(deleteIdleNodes('cluster', [id, id], clusterSpecHash(observed))).rejects.toThrow();
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it('refuses unsupported configuration shapes instead of silently dropping them from an update', () => {
  observed.InstanceGroups![1].AutoPatchConfig = {} as never;
  expect(() => buildScaleSpec(observed.InstanceGroups!, 'gpu', 3)).toThrow(/복합/);
});
