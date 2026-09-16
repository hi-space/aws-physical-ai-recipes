import { expect, it } from 'vitest';
import { inspectHardware, quantity, type HardwareInspectionDeps } from './hardware-inspection';

it('combines current node allocatable resources with per-GPU EC2 memory without GFD labels', async () => {
  const deps: HardwareInspectionDeps = {
    nodes: async () => [{
      metadata: { name: 'gpu-a', uid: 'uid-a', labels: { 'node.kubernetes.io/instance-type': 'ml.g5.8xlarge', 'kubernetes.io/arch': 'amd64' } },
      spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '31500m', memory: '120Gi', 'nvidia.com/gpu': '1' } },
    }],
    instanceTypes: async (names) => {
      expect(names).toEqual(['g5.8xlarge']);
      return [{ InstanceType: 'g5.8xlarge', VCpuInfo: { DefaultVCpus: 32 }, MemoryInfo: { SizeInMiB: 131072 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] },
        GpuInfo: { Gpus: [{ Name: 'A10G', Count: 1, MemoryInfo: { SizeInMiB: 24576 } }], TotalGpuMemoryInMiB: 24576 } }];
    },
    now: () => new Date('2026-09-16T12:00:00Z'),
  };
  const result = await inspectHardware(deps);
  expect(result.nodes[0]).toMatchObject({ instanceType: 'g5.8xlarge', architecture: 'amd64', ready: true,
    allocatable: { cpu: 31.5, memoryMiB: 122880, gpu: 1 }, catalog: { gpuMemoryMiB: 24576, gpuCount: 1 } });
  expect(result.source).toBe('eks-nodes+ec2-instance-types');
});

it('does not divide total GPU memory into invented per-device memory, or infer installed drivers', async () => {
  const result = await inspectHardware({
    nodes: async () => [{ metadata: { name: 'n', labels: { 'node.kubernetes.io/instance-type': 'g5.12xlarge' } }, status: { allocatable: { 'nvidia.com/gpu': '4' } } }],
    instanceTypes: async () => [{ InstanceType: 'g5.12xlarge', GpuInfo: { Gpus: [{ Count: 4 }], TotalGpuMemoryInMiB: 98304 } }],
    now: () => new Date(),
  });
  expect(result.nodes[0].catalog?.gpuMemoryMiB).toBeUndefined();
  expect(result.nodes[0].architecture).toBeUndefined();
  expect(result.nodes[0].ready).toBe(false);
  expect(JSON.stringify(result)).not.toContain('driverVersion');
});

it('preserves missing catalog data as unknown and excludes no nodes silently', async () => {
  const result = await inspectHardware({
    nodes: async () => [{ metadata: { name: 'n', labels: { 'node.kubernetes.io/instance-type': 'c5.4xlarge' } } }],
    instanceTypes: async () => { throw new Error('fixture denied'); }, now: () => new Date(),
  });
  expect(result.catalogAvailable).toBe(false);
  expect(result.nodes).toHaveLength(1);
  expect(result.nodes[0].catalog).toBeUndefined();
});

it('parses CPU millicores and memory quantities without treating missing data as zero', () => {
  expect(quantity('500m', 'cpu')).toBe(0.5);
  expect(quantity('8Gi', 'memory')).toBe(8192);
  expect(quantity('8000000000', 'memory')).toBeCloseTo(7629.3945, 3);
  expect(quantity(undefined, 'memory')).toBeUndefined();
  expect(quantity('garbage', 'cpu')).toBeUndefined();
});
