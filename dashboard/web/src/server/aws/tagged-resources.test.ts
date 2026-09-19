import { beforeEach, describe, expect, it, vi } from 'vitest';
const sends = vi.hoisted(() => ({ tagging: vi.fn(), ec2: vi.fn() }));
vi.mock('./clients', () => ({ tagging: () => ({ send: sends.tagging }), ec2: () => ({ send: sends.ec2 }) }));
vi.mock('../config', () => ({ config: () => ({ region: 'us-east-1', accountId: '123456789012', resourceTag: { key: 'PhysicalAI', value: 'true' } }) }));
import { listTaggedResources, parseArn, resetTaggedResourcesCache } from './tagged-resources';

beforeEach(() => { sends.tagging.mockReset(); sends.ec2.mockReset(); resetTaggedResourcesCache(); });
const A = (s: string) => `arn:aws:${s}`;

describe('parseArn', () => {
  it('classifies the services the dashboard uses and falls back to Other', () => {
    expect(parseArn(A('ec2:us-east-1:123456789012:instance/i-0abc'))).toEqual({ service: 'EC2', type: 'instance', name: 'i-0abc', region: 'us-east-1' });
    expect(parseArn(A('fsx:us-east-1:123456789012:file-system/fs-01'))).toMatchObject({ service: 'FSx', name: 'fs-01' });
    expect(parseArn(A('eks:us-east-1:123456789012:cluster/hp'))).toMatchObject({ service: 'EKS', name: 'hp' });
    expect(parseArn(A('sagemaker:us-east-1:123456789012:cluster/abc123'))).toMatchObject({ service: 'SageMaker', type: 'hyperpod-cluster' });
    expect(parseArn(A('s3:::my-bucket'))).toEqual({ service: 'S3', type: 'bucket', name: 'my-bucket', region: 'us-east-1' });
    expect(parseArn(A('elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/pai/50dc6c'))).toMatchObject({ service: 'ELB', name: 'pai' });
    expect(parseArn(A('kinesis:us-east-1:123456789012:stream/x'))).toMatchObject({ service: 'Other', type: 'kinesis', name: 'x' });
  });
});
describe('listTaggedResources', () => {
  it('paginates GetResources, groups by service, enriches EC2 instances and caches for 60 s', async () => {
    sends.tagging
      .mockResolvedValueOnce({ PaginationToken: 'p2', ResourceTagMappingList: [{ ResourceARN: A('ec2:us-east-1:123456789012:instance/i-1') }, { ResourceARN: A('s3:::b1') }] })
      .mockResolvedValueOnce({ PaginationToken: '', ResourceTagMappingList: [{ ResourceARN: A('fsx:us-east-1:123456789012:file-system/fs-1') }] });
    sends.ec2.mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' }, InstanceType: 'g5.4xlarge', PrivateIpAddress: '10.0.1.5', Placement: { AvailabilityZone: 'us-east-1a' }, LaunchTime: new Date('2026-09-01T00:00:00Z'), Tags: [{ Key: 'Name', Value: 'isaac-ws' }] }] }] });
    let now = 1_000;
    const first = await listTaggedResources(() => now);
    expect(sends.tagging).toHaveBeenCalledTimes(2);
    expect(sends.tagging.mock.calls[0][0].input).toMatchObject({ TagFilters: [{ Key: 'PhysicalAI', Values: ['true'] }], ResourcesPerPage: 100 });
    expect(sends.tagging.mock.calls[1][0].input.PaginationToken).toBe('p2');
    expect(first.groups.map(g => g.service)).toEqual(['EC2', 'FSx', 'S3']);
    const ec2 = first.groups[0].items[0];
    expect(ec2).toMatchObject({ name: 'isaac-ws', details: { instanceId: 'i-1', state: 'running', instanceType: 'g5.4xlarge', privateIp: '10.0.1.5', az: 'us-east-1a' } });
    expect(ec2.consoleUrl).toContain('InstanceDetails:instanceId=i-1');
    expect(sends.ec2.mock.calls[0][0].input.InstanceIds).toEqual(['i-1']);
    now += 59_000; await listTaggedResources(() => now);
    expect(sends.tagging).toHaveBeenCalledTimes(2);
    now += 2_000; sends.tagging.mockResolvedValueOnce({ ResourceTagMappingList: [] }); await listTaggedResources(() => now);
    expect(sends.tagging).toHaveBeenCalledTimes(3);
  });
  it('keeps the listing when EC2 enrichment fails and reports the error on the EC2 group', async () => {
    sends.tagging.mockResolvedValueOnce({ ResourceTagMappingList: [{ ResourceARN: A('ec2:us-east-1:123456789012:instance/i-1') }] });
    sends.ec2.mockRejectedValueOnce(new Error('AccessDenied'));
    const r = await listTaggedResources(() => 0);
    expect(r.groups[0]).toMatchObject({ service: 'EC2', error: 'AccessDenied' });
    expect(r.groups[0].items[0]).toMatchObject({ name: 'i-1', details: { instanceId: 'i-1' } });
  });
  it('rejects a pagination loop', async () => {
    sends.tagging.mockResolvedValue({ PaginationToken: 'same', ResourceTagMappingList: [] });
    await expect(listTaggedResources(() => 0)).rejects.toThrow(/pagination/);
  });
});
