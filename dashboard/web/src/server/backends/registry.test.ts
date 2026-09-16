import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { resetConfigForTests } from '../config';
import { backendConfig, currentBackend, runOnBackend } from './context';
import { registerBackend, inspectBackend, readBackend, refreshBackendChecks } from './registry';
import { createProject, assertNamespaceAccess } from '../auth/projects';

import { admin, profile } from './test-fixtures';
let repo: Repo;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  vi.stubEnv('AUTH_MODE', 'alb'); vi.stubEnv('TABLE_NAME', 'home-table'); vi.stubEnv('ACCOUNT_ID', '123456789012');
  vi.stubEnv('AWS_REGION', 'us-east-1'); vi.stubEnv('BACKEND_HOME_VPC_ID', 'vpc-1234');
  vi.stubEnv('EKS_CLUSTER_NAME', 'home'); vi.stubEnv('HYPERPOD_EKS_CLUSTER_NAME', 'hp-home'); vi.stubEnv('EKS_DATA_BUCKET', 'data-home');
  vi.stubEnv('EKS_BACKENDS_JSON', JSON.stringify([profile('alpha'), profile('beta')]));
  resetConfigForTests(); repo = new Repo(new MemoryKV());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetConfigForTests(); });
const now = () => new Date('2026-09-16T12:00:00Z');
export const probe = async () => ({ ok: true as const, findings: [] });
describe('registered backends', () => {
  it('requires preconfigured identity, current capability evidence and a successful actual probe before routing', async () => {
    await expect(registerBackend(admin, { id: 'unknown', expectedVersion: 0, enabled: true }, repo, now)).rejects.toThrow();
    await registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now);
    expect((await readBackend('alpha', repo, now)).status).toBe('UNREADY');
    await expect(runOnBackend({ backendId: 'alpha' }, async () => 'unreachable', repo, now)).rejects.toThrow();
    await inspectBackend(admin, 'alpha', 1, repo, probe, now);
    expect((await readBackend('alpha', repo, now)).status).toBe('READY');
    expect(await runOnBackend({ backendId: 'alpha' }, async () => backendConfig().eks?.dataBucket, repo, now)).toBe('data-alpha');
  });
  it.each(['accountId', 'region', 'vpcId'] as const)('rejects unsupported %s instead of recording a ready connection', async key => {
    const p = { ...profile('alpha'), [key]: key === 'accountId' ? '999999999999' : key === 'region' ? 'us-west-2' : 'vpc-other' };
    vi.stubEnv('EKS_BACKENDS_JSON', JSON.stringify([p]));
    await expect(registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now)).rejects.toThrow();
  });
  it('keeps unknown network proof and expired or failed checks unready', async () => {
    const p = profile('alpha'); delete p.evidence['worker-api-network'];
    vi.stubEnv('EKS_BACKENDS_JSON', JSON.stringify([p]));
    await registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now);
    await inspectBackend(admin, 'alpha', 1, repo, probe, now);
    expect((await readBackend('alpha', repo, now)).findings).toContainEqual(expect.objectContaining({ code: 'worker-api-network' }));
    expect((await readBackend('alpha', repo, now)).status).toBe('UNREADY');
  });
  it('uses immutable registry revisions, optimistic locking and detects allowlist changes', async () => {
    await registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now);
    await expect(registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: false }, repo, now)).rejects.toThrow();
    await inspectBackend(admin, 'alpha', 1, repo, probe, now);
    await registerBackend(admin, { id: 'alpha', expectedVersion: 1, enabled: false }, repo, now);
    expect((await readBackend('alpha', repo, now)).status).toBe('DISABLED');
    expect(await repo.kv.get('BACKEND#alpha', 'REV#0000000001')).toMatchObject({ enabled: true });
    const changed = profile('alpha'); changed.eks.eksClusterName = 'different';
    vi.stubEnv('EKS_BACKENDS_JSON', JSON.stringify([changed]));
    expect((await readBackend('alpha', repo, now)).findings).toContainEqual(expect.objectContaining({ code: 'configuration_changed' }));
  });
  it('refreshes expiring registered capability checks without registering or enabling other targets', async () => {
    await registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now);
    await inspectBackend(admin, 'alpha', 1, repo, probe, now);
    const later = () => new Date('2026-09-16T12:16:00Z');
    expect((await readBackend('alpha', repo, later)).status).toBe('UNREADY');
    await refreshBackendChecks(repo, probe, later);
    expect((await readBackend('alpha', repo, later)).status).toBe('READY');
    expect((await readBackend('beta', repo, later)).version).toBe(0);
    await registerBackend(admin, { id: 'alpha', expectedVersion: 1, enabled: false }, repo, later);
    await refreshBackendChecks(repo, probe, later);
    expect((await readBackend('alpha', repo, later)).status).toBe('DISABLED');
  });
  it('isolates concurrent backend config without changing home env and restores nested scope', async () => {
    for (const id of ['alpha', 'beta']) {
      await registerBackend(admin, { id, expectedVersion: 0, enabled: true }, repo, now);
      await inspectBackend(admin, id, 1, repo, probe, now);
    }
    const observed = await Promise.all(['alpha', 'beta'].map(id => runOnBackend({ backendId: id }, async () => {
      await new Promise(resolve => setTimeout(resolve, id === 'alpha' ? 10 : 1));
      const nested = await runOnBackend({}, async () => backendConfig().eks?.eksClusterName, repo, now);
      return [currentBackend()?.id, backendConfig().eks?.eksClusterName, nested, backendConfig().tableName];
    }, repo, now)));
    expect(observed).toEqual([['alpha', 'eks-alpha', 'home', 'home-table'], ['beta', 'eks-beta', 'home', 'home-table']]);
    expect(currentBackend()).toBeUndefined(); expect(process.env.EKS_CLUSTER_NAME).toBe('home');
  });
  it('binds duplicate namespace names independently and checks namespace access within the selected backend', async () => {
    for (const id of ['alpha', 'beta']) {
      await registerBackend(admin, { id, expectedVersion: 0, enabled: true }, repo, now);
      await inspectBackend(admin, id, 1, repo, probe, now);
    }
    const a = await createProject(admin, { id: 'a', name: 'A', backendId: 'alpha', namespace: 'hyperpod-ns-team-a', members: { alice: 'researcher' } }, repo);
    const b = await createProject(admin, { id: 'b', name: 'B', backendId: 'beta', namespace: 'hyperpod-ns-team-a', members: { bob: 'researcher' } }, repo);
    expect(a.backendId).toBe('alpha'); expect(b.backendId).toBe('beta');
    expect(await repo.kv.get('PROJECT_NAMESPACE#alpha#hyperpod-ns-team-a', 'OWNER')).toMatchObject({ projectId: 'a' });
    await expect(assertNamespaceAccess({ ...admin, role: 'researcher', subject: 'alice' }, b.namespace, false, 'beta', repo)).rejects.toThrow();
  });
});
