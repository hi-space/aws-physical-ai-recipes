import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryKV } from '../store/dynamo';
import type { Project } from './projects';
import { projectItem } from './projects';
import type { Session } from './session';
import { projectFixture, testSession } from './session.test-helpers';
import type { CurrentUserAuthorization } from '../aws/cognito';
import { createApiToken, listApiTokens, revokeApiToken, verifyApiToken, type ApiTokenDeps } from './api-tokens';

const principal: Session = testSession('alice', 'sub-a', 'researcher', ['proj-a-admin']);
const project: Project = projectFixture('a');
let kv: MemoryKV, now: number, deps: ApiTokenDeps;
beforeEach(async () => {
  kv = new MemoryKV(); now = 1_800_000_000_000; let seq = 0;
  await kv.put(projectItem(project));
  deps = { kv, now: () => now, randomId: () => (++seq).toString(16).padStart(32, '0'), randomToken: () => `pai_${Buffer.alloc(32, seq + 1).toString('base64url')}`,
    currentUser: vi.fn(async () => ({ username: 'alice', subject: 'sub-a', email: 'current@example.test', enabled: true, groups: ['researchers', 'proj-a-admin'] })) };
});
const issue = (scopes: ('workflows:read' | 'workflows:write' | 'metrics:read')[] = ['workflows:read', 'workflows:write']) => createApiToken(principal, project, { name: 'cli', scopes, expiresInDays: 1 }, deps);

