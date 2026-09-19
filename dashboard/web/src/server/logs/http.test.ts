import { describe, expect, it, vi } from 'vitest';
import { taskLogResponse } from './http';
import type { Session } from '../auth/session';
import type { Pod } from '../k8s/resources';

vi.mock('./auth', () => ({ authorizeLogs: vi.fn(async (_p, id) => ({ id, namespace: 'team', projectId: 'p1', spec: { workflow: { tasks: [{ name: 'train' }] } } })) }));
const session: Session = { user: 'u', subject: 's', email: 'e', role: 'researcher', authMethod: 'alb' };
const pod = (attempt: number, name = `p${attempt}`): Pod => ({ metadata: { name, namespace: 'team', uid: `${name}-uid`, labels: { 'pai.aws/attempt': String(attempt), 'pai.aws/task': 'train' } }, spec: { containers: [{ name: 'main' }] } as Pod['spec'], status: { phase: 'Running' } });
const task = { name: 'train', attempts: 2, attemptEpoch: 'e' };
const repo = { getWorkflow: async () => ({ id: 'w1', namespace: 'team' }), listTasks: async () => [task] } as never;
const request = (query: string, headers: Record<string, string> = {}) => new Request(`http://x/api/workflows/w1/tasks/train/logs?${query}`, { headers });
const base = { repo, getPod: async () => pod(2) };

describe('taskLogResponse JSON', () => {
  it('returns pod-gone when no pod exists for the task', async () => {
    const res = await taskLogResponse(request(''), session, 'w1', 'train', { ...base, listPods: async () => [] });
    expect(await res.json()).toMatchObject({ source: 'none', reason: 'pod-gone', targets: [], lines: [] });
  });
  it('reads the latest attempt with redaction from the attempt secret', async () => {
    const read = vi.fn(async (_ns: string, _pod: string, _opts?: unknown) => '2026-09-19T00:00:00Z pw=S3CR3T\n');
    const res = await taskLogResponse(request('tail=50'), session, 'w1', 'train', { ...base, listPods: async () => [pod(1), pod(2)], secrets: async () => ['S3CR3T'], read });
    const body = await res.json();
    expect(body).toMatchObject({ source: 'kubernetes', redaction: 'applied', target: { attempt: 2 }, container: 'main', lines: [{ text: 'pw=[REDACTED]' }] });
    expect(body.targets).toHaveLength(2);
    expect(read.mock.calls[0][2]).toMatchObject({ tailLines: 50 });
  });
  it('fails closed with 403 for non-admins when the attempt secret cannot be verified', async () => {
    const res = await taskLogResponse(request(''), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => { throw new Error('no secret'); }, read: async () => 'x\n' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'log_redaction_unavailable' });
  });
  it('lets an admin read with redaction unavailable when the attempt secret cannot be verified', async () => {
    const res = await taskLogResponse(request(''), { ...session, role: 'admin' }, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => { throw new Error('no secret'); }, read: async () => 'x\n' });
    expect(await res.json()).toMatchObject({ redaction: 'unavailable', lines: [{ text: 'x' }] });
  });
  it('rejects an out-of-range tail', async () => {
    const res = await taskLogResponse(request('tail=99999'), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)] });
    expect(res.status).toBe(400);
  });
});
describe('taskLogResponse SSE', () => {
  const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
  it('frames lines with the timestamp as id and ends with pod-ended when the kubelet stream closes', async () => {
    const res = await taskLogResponse(request('follow=1', { accept: 'text/event-stream' }), session, 'w1', 'train',
      { ...base, listPods: async () => [pod(2)], secrets: async () => [], open: async () => stream(['2026-09-19T00:00:00Z a\n2026-09-19T00:00:01Z b\n']) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('id: 2026-09-19T00:00:00Z\nevent: line\ndata: {"ts":"2026-09-19T00:00:00Z","text":"a"}\n\n');
    expect(text).toContain('event: end\ndata: {"reason":"pod-ended"}\n\n');
  });
  it('resumes from Last-Event-ID via sinceTime', async () => {
    const open = vi.fn(async (_ns: string, _pod: string, _opts?: unknown) => stream([]));
    await (await taskLogResponse(request('follow=1', { accept: 'text/event-stream', 'last-event-id': '2026-09-19T00:00:05Z' }), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => [], open })).text();
    expect(open.mock.calls[0][2]).toMatchObject({ sinceTime: '2026-09-19T00:00:05Z' });
  });
  it('ends with timeout after the lifetime even if the kubelet stream stays open', async () => {
    const open = async (_ns: string, _pod: string, opts: { container?: string; tailLines?: number; sinceTime?: string; signal?: AbortSignal } = {}) => new ReadableStream<Uint8Array>({ start(c) { opts.signal?.addEventListener('abort', () => c.close()); } });
    const res = await taskLogResponse(request('follow=1', { accept: 'text/event-stream' }), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => [], open, lifetimeMs: 20 });
    expect(await res.text()).toContain('event: end\ndata: {"reason":"timeout"}');
  });
  it('emits log-error and closes when re-authorization fails', async () => {
    const { authorizeLogs } = await import('./auth');
    (authorizeLogs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'w1', namespace: 'team', projectId: 'p1' }).mockRejectedValueOnce(new Error('revoked'));
    const open = async (_ns: string, _pod: string, opts: { container?: string; tailLines?: number; sinceTime?: string; signal?: AbortSignal } = {}) => new ReadableStream<Uint8Array>({ start(c) { opts.signal?.addEventListener('abort', () => c.close()); } });
    const res = await taskLogResponse(request('follow=1', { accept: 'text/event-stream' }), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => [], open, authMs: 5, lifetimeMs: 500 });
    expect(await res.text()).toContain('event: log-error');
  });
});
