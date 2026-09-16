import { expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { LogArchive } from './archive';
import { capturePodLogs } from './capture';
import type { LogScope } from './types';
const scope: LogScope = { projectId: 'p', backendId: 'default', namespace: 'research', workflowId: 'w', taskName: 'train', attempt: 1, epoch: 'e', member: 0, container: 'main', podName: 'pod', podUid: 'uid', restartCount: 0 };
it('commits exact-redacted captured bytes before replay, including cross-chunk secret values', async () => {
  const repo = new Repo(new MemoryKV());
  const result = await capturePodLogs(scope, new AbortController().signal, {
    repo, secrets: ['actual-secret'], validate: async () => true,
    open: async (_s, options) => {
      expect(options.resume).toBe(false);
      return new ReadableStream({ start(c) { c.enqueue(Buffer.from('same\nsame\n\nactual-')); c.enqueue(Buffer.from('secret https://example.test\n')); c.close(); } });
    },
    finished: async () => true,
  });
  const page = await new LogArchive({ repo }).read(result.id, 0);
  expect(Buffer.concat(page.records.filter(r => r.kind === 'data').map(r => Buffer.from(r.data!, 'base64'))).toString()).toBe('same\nsame\n\n[REDACTED] https://example.test\n');
  expect(page.stream.state).toBe('closed'); expect(page.stream.coverage).toBe('captured-only');
  expect(page.records.filter(r => r.kind === 'gap').map(r => r.reason)).toEqual(['source-start', 'source-eof']);
});
it('records a reconnect gap and resumes with no guessed text/timestamp offset', async () => {
  const repo = new Repo(new MemoryKV()), archive = new LogArchive({ repo });
  const h = await archive.register(scope), lease = (await archive.acquire(h.id))!;
  await archive.append(lease, 'old', { kind: 'data', data: Buffer.from('old\n').toString('base64') }); await archive.release(lease);
  const result = await capturePodLogs(scope, new AbortController().signal, {
    repo, secrets: [], validate: async () => true, finished: async () => false,
    open: async (_s, opts) => { expect(opts.resume).toBe(true); return new ReadableStream({ start(c) { c.enqueue(Buffer.from('new\n')); c.close(); } }); },
  });
  const page = await archive.read(result.id, 0);
  expect(page.records.some(r => r.reason === 'source-reconnect')).toBe(true);
  expect(page.stream.state).toBe('open');
});
it('does not archive bytes from a Pod replaced during opening', async () => {
  const repo = new Repo(new MemoryKV()); let calls = 0;
  await expect(capturePodLogs(scope, new AbortController().signal, {
    repo, secrets: [], validate: async () => ++calls === 1, finished: async () => true,
    open: async () => new ReadableStream({ start(c) { c.enqueue(Buffer.from('wrong-pod')); c.close(); } }),
  })).rejects.toThrow();
  const [head] = (await new LogArchive({ repo }).list('w', 'train')).streams;
  expect(head.bytes).toBe(0);
});
it('retries an ambiguous durable append without duplicating the committed source bytes', async () => {
  const kv = new MemoryKV(), repo = new Repo(kv), transaction = kv.transaction.bind(kv);
  let failAfterCommit = true;
  kv.transaction = async writes => {
    const result = await transaction(writes);
    if (failAfterCommit && writes.some(w => w.kind === 'put' && w.item.kind === 'data')) {
      failAfterCommit = false; throw new Error('Simulated response lost after commit');
    }
    return result;
  };
  const result = await capturePodLogs(scope, new AbortController().signal, { repo, secrets: [], validate: async () => true, finished: async () => true,
    open: async () => new ReadableStream({ start(c) { c.enqueue(Buffer.from('exactly captured\n')); c.close(); } }),
  });
  const page = await new LogArchive({ repo }).read(result.id, 0);
  expect(page.records.filter(r => r.kind === 'data')).toHaveLength(1);
  expect(Buffer.from(page.records.find(r => r.kind === 'data')!.data!, 'base64').toString()).toBe('exactly captured\n');
});
