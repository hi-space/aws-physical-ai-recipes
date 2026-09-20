import { describe, expect, it } from 'vitest';
import { adoptableQuotas, backendAvailable, registrationBody, type BackendRegistry } from './backend-ui';

const registry: BackendRegistry = { default: { id: 'default', configured: true, clusterName: 'home' }, backends: [
  { id: 'alpha', version: 2, enabled: true, status: 'READY', findings: [], profile: { region: 'us-east-1', accountId: '123456789012', vpcId: 'vpc-a', namespaces: ['hyperpod-ns-team'], eks: { eksClusterName: 'alpha' } } },
  { id: 'beta', version: 0, enabled: true, status: 'UNREADY', findings: [{ code: 'unregistered', message: '등록 필요' }] },
] };

describe('backend project form contracts', () => {
  it('preserves configured default and never invents capability when registry data is missing or unready', () => {
    expect(backendAvailable(registry, 'default')).toBe(true);
    expect(backendAvailable(registry, 'alpha')).toBe(true);
    expect(backendAvailable(registry, 'beta')).toBe(false);
    expect(backendAvailable(undefined, 'default')).toBe(false);
    expect(backendAvailable({ ...registry, default: { id: 'default', configured: false } }, 'default')).toBe(false);
    expect(backendAvailable({ ...registry, backends: [{ ...registry.backends[0], enabled: false }] }, 'alpha')).toBe(false);
  });
  it('uses only teams matching the naming pattern, filters by backend namespace allowlist, and excludes already-adopted quotas', () => {
    const quotas = [
      { ComputeQuotaId: 'q-team', ComputeQuotaTarget: { TeamName: 'team' } },
      { ComputeQuotaId: 'q-other', ComputeQuotaTarget: { TeamName: 'other' } },
      { ComputeQuotaId: 'q-wrong', ComputeQuotaTarget: { TeamName: 'Not_Valid' } },
      { ComputeQuotaId: 'q-noteam', ComputeQuotaTarget: undefined },
    ];
    const projects = [{ computeQuotaId: 'q-adopted', id: 'team' }]; // team already adopted
    expect(adoptableQuotas(registry, 'alpha', quotas, projects)).toEqual([]);
    expect(adoptableQuotas(registry, 'default', quotas, projects)).toEqual([quotas[1]]);
    expect(adoptableQuotas(registry, 'alpha', quotas, [])).toEqual([quotas[0]]);
    expect(adoptableQuotas(registry, 'alpha', undefined, projects)).toEqual([]);
    expect(adoptableQuotas(registry, 'beta', quotas, projects)).toEqual([]);
  });
  it('uses the actual revision in registration requests and rejects unsupported metadata-only entries', () => {
    expect(registrationBody(registry.backends[0], false)).toEqual({ id: 'alpha', expectedVersion: 2, enabled: false });
    expect(registrationBody({ ...registry.backends[0], version: 0 }, true)).toEqual({ id: 'alpha', expectedVersion: 0, enabled: true });
    expect(() => registrationBody({ id: 'bad', status: 'UNREADY', findings: [] }, true)).toThrow();
  });
});
