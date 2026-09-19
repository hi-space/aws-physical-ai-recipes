import { describe, expect, it } from 'vitest';
import { SecretRedactor } from './redaction';
import { followLogs, pickContainer, pickTarget, readLogs, splitLogLines, targetsFromPods } from './stream';
import type { Pod } from '../k8s/resources';

const pod = (name: string, attempt: number, member = 0, uid = `${name}-uid`, phase = 'Running'): Pod => ({
  metadata: { name, namespace: 'team', uid, labels: { 'app.kubernetes.io/managed-by': 'physical-ai-dashboard', 'pai.aws/workflow-id': 'w1', 'pai.aws/task': 'train', 'pai.aws/attempt': String(attempt), 'batch.kubernetes.io/job-completion-index': String(member) } },
  spec: { containers: [{ name: 'main' }, { name: 'pai-live' }] } as Pod['spec'], status: { phase },
});
const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } });

describe('targets', () => {
  it('orders newest attempt first, members ascending, and lists containers', () => {
    const targets = targetsFromPods([pod('a1m1', 1, 1), pod('a2', 2), pod('a1m0', 1, 0)]);
    expect(targets.map(t => [t.attempt, t.member, t.podName])).toEqual([[2, 0, 'a2'], [1, 0, 'a1m0'], [1, 1, 'a1m1']]);
    expect(targets[0].containers).toEqual(['main', 'pai-live']);
  });
  it('picks the latest attempt / first member by default and honours explicit selection', () => {
    const targets = targetsFromPods([pod('a1m1', 1, 1), pod('a2', 2), pod('a1m0', 1, 0)]);
    expect(pickTarget(targets, {})?.podName).toBe('a2');
    expect(pickTarget(targets, { attempt: 1, member: 1 })?.podName).toBe('a1m1');
    expect(pickTarget(targets, { attempt: 9 })).toBeUndefined();
    expect(pickContainer(targets[0])).toBe('main');
    expect(pickContainer(targets[0], 'pai-live')).toBe('pai-live');
    expect(() => pickContainer(targets[0], 'nope')).toThrow(/Container/);
  });
});
describe('splitLogLines', () => {
  it('separates kubelet timestamps and keeps blank and repeated lines', () => {
    expect(splitLogLines('2026-09-19T01:02:03.000000001Z same\n2026-09-19T01:02:04Z same\n2026-09-19T01:02:05Z \nno-timestamp line\n')).toEqual([
      { ts: '2026-09-19T01:02:03.000000001Z', text: 'same' }, { ts: '2026-09-19T01:02:04Z', text: 'same' },
      { ts: '2026-09-19T01:02:05Z', text: '' }, { ts: '', text: 'no-timestamp line' }]);
  });
});
describe('readLogs', () => {
  const target = targetsFromPods([pod('p', 1)])[0];
  it('redacts exact secrets and passes tail/sinceTime to the kubelet read', async () => {
    const calls: unknown[] = [];
    const read = async (_ns: string, _pod: string, opts: unknown) => { calls.push(opts); return '2026-09-19T00:00:00Z token=SECRET-1\n'; };
    const result = await readLogs(target, 'main', { tail: 7, sinceTime: '2026-09-18T00:00:00Z', redactor: new SecretRedactor(['SECRET-1']), read });
    expect(result.lines).toEqual([{ ts: '2026-09-19T00:00:00Z', text: 'token=[REDACTED]' }]);
    expect(calls[0]).toMatchObject({ container: 'main', tailLines: 7, sinceTime: '2026-09-18T00:00:00Z' });
  });
  it('marks truncation when the snapshot exceeds the byte bound', async () => {
    const read = async () => `2026-09-19T00:00:00Z head\n2026-09-19T00:00:01Z ${'x'.repeat(1024 * 1024)}\n`;
    const result = await readLogs(target, 'main', { read });
    expect(result.truncated).toBe(true);
    expect(result.lines).toEqual([{ ts: '2026-09-19T00:00:00Z', text: 'head' }]);
  });
});
describe('followLogs', () => {
  const target = targetsFromPods([pod('p', 1)])[0];
  it('yields redacted lines across chunk boundaries and stops when the stream ends', async () => {
    const open = async () => stream(['2026-09-19T00:00:00Z a SEC', 'RET-1 b\n2026-09-19T00:00:01Z last']);
    const lines = [];
    for await (const line of followLogs(target, 'main', { redactor: new SecretRedactor(['SECRET-1']), signal: new AbortController().signal, open })) lines.push(line);
    expect(lines).toEqual([{ ts: '2026-09-19T00:00:00Z', text: 'a [REDACTED] b' }, { ts: '2026-09-19T00:00:01Z', text: 'last' }]);
  });
  it('does not yield a phantom empty line when the final chunk ends with a newline', async () => {
    const open = async () => stream(['2026-09-19T00:00:01Z last\n']);
    const lines = [];
    for await (const line of followLogs(target, 'main', { signal: new AbortController().signal, open })) lines.push(line);
    expect(lines).toEqual([{ ts: '2026-09-19T00:00:01Z', text: 'last' }]);
  });
});
