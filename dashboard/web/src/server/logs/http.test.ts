import { beforeEach, expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { LogArchive } from './archive';
import { readTaskLogs, taskLogResponse } from './http';
import type { LogDeps, LogScope } from './types';
import { tokenFixture } from '../gateway/token-fixtures.test-helpers';
const scope: LogScope = { projectId: 'p', backendId: 'default', namespace: 'research', workflowId: 'w', taskName: 'train', attempt: 1, epoch: 'e1', member: 0, container: 'main', podName: 'pod', podUid: 'uid', restartCount: 0 };
const p = { user: 'alice', subject: 'alice-sub', email: '', role: 'researcher' as const, authMethod: 'alb' as const };
let deps: LogDeps, archive: LogArchive, id: string;
const url = (q = '') => new URL(`https://dashboard.test/api/workflows/w/tasks/train/logs?${q}`);
beforeEach(async () => {
  const repo = new Repo(new MemoryKV());
  deps = { repo, currentUser: async () => ({ username: 'alice', subject: p.subject, email: '', enabled: true, groups: ['researchers'] }) };
  await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: scope.namespace, members: { [p.subject]: 'researcher' } });
  await repo.kv.put({ pk: 'WF#w', sk: 'META', id: 'w', projectId: 'p', namespace: scope.namespace, status: 'SUCCEEDED', spec: { workflow: { tasks: [{ name: 'train' }] } } });
  archive = new LogArchive(deps); id = (await archive.register(scope)).id;
  const lease = (await archive.acquire(id))!;
  for (const data of ['same\nsame\n\n', 'https://example.test/result\n', 'last']) await archive.append(lease, data, { kind: 'data', data: Buffer.from(data).toString('base64') });
  await archive.close(lease); await archive.release(lease);
});
it('replays a deleted-pod completed attempt with opaque cursor and preserves arbitrary bytes', async () => {
  const a = await readTaskLogs(p, 'w', 'train', url('start=beginning'), deps);
  expect(a.cursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a.stream?.scope).toEqual(scope);
  expect(Buffer.concat(a.records.map(r => Buffer.from(r.data!, 'base64'))).toString()).toBe('same\nsame\n\nhttps://example.test/result\nlast');
  const b = await readTaskLogs(p, 'w', 'train', url(`cursor=${a.cursor}`), deps);
  expect(b.records).toEqual([]);
});
it.each(['member=1', 'attempt=2', 'container=init', 'podUid=replacement', 'stream=' + 'a'.repeat(64)])('rejects cursor selector substitution: %s', async selector => {
  const a = await readTaskLogs(p, 'w', 'train', url('start=beginning'), deps);
  await expect(readTaskLogs(p, 'w', 'train', url(`cursor=${a.cursor}&${selector}`), deps)).rejects.toMatchObject({ status: 409 });
});
it('rejects cursor reuse by another reader and stale project membership', async () => {
  const a = await readTaskLogs(p, 'w', 'train', url(), deps);
  await expect(readTaskLogs({ ...p, subject: 'other' }, 'w', 'train', url(`cursor=${a.cursor}`), deps)).rejects.toBeDefined();
  await deps.repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: scope.namespace, members: {} });
  await expect(readTaskLogs(p, 'w', 'train', url(`cursor=${a.cursor}`), deps)).rejects.toMatchObject({ status: 403 });
});
it('reconnects SSE from Last-Event-ID without resending committed records', async () => {
  const a = await readTaskLogs(p, 'w', 'train', url('start=beginning'), deps);
  const response = await taskLogResponse(new Request(url('follow=1'), { headers: { 'last-event-id': a.cursor! } }), p, 'w', 'train', deps);
  const text = await response.text();
  expect(text).toContain('event: end'); expect(text).not.toContain('"kind":"data"');
});
it('closes a backpressured SSE reader when its source token is revoked', async () => {
  const f = await tokenFixture(); await f.changeToken({ scopes: ['workflows:read'] });
  const principal = { ...f.principal, scopes: ['workflows:read' as const] };
  const d = { repo: f.repo, currentUser: f.options.currentUser, now: f.options.now, pollMs: 5, authMs: 5 };
  await f.repo.kv.put({ pk: 'WF#w', sk: 'META', id: 'w', projectId: f.project.id, namespace: f.project.namespace, spec: { workflow: { tasks: [{ name: 'train' }] } } });
  await new LogArchive(d).register({ ...scope, projectId: f.project.id, namespace: f.project.namespace });
  const response = await taskLogResponse(new Request(url('follow=1')), principal, 'w', 'train', d);
  const reader = response.body!.getReader();
  await f.revoke();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((await reader.read()).done).toBe(true);
});
it('ends a quiet connection on its budget and replays newly appended data from its cursor', async () => {
  const head = await archive.register({ ...scope, podUid: 'quiet' }), lease = (await archive.acquire(head.id))!;
  const first = await readTaskLogs(p, 'w', 'train', url(`stream=${head.id}`), deps);
  const response = await taskLogResponse(new Request(url(`stream=${head.id}&follow=1&cursor=${first.cursor}`)), p, 'w', 'train', { ...deps, lifetimeMs: 15 });
  const reader = response.body!.getReader();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((await reader.read()).done).toBe(true);
  await archive.append(lease, 'new', { kind: 'data', data: Buffer.from('after silence\n').toString('base64') });
  const after = await readTaskLogs(p, 'w', 'train', url(`stream=${head.id}&cursor=${first.cursor}`), deps);
  expect(after.records.map(r => Buffer.from(r.data!, 'base64').toString())).toEqual(['after silence\n']);
  await archive.release(lease);
});
it('expires a cursor explicitly without silently jumping to the latest tail', async () => {
  let now = Date.now(); const d = { ...deps, now: () => now };
  const a = await readTaskLogs(p, 'w', 'train', url(), d);
  now += 3600_000;
  await expect(readTaskLogs(p, 'w', 'train', url(`cursor=${a.cursor}`), d)).rejects.toMatchObject({ status: 410 });
});
