import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import { LogArchive } from './archive';
import type { LogScope } from './types';
const scope: LogScope = { projectId: 'p', backendId: 'default', namespace: 'research', workflowId: 'run', taskName: 'train', attempt: 1, epoch: 'epoch', member: 0, container: 'main', podName: 'pod', podUid: 'uid', restartCount: 0 };
let repo: Repo, archive: LogArchive, now: number;
beforeEach(() => { repo = new Repo(new MemoryKV()); now = Date.now(); archive = new LogArchive({ repo, now: () => now }); });
describe('append-only log archive', () => {
  it('replays identical/blank/URL log bytes across readers without text deduplication', async () => {
    const head = await archive.register(scope), lease = (await archive.acquire(head.id))!;
    const data = Buffer.from('same\nsame\n\nhttps://example.test/log?q=1\n');
    await archive.append(lease, 'first', { kind: 'data', data: data.toString('base64') });
    await archive.append(lease, 'second', { kind: 'data', data: data.toString('base64') });
    const restored = new LogArchive({ repo, now: () => now });
    const page = await restored.read(head.id, 0);
    expect(Buffer.concat(page.records.map(r => Buffer.from(r.data!, 'base64')))).toEqual(Buffer.concat([data, data]));
    expect(page.stream.coverage).toBe('captured-only'); expect(page.nextSequence).toBe(2);
  });
  it('deduplicates a retried batch by its receipt, and rejects different bytes under that ID', async () => {
    const h = await archive.register(scope), lease = (await archive.acquire(h.id))!;
    const input = { kind: 'data' as const, data: Buffer.from('one').toString('base64') };
    const a = await archive.append(lease, 'batch', input), b = await archive.append(lease, 'batch', input);
    expect(a.record.sequence).toBe(b.record.sequence);
    await expect(archive.append(lease, 'batch', { kind: 'data', data: Buffer.from('different').toString('base64') })).rejects.toThrow();
    expect((await archive.read(h.id, 0)).records).toHaveLength(1);
  });
  it('fences an old collector after its lease expires', async () => {
    const h = await archive.register(scope), old = (await archive.acquire(h.id))!;
    now += 16_000; const fresh = (await archive.acquire(h.id))!;
    await expect(archive.append(old, 'stale', { kind: 'gap', reason: 'source-error' })).rejects.toThrow();
    await archive.append(fresh, 'fresh', { kind: 'gap', reason: 'source-reconnect' });
    expect((await archive.read(h.id, 0)).records[0].reason).toBe('source-reconnect');
  });
  it('keeps old attempt/member/container/pod UID streams separate', async () => {
    const variants = [scope, { ...scope, attempt: 2 }, { ...scope, member: 1 }, { ...scope, container: 'init' }, { ...scope, podUid: 'replacement' }];
    const ids = await Promise.all(variants.map(s => archive.register(s).then(h => h.id)));
    expect(new Set(ids).size).toBe(5); expect((await archive.list('run', 'train')).streams).toHaveLength(5);
  });
  it('bounds pages and records a cap instead of silently discarding future data', async () => {
    archive = new LogArchive({ repo, maxArchiveBytes: 20 });
    const h = await archive.register(scope), lease = (await archive.acquire(h.id))!;
    await archive.append(lease, 'a', { kind: 'data', data: Buffer.alloc(12).toString('base64') });
    const capped = await archive.append(lease, 'b', { kind: 'data', data: Buffer.alloc(12).toString('base64') });
    expect(capped.capped).toBe(true); expect(capped.record.reason).toBe('capacity');
    expect((await archive.read(h.id, 0)).stream.state).toBe('capped');
  });
  it('does not reopen a sealed stream, but acknowledges an already committed retry', async () => {
    const h = await archive.register(scope), lease = (await archive.acquire(h.id))!;
    const input = { kind: 'data' as const, data: Buffer.from('committed').toString('base64') };
    await archive.append(lease, 'committed', input); await archive.close(lease);
    expect((await archive.append(lease, 'committed', input)).record.sequence).toBe(1);
    await expect(archive.append(lease, 'new', input)).rejects.toMatchObject({ code: 'log_archive_closed' });
    await archive.release(lease); expect(await archive.acquire(h.id)).toBeUndefined();
  });
});
