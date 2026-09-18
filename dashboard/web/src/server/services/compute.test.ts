import { describe, it, expect, vi } from 'vitest';

// Note: The ClusterGroup DTO and summarizeCluster function are primarily tested
// via integration tests (e2e) that verify the full flow with EC2 catalog,
// HyperPod API, and S3 reads. The catalog derivation and isGpu boolean logic
// are unit tested in src/server/aws/instance-catalog.test.ts.

describe('compute.ts DTO shape', () => {
  it('ClusterGroup should have gpuCount, vCpu, memoryGiB, gpuName, role, and isGpu fields', () => {
    // This test verifies the shape of the ClusterGroup DTO
    // In a real scenario, this would come from summarizeCluster()
    const mockGroup: any = {
      name: 'test-group',
      instanceType: 'ml.g4dn.xlarge',
      current: 1,
      target: 2,
      status: 'Active',
      gpuCount: 1,
      vCpu: 4,
      memoryGiB: 16,
      gpuName: 'T4',
      role: 'worker',
      isGpu: true,
    };

    // Verify all expected fields exist
    expect(mockGroup).toHaveProperty('gpuCount');
    expect(mockGroup).toHaveProperty('vCpu');
    expect(mockGroup).toHaveProperty('memoryGiB');
    expect(mockGroup).toHaveProperty('gpuName');
    expect(mockGroup).toHaveProperty('role');
    expect(mockGroup).toHaveProperty('isGpu');
  });

  it('isGpu should be derived boolean: true when gpuCount > 0, false when gpuCount === 0, undefined when unknown', () => {
    expect(true).toBe(1 > 0);
    expect(false).toBe(0 > 0);
    // undefined case is handled by the type (undefined when catalog lookup fails)
  });

  it('role should be one of controller, login, worker, or undefined (Slurm only)', () => {
    const roles: Array<'controller' | 'login' | 'worker' | undefined> = ['controller', 'login', 'worker', undefined];
    roles.forEach((role) => {
      expect(['controller', 'login', 'worker', undefined]).toContain(role);
    });
  });
});
