import { describe, it, expect, vi } from 'vitest';
import { describeInstanceTypes, instanceType } from './instance-catalog';
import { DescribeInstanceTypesCommand, EC2Client } from '@aws-sdk/client-ec2';

// Mock the EC2Client and config
vi.mock('./clients', () => ({
  ec2: vi.fn(() => mockEc2Client),
}));

vi.mock('../config', () => ({
  config: () => ({ region: 'us-east-1' }),
}));

let mockEc2Client: any;

describe('instanceType', () => {
  it('strips ml. prefix', () => {
    expect(instanceType('ml.g4dn.xlarge')).toBe('g4dn.xlarge');
    expect(instanceType('ml.p3.2xlarge')).toBe('p3.2xlarge');
  });

  it('validates format', () => {
    expect(instanceType('g4dn.xlarge')).toBe('g4dn.xlarge');
    expect(instanceType('invalid..name')).toBeUndefined();
    expect(instanceType('')).toBeUndefined();
    expect(instanceType(undefined)).toBeUndefined();
  });
});

describe('describeInstanceTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEc2Client = {
      send: vi.fn(),
    };
  });

  it('returns empty map when given empty names', async () => {
    const result = await describeInstanceTypes([]);
    expect(result.size).toBe(0);
  });

  it('maps GPU instance types correctly', async () => {
    mockEc2Client.send.mockResolvedValueOnce({
      InstanceTypes: [
        {
          InstanceType: 'g4dn.xlarge',
          VCpuInfo: { DefaultVCpus: 4 },
          MemoryInfo: { SizeInMiB: 16384 },
          GpuInfo: {
            Gpus: [
              {
                Name: 'T4',
                Count: 1,
                MemoryInfo: { SizeInMiB: 16384 },
              },
            ],
          },
        },
      ],
      NextToken: undefined,
    });

    const result = await describeInstanceTypes(['ml.g4dn.xlarge']);
    expect(result.size).toBe(1);
    const entry = result.get('g4dn.xlarge');
    expect(entry).toEqual({
      vCpu: 4,
      memoryMiB: 16384,
      gpuCount: 1,
      gpuName: 'T4',
      gpuMemoryMiB: 16384,
    });
  });

  it('maps CPU-only instance types with gpuCount=0', async () => {
    mockEc2Client.send.mockResolvedValueOnce({
      InstanceTypes: [
        {
          InstanceType: 'c5.4xlarge',
          VCpuInfo: { DefaultVCpus: 16 },
          MemoryInfo: { SizeInMiB: 32768 },
          GpuInfo: undefined,
        },
      ],
      NextToken: undefined,
    });

    const result = await describeInstanceTypes(['c5.4xlarge']);
    const entry = result.get('c5.4xlarge');
    expect(entry?.gpuCount).toBe(0);
    expect(entry?.gpuName).toBeUndefined();
  });

  it('returns empty map on fetch failure', async () => {
    mockEc2Client.send.mockRejectedValueOnce(new Error('API error'));

    // Use a different instance type than previous tests to avoid cache hits
    const result = await describeInstanceTypes(['ml.p3.2xlarge']);
    expect(result.size).toBe(0);
  });

  it('filters out invalid instance type names', async () => {
    mockEc2Client.send.mockResolvedValueOnce({
      InstanceTypes: [],
      NextToken: undefined,
    });

    const result = await describeInstanceTypes(['invalid..name', 'also-bad']);
    expect(result.size).toBe(0);
    expect(mockEc2Client.send).not.toHaveBeenCalled();
  });
});
