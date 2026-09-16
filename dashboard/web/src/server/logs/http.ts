import type { Session } from '../auth/session';
import { HttpError } from '../errors';
import { getRepo } from '../store/repo';
import { LogArchive } from './archive';
import { authorizeLogs } from './auth';
import { issueCursor, resolveCursor } from './cursors';
import { LIMITS, type LogDeps, type LogHead, type LogRecord } from './types';
export interface ReplayPage {
  source: 'archive' | 'none'; stream?: LogHead; streams: LogHead[]; catalogTruncated: boolean;
  records: LogRecord[]; cursor?: string; hasMore: boolean; coverage: 'captured-only';
  /** Bounded legacy diagnostic summary; replay clients use records/cursor. */
  lines?: string[];
}
export interface LogHttpDeps extends LogDeps { pollMs?: number; authMs?: number; lifetimeMs?: number }
function numeric(url: URL, name: string) {
  const v = url.searchParams.get(name); if (v === null) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new HttpError(400, `Invalid log ${name}`);
  return Number(v);
}
function matches(h: LogHead, url: URL) {
  const s = h.scope, p = url.searchParams;
  return (!p.has('stream') || p.get('stream') === h.id) &&
    (!p.has('attempt') || numeric(url, 'attempt') === s.attempt) &&
    (!p.has('member') || numeric(url, 'member') === s.member) &&
    (!p.has('restartCount') || numeric(url, 'restartCount') === s.restartCount) &&
    ['container', 'podName', 'podUid'].every(key => !p.has(key) || p.get(key) === s[key as 'container']) &&
    (!p.has('pod') || p.get('pod') === s.podName);
}
export async function readTaskLogs(p: Session, wf: string, task: string, url: URL, deps: LogDeps): Promise<ReplayPage> {
  await authorizeLogs(p, wf, task, deps);
  const archive = new LogArchive(deps), cursor = url.searchParams.get('cursor');
  const catalog = await archive.list(wf, task, numeric(url, 'attempt'));
  let stream: LogHead | undefined, after = 0;
  if (cursor) {
    const position = await resolveCursor(cursor, p, wf, task, deps);
    stream = await archive.head(position.streamId); after = position.after;
    if (position.projectId !== stream.scope.projectId || !matches(stream, url)) throw new HttpError(409, 'Log cursor and source selection differ', 'log_cursor_scope');
  } else if (url.searchParams.has('stream')) {
    stream = await archive.head(url.searchParams.get('stream')!);
    if (!matches(stream, url)) throw new HttpError(409, 'Log source selection differs', 'log_cursor_scope');
  } else {
    stream = catalog.streams.filter(h => matches(h, url)).sort((a, b) => b.scope.attempt - a.scope.attempt || a.scope.member - b.scope.member ||
      Number(b.scope.container === 'main') - Number(a.scope.container === 'main') || b.createdAt.localeCompare(a.createdAt) || b.scope.restartCount - a.scope.restartCount)[0];
  }
  const base = { streams: catalog.streams, catalogTruncated: catalog.truncated, coverage: 'captured-only' as const };
  if (!stream) return { ...base, source: 'none', records: [], hasMore: false, ...(url.searchParams.has('tail') ? { lines: [] } : {}) };
  await authorizeLogs(p, wf, task, deps, stream.scope);
  const start = url.searchParams.get('start') ?? 'tail';
  if (!['tail', 'beginning'].includes(start)) throw new HttpError(400, 'Invalid log replay start');
  if (!cursor && start === 'tail') after = await archive.tailStart(stream.id);
  const page = await archive.read(stream.id, after, numeric(url, 'maxBytes') ?? LIMITS.page);
  // Recheck after storage reads, before exposing any bytes or minting a cursor.
  await authorizeLogs(p, wf, task, deps, stream.scope);
  return { ...base, source: 'archive', stream: page.stream, records: page.records, hasMore: page.hasMore,
    ...(url.searchParams.has('tail') ? { lines: Buffer.concat(page.records.filter(r => r.kind === 'data').map(r => Buffer.from(r.data!, 'base64')))
      .toString('utf8').split('\n').slice(-Math.max(1, Math.min(numeric(url, 'tail') ?? 1000, 10_000))) } : {}),
    cursor: await issueCursor(page.stream, page.nextSequence, p, deps) };
}
export async function taskLogResponse(req: Request, p: Session, wf: string, task: string, deps: LogHttpDeps = { repo: getRepo() }): Promise<Response> {
  const url = new URL(req.url), last = req.headers.get('last-event-id');
  if (last) url.searchParams.set('cursor', last); // Browser reconnect advances beyond initial query cursor.
  let page = await readTaskLogs(p, wf, task, url, deps);
  const headers = { 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' };
  if (url.searchParams.get('follow') !== '1') return Response.json(page, { headers });
  const stop = new AbortController(), enc = new TextEncoder();
  let closed = false, first = true, checking = false;
  let finish = () => {};
  const onAbort = () => finish();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const auth = setInterval(async () => {
        if (checking || closed) return;
        checking = true;
        try { await authorizeLogs(p, wf, task, deps, page.stream?.scope); }
        catch { finish(); }
        finally { checking = false; }
      }, deps.authMs ?? 5000);
      const deadline = setTimeout(() => finish(), deps.lifetimeMs ?? 55_000);
      finish = () => {
        if (closed) return;
        closed = true; stop.abort(); clearInterval(auth); clearTimeout(deadline);
        req.signal.removeEventListener('abort', onAbort);
        try { controller.close(); } catch { /* consumer cancellation already closed the stream */ }
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
      if (req.signal.aborted) finish();
    },
    async pull(controller) {
      try {
        if (!first) {
          if (!page.hasMore) await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, deps.pollMs ?? 1000);
            stop.signal.addEventListener('abort', done, { once: true });
            if (stop.signal.aborted) done();
          });
          if (closed) return;
          if (page.cursor) url.searchParams.set('cursor', page.cursor);
          page = await readTaskLogs(p, wf, task, url, deps);
        } else {
          await authorizeLogs(p, wf, task, deps, page.stream?.scope);
        }
        first = false;
        if (closed) return;
        const end = !!page.stream && page.stream.state !== 'open' && !page.hasMore;
        // One bounded page per downstream pull. No unbounded background enqueue loop.
        controller.enqueue(enc.encode(`${page.cursor ? `id: ${page.cursor}\n` : ''}event: ${end ? 'end' : 'page'}\ndata: ${JSON.stringify(page)}\n\n`));
        if (end) finish();
      } catch (error) {
        if (closed) return;
        controller.enqueue(enc.encode(`event: log-error\ndata: ${JSON.stringify({ error: 'Log replay stopped; renew authorization or select an archive again', code: error instanceof HttpError ? error.code : 'log_unavailable' })}\n\n`));
        finish();
      }
    },
    cancel() { finish(); },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { ...headers, 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } });
}
