import { describe, expect, it } from 'vitest';
import { backendAvailable, projectQueues, registrationBody, type BackendRegistry } from './backend-ui';

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
  it('uses only reachable governed queues, filters namespace claims by backend, and enforces the profile namespace allowlist', () => {
    const queues = [
      { namespace: 'hyperpod-ns-team', name: 'hyperpod-ns-team-localqueue' },
      { namespace: 'hyperpod-ns-team', name: 'hyperpod-ns-team-localqueue' },
      { namespace: 'hyperpod-ns-other', name: 'hyperpod-ns-other-localqueue' },
      { namespace: 'hyperpod-ns-wrong', name: 'different-name' },
      { namespace: 'kube-system', name: 'kube-system-localqueue' },
    ];
    const projects = [{ namespace: 'hyperpod-ns-team' }]; // historical default binding
    expect(projectQueues(registry, 'alpha', queues, projects)).toEqual([queues[0]]);
    expect(projectQueues(registry, 'default', queues, projects)).toEqual([queues[2]]);
    expect(projectQueues(registry, 'alpha', queues, [{ namespace: 'hyperpod-ns-team', backendId: 'alpha' }])).toEqual([]);
    expect(projectQueues(registry, 'alpha', undefined, projects)).toEqual([]);
    expect(projectQueues(registry, 'beta', queues, projects)).toEqual([]);
  });
  it('uses the actual revision in registration requests and rejects unsupported metadata-only entries', () => {
    expect(registrationBody(registry.backends[0], false)).toEqual({ id: 'alpha', expectedVersion: 2, enabled: false });
    expect(registrationBody({ ...registry.backends[0], version: 0 }, true)).toEqual({ id: 'alpha', expectedVersion: 0, enabled: true });
    expect(() => registrationBody({ id: 'bad', status: 'UNREADY', findings: [] }, true)).toThrow();
  });
});