describe('project API token authorization', () => {
  it('returns 256-bit token once and persists only a digest with public owner metadata', async () => {
    const created = await issue();
    expect(created.token).toMatch(/^pai_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(created.token.slice(4), 'base64url')).toHaveLength(32);
    const stored = JSON.stringify([...kv.items.values()]);
    expect(stored).not.toContain(created.token);
    expect(stored).toContain(createHash('sha256').update(created.token).digest('hex'));
    const listed = await listApiTokens(principal, project, deps);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('tokenHash');
    expect(listed[0]).not.toHaveProperty('token');
  });
  it('requires the exact scope and treats POST metrics/query as a read capability', async () => {
    const { token } = await issue(['workflows:read', 'metrics:read']);
    expect(await verifyApiToken(token, 'GET', '/api/workflows', deps)).toMatchObject({ user: 'alice', subject: 'sub-a', email: 'current@example.test', tokenProjectId: 'a', authMethod: 'token', role: 'researcher' });
    await expect(verifyApiToken(token, 'POST', '/api/workflows', deps)).rejects.toMatchObject({ status: 403 });
    await expect(verifyApiToken(token, 'POST', '/api/metrics/query', deps)).resolves.toMatchObject({ tokenProjectId: 'a' });
  });
  it('expires at the deadline and enforces revocation without waiting for TTL deletion', async () => {
    const { token, metadata } = await issue();
    now = Date.parse(metadata.expiresAt);
    await expect(verifyApiToken(token, 'GET', '/api/workflows', deps)).rejects.toMatchObject({ status: 401 });
    now -= 1000;
    await revokeApiToken(principal, project, metadata.id, deps);
    await expect(verifyApiToken(token, 'GET', '/api/workflows', deps)).rejects.toMatchObject({ status: 401 });
  });
  it('never delegates platform admin, and honors group and project downgrades', async () => {
    deps.currentUser = vi.fn(async () => ({ username: 'alice', subject: 'sub-a', email: '', enabled: true, groups: ['admins', 'proj-a-admin'] }));
    const { token } = await issue();
    expect((await verifyApiToken(token, 'POST', '/api/workflows', deps)).role).toBe('researcher');
    // Still a project member (proj-a), but without a platform researcher/admin group ⇒ downgraded to viewer.
    deps.currentUser = vi.fn(async () => ({ username: 'alice', subject: 'sub-a', email: '', enabled: true, groups: ['proj-a'] }));
    await expect(verifyApiToken(token, 'POST', '/api/workflows', deps)).rejects.toMatchObject({ status: 403 });
    const downgraded = await verifyApiToken(token, 'GET', '/api/workflows', deps);
    expect(downgraded.role).toBe('viewer');
    expect(downgraded.scopes).not.toContain('workflows:write');
    // Member group removed entirely ⇒ no project membership at all.
    deps.currentUser = vi.fn(async () => ({ username: 'alice', subject: 'sub-a', email: '', enabled: true, groups: ['researchers'] }));
    await expect(verifyApiToken(token, 'GET', '/api/workflows', deps)).rejects.toMatchObject({ status: 403 });
  });
  it.each(['disabled', 'recreated', 'unavailable'])('rejects a currently %s Cognito user', async (kind) => {
    const { token } = await issue();
    deps.currentUser = vi.fn(async () => {
      if (kind === 'unavailable') throw new Error('provider body with private data');
      return { username: 'alice', subject: kind === 'recreated' ? 'new-sub' : 'sub-a', email: '', enabled: kind !== 'disabled', groups: ['researchers'] };
    });
    await expect(verifyApiToken(token, 'GET', '/api/workflows', deps)).rejects.toThrow();
    await expect(verifyApiToken(token, 'GET', '/api/workflows', deps)).rejects.not.toThrow('private data');
  });
  it.each(['/api/admin/users', '/api/credentials', '/api/tokens', '/api/sessions/dcv/start', '/api/s3/presign', '/api/workflows/../tokens', '/api/workflows/%2e%2e/tokens', '/api/workflows/a%2fb', '/api/v1/workflows', '/api/workflows?project=b', '//api/workflows'])('fails closed for %s', async (path) => {
    const { token } = await issue();
    await expect(verifyApiToken(token, 'POST', path, deps)).rejects.toMatchObject({ status: 403 });
  });
  it('checks resource project binding for workflow IDs', async () => {
    const { token } = await issue();
    await kv.put({ pk: 'WF#run-b', sk: 'META', projectId: 'b', ownerSubject: 'sub-a' });
    await expect(verifyApiToken(token, 'GET', '/api/workflows/run-b', deps)).rejects.toMatchObject({ status: 403 });
  });
  it('checks revocation again after an in-flight Cognito lookup', async () => {
    const created = await issue(); let release!: () => void;
    deps.currentUser = vi.fn(() => new Promise<CurrentUserAuthorization>((resolve) => { release = () => resolve({ username: 'alice', subject: 'sub-a', email: '', enabled: true, groups: ['researchers', 'proj-a-admin'] }); }));
    const verifying = verifyApiToken(created.token, 'GET', '/api/workflows', deps);
    await vi.waitFor(() => expect(deps.currentUser).toHaveBeenCalled());
    await revokeApiToken(principal, project, created.metadata.id, deps); release();
    await expect(verifying).rejects.toMatchObject({ status: 401 });
  });
  it('bounds expiry, rejects unknown scopes and token-created tokens, and prevents another owner revoking', async () => {
    await expect(createApiToken(principal, project, { name: 'long', scopes: ['workflows:read'], expiresInDays: 31 }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(createApiToken(principal, project, { name: 'admin', scopes: ['admin'] as never }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(createApiToken({ ...principal, authMethod: 'token' }, project, { name: 'chain', scopes: ['workflows:read'] }, deps)).rejects.toMatchObject({ status: 403 });
    const created = await issue();
    // sub-b holds no proj-a group at all (unlike sub-a's proj-a-admin), mirroring the old fixture where
    // only sub-a was in project.members: this is denied for lack of project membership, same as before.
    await expect(revokeApiToken({ ...principal, subject: 'sub-b', groups: ['researchers'] }, project, created.metadata.id, deps)).rejects.toMatchObject({ status: 403 });
    expect(await listApiTokens({ ...principal, subject: 'sub-a' }, project, deps)).toHaveLength(1);
  });
});
