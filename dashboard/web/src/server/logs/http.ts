import type { Session } from '../auth/session';
import { HttpError } from '../errors';
import { getPod, listPods, podLogs, streamPodLogs, type Pod } from '../k8s/resources';
import { getRepo } from '../store/repo';
import type { Task, Workflow } from '../store/types';
import { injectedLogSecrets } from '../workflow-adapters/log-secrets';
import { authorizeLogs } from './auth';
import { SecretRedactor } from './redaction';
import { followLogs, pickContainer, pickTarget, readLogs, resolveTargets } from './stream';
import { LIMITS, type LogDeps, type LogLine, type LogSnapshot, type LogTarget } from './types';

export interface LogHttpDeps extends LogDeps {
  listPods?: typeof listPods; getPod?: typeof getPod; secrets?: typeof injectedLogSecrets;
  read?: typeof podLogs; open?: typeof streamPodLogs; authMs?: number; lifetimeMs?: number;
}
const HEADERS = { 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' };
const int = (v: string | null, name: string) => { if (v === null) return undefined; const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`); return n; };
export function sinceParam(v: string | null): string | undefined { if (!v) return undefined; if (!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v)) throw new HttpError(400, 'since must be an RFC3339 UTC timestamp'); return v; }

/** Redactor from the immutable per-attempt Secret; `undefined` when the binding cannot be verified. */
export async function redactorFor(wf: Workflow, task: Task | undefined, target: LogTarget, container: string, deps: LogHttpDeps): Promise<SecretRedactor | undefined> {
  if (!task) return undefined;
  const pod = await (deps.getPod ?? getPod)(target.namespace, target.podName);
  if (!pod) return undefined;
  try { return new SecretRedactor(await (deps.secrets ?? injectedLogSecrets)(wf, { ...task, attempts: target.attempt }, pod as Pod, container)); }
  catch (error) { console.warn('[logs] redaction unavailable', { workflowId: wf.id, task: task?.name, pod: target.podName, error: String(error) }); return undefined; }
}

export async function taskLogResponse(req: Request, p: Session, workflowId: string, taskName: string, deps: LogHttpDeps = { repo: getRepo() }): Promise<Response> {
  try {
    const url = new URL(req.url);
    const wf = await authorizeLogs(p, workflowId, taskName, deps);
    const targets = await resolveTargets(wf, taskName, deps.listPods);
    const tasks = await deps.repo.listTasks(wf.id);
    const task = tasks.find(t => t.name === taskName);
    const want = { attempt: int(url.searchParams.get('attempt'), 'attempt'), member: int(url.searchParams.get('member'), 'member') };
    const target = pickTarget(targets, want);
    if (!target) {
      const snapshot: LogSnapshot = { source: 'none', reason: (task?.attempts ?? 0) > 0 ? 'pod-gone' : 'not-started', targets, lines: [], truncated: false, redaction: 'none' };
      return Response.json(snapshot, { headers: HEADERS });
    }
    const container = pickContainer(target, url.searchParams.get('container') ?? undefined);
    const tail = int(url.searchParams.get('tail'), 'tail');
    const sinceTime = sinceParam(req.headers.get('last-event-id') ?? url.searchParams.get('since'));
    const redactor = await redactorFor(wf, task, target, container, deps);
    if (!redactor && p.role !== 'admin') throw new HttpError(403, 'Secret redaction for this task cannot be verified; ask an administrator', 'log_redaction_unavailable');
    const redaction = redactor ? 'applied' : 'unavailable';
    const follow = url.searchParams.get('follow') === '1' && (req.headers.get('accept') ?? '').includes('text/event-stream');
    if (!follow) {
      const { lines, truncated } = await readLogs(target, container, { tail, sinceTime, redactor, read: deps.read });
      const snapshot: LogSnapshot = { source: 'kubernetes', phase: target.phase, target, container, targets, lines, truncated, redaction };
      return Response.json(snapshot, { headers: HEADERS });
    }
    const stop = new AbortController();
    const lines = followLogs(target, container, { tail, sinceTime, redactor, signal: stop.signal, open: deps.open });
    return sseResponse(lines, { lifetimeMs: deps.lifetimeMs ?? LIMITS.followMs, authMs: deps.authMs ?? 5000, stop, request: req.signal,
      reauth: async () => { await authorizeLogs(p, workflowId, taskName, deps); } });
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.message, code: error.code, details: error.details }, { status: error.status, headers: HEADERS });
    throw error;
  }
}

export function sseResponse(lines: AsyncIterable<LogLine>, opts: { lifetimeMs: number; authMs: number; stop: AbortController; request: AbortSignal; reauth: () => Promise<void> }): Response {
  const enc = new TextEncoder();
  let closed = false, reason: 'pod-ended' | 'timeout' = 'pod-ended', failure: HttpError | Error | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const finish = (why?: typeof reason) => { if (closed) return; if (why) reason = why; closed = true; opts.stop.abort(); };
      const deadline = setTimeout(() => finish('timeout'), opts.lifetimeMs);
      const auth = setInterval(() => { opts.reauth().catch(error => { failure = error; finish(); }); }, opts.authMs);
      opts.request.addEventListener('abort', () => finish(), { once: true });
      try {
        for await (const line of lines) {
          if (closed) break;
          controller.enqueue(enc.encode(`${line.ts ? `id: ${line.ts}\n` : ''}event: line\ndata: ${JSON.stringify(line)}\n\n`));
        }
        if (failure) controller.enqueue(enc.encode(`event: log-error\ndata: ${JSON.stringify({ error: 'Log stream stopped; authorization is no longer valid', code: failure instanceof HttpError ? failure.code : 'log_unavailable' })}\n\n`));
        else controller.enqueue(enc.encode(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`));
      } catch (error) {
        if (!opts.stop.signal.aborted) controller.enqueue(enc.encode(`event: log-error\ndata: ${JSON.stringify({ error: 'Log stream failed', code: error instanceof HttpError ? error.code : 'log_unavailable' })}\n\n`));
        else controller.enqueue(enc.encode(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`));
      } finally { clearTimeout(deadline); clearInterval(auth); closed = true; try { controller.close(); } catch { /* already closed */ } }
    },
    cancel() { closed = true; opts.stop.abort(); },
  });
  return new Response(body, { headers: { ...HEADERS, 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } });
}
