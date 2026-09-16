import { describe, expect, it } from 'vitest';
import { tokenFixture } from './token-fixtures.test-helpers';
import { createManagedSession, extendSession, launchSession, listSessionsWithStatus, cleanupExpiredSessions, type SessionDeps } from '../services/sessions';
import type { Session } from '../store/types';

async function fixture() {
  const f = await tokenFixture(); await f.repo.deleteSession('derived');
  const jobs = new Map<string, any>(); let pods: any[] = [];
  const deps: SessionDeps = { repo: f.repo, now: f.options.now!, currentUser: f.options.currentUser,
    image: 'registry/workspace:fixed', runtimeImage: 'registry/runtime:fixed', k8s: {
      prepare: async () => undefined,
      createJob: async (_ns, manifest) => { const job = structuredClone(manifest) as any; job.metadata.uid = 'owned-job'; jobs.set(job.metadata.name, job); return job; },
      getJob: async (_ns, name) => jobs.get(name) ?? null,
      listPods: async (_ns, selector) => pods.filter((p) => p.metadata.labels['pai.aws/session'] === selector.split('=')[1]),
      getPod: async (_ns, name) => pods.find((p) => p.metadata.name === name) ?? null,
      deleteObject: async (_ns, kind, name) => { if (kind === 'jobs') jobs.delete(name); if (kind === 'pods') pods = pods.filter((p) => p.metadata.name !== name); },
      listLegacy: async () => [],
    } };
  const create = (p = f.principal, ttlMinutes = 60) => createManagedSession({ kind: 'jupyter', ttlMinutes }, p, f.project, deps);
  async function ready(s: Session) {
    const job = jobs.get(s.name); job.spec.suspend = false;
    pods.push({ metadata: { name: `pod-${s.id}`, uid: `uid-${s.id}`, labels: job.metadata.labels, ownerReferences: [{ kind: 'Job', name: s.name, uid: job.metadata.uid }] },
      spec: { containers: [{ name: 'workspace', image: 'registered' }] }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'workspace', ready: true }] } });
    await listSessionsWithStatus(f.browser, deps);
  }
  return { ...f, deps, jobs, create, ready };
}

describe('sessions derived from API tokens', () => {
  it('captures the source identity and caps requested lifetime at the stored token maximum', async () => {
    const f = await fixture(); f.state.now = Date.parse(f.issued.metadata.expiresAt) - 15 * 60_000;
    const s = await f.create();
    expect(s).toMatchObject({ authMethod: 'token', tokenId: f.principal.tokenId, tokenProjectId: f.project.id, tokenRole: 'researcher', tokenExpiresAt: f.issued.metadata.expiresAt, expiresAt: f.issued.metadata.expiresAt });
    expect(JSON.stringify(s)).not.toContain(f.issued.token);
    expect(s).not.toHaveProperty('tokenHash');
  });
  it('bounds both token and browser-owner extension without removing source authority', async () => {
    const f = await fixture(); f.state.now = Date.parse(f.issued.metadata.expiresAt) - 15 * 60_000;
    const s = await f.create(f.principal, 5);
    const tokenExtended = await extendSession(s.id, 10, f.principal, f.deps);
    expect(Date.parse(tokenExtended.expiresAt!)).toBe(f.state.now + 10 * 60_000);
    const browserExtended = await extendSession(s.id, 240, f.browser, f.deps);
    expect(browserExtended.expiresAt).toBe(f.issued.metadata.expiresAt);
    expect(browserExtended.tokenId).toBe(f.principal.tokenId);
    expect(browserExtended.authMethod).toBe('token');
  });
  it('rejects missing source markers and mismatched role/project before creating any Job', async () => {
    const f = await fixture();
    for (const principal of [
      { ...f.principal, tokenId: undefined }, { ...f.principal, tokenProjectId: 'other' },
      { ...f.principal, role: 'viewer' as const }, { ...f.principal, role: 'admin' as const },
      { ...f.principal, scopes: ['sessions:read'] },
    ]) await expect(createManagedSession({ kind: 'jupyter' }, principal, f.project, f.deps)).rejects.toMatchObject({ status: 403 });
    expect(f.jobs.size).toBe(0); expect(await f.repo.listSessions()).toEqual([]);
  });
  it('does not let token callers launder browser sessions or sessions bound to another token', async () => {
    const f = await fixture();
    const browserSession = await createManagedSession({ kind: 'jupyter' }, f.browser, f.project, f.deps);
    await f.ready(browserSession);
    await expect(launchSession(browserSession.id, f.principal, f.deps)).rejects.toMatchObject({ status: 403 });
    await expect(extendSession(browserSession.id, 120, f.principal, f.deps)).rejects.toMatchObject({ status: 403 });
    const derived = await f.create(); await f.ready(derived);
    await expect(launchSession(derived.id, { ...f.principal, tokenId: 'b'.repeat(32) }, f.deps)).rejects.toMatchObject({ status: 403 });
    await expect(launchSession(derived.id, f.principal, f.deps)).resolves.toHaveProperty('url');
  });
  it('revokes/cleans derived managed sessions when the source is revoked', async () => {
    const f = await fixture(); const s = await f.create(); await f.revoke();
    await cleanupExpiredSessions(f.deps);
    expect(await f.repo.getSession(s.id)).toMatchObject({ status: 'CLOSED' });
    expect((await f.repo.getSession(s.id))?.revokedAt).toBeTruthy();
    expect(f.jobs.size).toBe(0);
  });
  it('does not destroy managed Jobs just because the identity provider is unavailable', async () => {
    const f = await fixture(); const s = await f.create(); f.state.failUser = true;
    await expect(cleanupExpiredSessions(f.deps)).rejects.toThrow();
    expect((await f.repo.getSession(s.id))?.revokedAt).toBeUndefined();
    expect(f.jobs.size).toBe(1);
  });
  it('filters token session lists to the token project and suppresses read-only launch flags', async () => {
    const f = await fixture(); const s = await f.create(); await f.ready(s);
    await f.repo.putSession({ id: 'other', name: 'legacy', kind: 'jupyter', owner: f.browser.user, ownerSubject: f.browser.subject, projectId: 'other', namespace: 'other', createdAt: new Date().toISOString() });
    const listed = await listSessionsWithStatus({ ...f.principal, role: 'viewer', scopes: ['sessions:read'] }, f.deps);
    expect(listed.map((row) => row.id)).toEqual([s.id]);
    expect(listed[0]).toMatchObject({ canOpen: false, canExtend: false, canEnd: false });
  });
});
