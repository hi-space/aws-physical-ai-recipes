import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({ config: vi.fn() }));
vi.mock('../aws/clients', () => ({ eks: vi.fn(), s3: vi.fn(), sagemaker: vi.fn() }));
vi.mock('../aws/hyperpod', () => ({ describeCluster: vi.fn() }));
vi.mock('../aws/fsx', () => ({ describeAll: vi.fn() }));
vi.mock('../aws/ec2-dcv', () => ({ describeWorkstation: vi.fn() }));
vi.mock('../aws/greengrass', () => ({ edgeCloud: vi.fn() }));
vi.mock('../k8s/kueue', () => ({ listClusterQueues: vi.fn() }));

import { config } from '../config';
import { eks, s3, sagemaker } from '../aws/clients';
import { describeCluster } from '../aws/hyperpod';
import { describeAll } from '../aws/fsx';
import { describeWorkstation } from '../aws/ec2-dcv';
import { edgeCloud } from '../aws/greengrass';
import { listClusterQueues } from '../k8s/kueue';
import { architectureMap, resetArchitectureCacheForTests } from './architecture';

const fullConfig = {
  region: 'us-west-2', accountId: '123456789012', tableName: 'tbl', cognitoUserPoolId: 'us-west-2_abc',
  eks: { eksClusterName: 'eks-a', hyperPodClusterName: 'hp-a', dataBucket: 'data-b', fsxFileSystemId: 'fs-1', ampWorkspaceId: 'ws-1', logGroupPrefix: '/aws/sagemaker/Clusters/hp-a' },
  groot: { artifactsBucket: 'art-b', mlflowTrackingServerArn: 'arn:aws:sagemaker:us-west-2:123456789012:mlflow-tracking-server/ml-a', mlflowTrackingServerName: 'ml-a', pipelineName: 'pipe-a', modelPackageGroup: 'grp-a' },
  dcv: { instanceId: 'i-0123456789abcdef0' },
  edge: { thingGroup: 'tg', inferenceComponent: 'com.x.inference' },
};

beforeEach(() => {
  vi.resetAllMocks();
  resetArchitectureCacheForTests();
  vi.mocked(config).mockReturnValue(fullConfig as never);
  vi.mocked(s3).mockReturnValue({ send: vi.fn().mockResolvedValue({}) } as never);
  vi.mocked(eks).mockReturnValue({ send: vi.fn().mockResolvedValue({ cluster: { status: 'ACTIVE', version: '1.31' } }) } as never);
  vi.mocked(sagemaker).mockReturnValue({ send: vi.fn().mockImplementation((cmd: { constructor: { name: string } }) => cmd.constructor.name.startsWith('DescribePipeline') ? { PipelineStatus: 'Active', LastModifiedTime: new Date('2026-09-01T00:00:00Z') } : { TrackingServerStatus: 'Created' }) } as never);
  vi.mocked(describeCluster).mockResolvedValue({ ClusterStatus: 'InService', NodeRecovery: 'Automatic', InstanceGroups: [{}, {}] } as never);
  vi.mocked(describeAll).mockResolvedValue([{ id: 'fs-1', lifecycle: 'AVAILABLE', storageCapacityGiB: 1200, associations: [{}, {}, {}] }] as never);
  vi.mocked(describeWorkstation).mockResolvedValue({ state: 'stopped', instanceType: 'g5.4xlarge' } as never);
  vi.mocked(edgeCloud).mockReturnValue({ target: vi.fn().mockResolvedValue({ members: ['a', 'b'] }) } as never);
  vi.mocked(listClusterQueues).mockResolvedValue([{}, {}] as never);
});

const byId = (r: Awaited<ReturnType<typeof architectureMap>>, id: string) => r.components.find((c) => c.id === id)!;

describe('architectureMap', () => {
  it('copies raw status and facts from each Describe response and names the API', async () => {
    const r = await architectureMap(1_000);
    expect(r.region).toBe('us-west-2');
    const hp = byId(r, 'hyperpod-eks');
    expect(hp).toMatchObject({ evidence: 'describe', api: 'SageMaker DescribeCluster', status: 'InService', tone: 'ok', console: { kind: 'hyperpod-cluster', name: 'hp-a' } });
    expect(hp.facts).toEqual([{ key: 'orchestrator', value: 'EKS' }, { key: 'instanceGroups', value: 2 }, { key: 'nodeRecovery', value: 'Automatic' }]);
    expect(byId(r, 'eks')).toMatchObject({ status: 'ACTIVE', tone: 'ok', facts: [{ key: 'eksVersion', value: '1.31' }] });
    expect(byId(r, 'fsx')).toMatchObject({ status: 'AVAILABLE', tone: 'ok', facts: [{ key: 'capacityGiB', value: 1200 }, { key: 'dataRepositories', value: 3 }] });
    expect(byId(r, 'dcv')).toMatchObject({ status: 'stopped', tone: 'warn' });
    expect(byId(r, 'mlflow')).toMatchObject({ status: 'Created', tone: 'ok', href: '/experiments' });
    expect(byId(r, 'pipeline')).toMatchObject({ status: 'Active', tone: 'ok', facts: [{ key: 'lastModified', value: '2026-09-01T00:00:00.000Z' }] });
    expect(byId(r, 'thing-group')).toMatchObject({ tone: 'ok', facts: [{ key: 'members', value: 2 }] });
    expect(byId(r, 'kueue')).toMatchObject({ tone: 'ok', facts: [{ key: 'clusterQueues', value: 2 }] });
    expect(byId(r, 'data-bucket')).toMatchObject({ evidence: 'describe', api: 'S3 HeadBucket', tone: 'ok' });
    expect(byId(r, 'data-bucket').status).toBeUndefined();
  });

  it('marks resources without a permitted describe call as identifier-only, never ok', async () => {
    const r = await architectureMap(1_000);
    for (const id of ['amp', 'model-registry', 'gg-component', 'cognito', 'table', 'cluster-logs']) {
      expect(byId(r, id)).toMatchObject({ evidence: 'config', tone: 'unknown' });
      expect(byId(r, id).status).toBeUndefined();
    }
  });

  it('turns a failed describe into tone unknown with the error, and unknown status vocabulary into unknown', async () => {
    vi.mocked(describeCluster).mockRejectedValue(new Error('AccessDeniedException: not authorized'));
    vi.mocked(eks).mockReturnValue({ send: vi.fn().mockResolvedValue({ cluster: { status: 'SOMETHING_NEW' } }) } as never);
    const r = await architectureMap(1_000);
    expect(byId(r, 'hyperpod-eks')).toMatchObject({ tone: 'unknown', error: 'AccessDeniedException: not authorized' });
    expect(byId(r, 'hyperpod-eks').status).toBeUndefined();
    expect(byId(r, 'eks')).toMatchObject({ status: 'SOMETHING_NEW', tone: 'unknown' });
  });

  it('omits components whose stack is not deployed and caches for 60 s', async () => {
    vi.mocked(config).mockReturnValue({ region: 'us-east-1', accountId: '1', tableName: 'tbl' } as never);
    const r = await architectureMap(1_000);
    expect(r.components.map((c) => c.id)).toEqual(['table']);
    vi.mocked(config).mockReturnValue(fullConfig as never);
    expect((await architectureMap(50_000)).components).toHaveLength(1);
    expect((await architectureMap(61_001)).components.length).toBeGreaterThan(1);
  });
});
