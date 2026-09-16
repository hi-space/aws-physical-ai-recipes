import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Repo, setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import type { Session } from '@/server/store/types';
import * as services from '@/server/services/sessions';
import { POST as create } from './route';
import { PATCH as extend, DELETE as end } from './[id]/route';
import { POST as launch } from './[id]/launch/route';
import { GET as oldProxy } from './[id]/proxy/[[...path]]/route';

vi.mock('@/server/services/sessions', async (original) => ({
  ...await original<typeof import('@/server/services/sessions')>(),
  createManagedSession: vi.fn(), launchSession: vi.fn(), extendSession: vi.fn(), deleteSession: vi.fn(),
}));
const origin = 'https://physical-ai.hi-yoo.com';
const row: Session = { id: 'owned', name: 'session-owned', kind: 'jupyter', owner: 'alice', ownerSubject: 'sub', projectId: 'p',
  namespace: 'hyperpod-ns-team-a', queue: 'registered-queue', status: 'QUEUED', managedJob: true,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ssmTarget: 'must-not-leak' };
function req(path: string, method: string, json?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(origin + path, { method, headers: { origin, 'content-type': 'application/json', 'x-pai-user': 'alice',
    'x-pai-subject': 'sub', 'x-pai-role': 'researcher', 'x-pai-project': 'p', ...headers },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
}
const context = { params: Promise.resolve({ id: 'owned' }) };
beforeEach(async () => {
  vi.clearAllMocks();
  const repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'p', id: 'p', name: 'P', namespace: row.namespace,
    queue: row.queue, members: { sub: 'researcher' }, credentialRefs: [] });
  await repo.putSession(row);
  vi.mocked(services.createManagedSession).mockResolvedValue(row);
  vi.mocked(services.extendSession).mockResolvedValue(row);
  vi.mocked(services.deleteSession).mockResolvedValue({ ...row, status: 'CLOSING', revokedAt: new Date().toISOString() });
  vi.mocked(services.launchSession).mockResolvedValue({ url: 'https://owned.apps.physical-ai.hi-yoo.com/?ticket=synthetic-test', expiresAt: row.expiresAt! });
});
describe('session APIs with the actual body/auth wrappers', () => {
  it('parses POST JSON and passes the verified principal and server-selected project', async () => {
    const response = await create(req('/api/sessions', 'POST', { kind: 'jupyter', ttlMinutes: 60 }));
    expect(response.status).toBe(202);
    const data = await response.json(); expect(data.id).toBe('owned'); expect(data).not.toHaveProperty('ssmTarget');
    expect(services.createManagedSession).toHaveBeenCalledWith({ kind: 'jupyter', ttlMinutes: 60 }, expect.objectContaining({ subject: 'sub' }), expect.objectContaining({ namespace: row.namespace, queue: 'registered-queue' }));
  });
  it('rejects unknown target fields and wrong Origin before creation', async () => {
    expect((await create(req('/api/sessions', 'POST', { kind: 'jupyter', namespace: 'kube-system' }))).status).toBe(400);
    expect((await create(req('/api/sessions', 'POST', { kind: 'jupyter' }, { origin: 'https://sibling.invalid' }))).status).toBe(403);
    expect(services.createManagedSession).not.toHaveBeenCalled();
  });
  it('uses POST launch with owner checks delegated to the session service and preserves API errors', async () => {
    const response = await launch(req('/api/sessions/owned/launch', 'POST'), context);
    expect(response.status).toBe(200); expect((await response.json()).url).toContain('owned.apps.');
    expect(services.launchSession).toHaveBeenCalledWith('owned', expect.objectContaining({ subject: 'sub' }));
  });
  it('parses extension bodies and reports pending deletion instead of false completion', async () => {
    expect((await extend(req('/api/sessions/owned', 'PATCH', { ttlMinutes: '60' }), context)).status).toBe(400);
    expect((await extend(req('/api/sessions/owned', 'PATCH', { ttlMinutes: 120 }), context)).status).toBe(200);
    const closing = await end(req('/api/sessions/owned', 'DELETE'), context);
    expect((await closing.json()).status).toBe('CLOSING');
  });
  it('retires the dashboard-origin user-app proxy', async () => {
    expect((await oldProxy(req('/api/sessions/owned/proxy/lab', 'GET'), context)).status).toBe(410);
  });
});
