import { route } from '@/server/api';
import { HttpError } from '@/server/errors';
import { assertNamespaceAccess } from '@/server/auth/projects';
import { getPod } from '@/server/k8s/resources';
import { getRepo } from '@/server/store/repo';
import { redactorFor, sinceParam, sseResponse } from '@/server/logs/http';
import { followLogs, pickContainer, readLogs, targetsFromPods } from '@/server/logs/stream';
import { LIMITS, type LogSnapshot } from '@/server/logs/types';
export const dynamic = 'force-dynamic';
const HEADERS = { 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' };
export const GET = route<{ ns: string; name: string }>('viewer', async ({ params, req, session }) => {
  await assertNamespaceAccess(session, params.ns);
  if (![params.ns, params.name].every(v => /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(v))) throw new HttpError(400, 'Invalid Pod identity');
  const url = new URL(req.url), pod = await getPod(params.ns, params.name);
  if (!pod) return Response.json({ source: 'none', reason: 'pod-gone', targets: [], lines: [], truncated: false, redaction: 'none' } satisfies LogSnapshot, { headers: HEADERS });
  const labels = pod.metadata.labels ?? {};
  const target = targetsFromPods([{ ...pod, metadata: { ...pod.metadata, labels: { 'pai.aws/attempt': '0', ...labels } } }])[0];
  const container = pickContainer(target, url.searchParams.get('container') ?? undefined);
  const tailRaw = url.searchParams.get('tail'), tail = tailRaw === null ? undefined : Number(tailRaw);
  const sinceTime = sinceParam(req.headers.get('last-event-id') ?? url.searchParams.get('since'));
  let redaction: LogSnapshot['redaction'] = 'none', redactor;
  if (labels['pai.aws/workflow-id'] && labels['pai.aws/task']) {
    const repo = getRepo(), wf = await repo.getWorkflow(labels['pai.aws/workflow-id']);
    const task = wf ? (await repo.listTasks(wf.id)).find(t => t.name === labels['pai.aws/task']) : undefined;
    redactor = wf ? await redactorFor(wf, task, target, container, { repo }) : undefined;
    redaction = redactor ? 'applied' : 'unavailable';
    if (!redactor && session.role !== 'admin') throw new HttpError(403, 'Secret redaction for this Pod cannot be verified; ask an administrator', 'log_redaction_unavailable');
  }
  if (url.searchParams.get('follow') === '1' && (req.headers.get('accept') ?? '').includes('text/event-stream')) {
    const stop = new AbortController();
    return sseResponse(followLogs(target, container, { tail, sinceTime, redactor, signal: stop.signal }),
      { lifetimeMs: LIMITS.followMs, authMs: 5000, stop, request: req.signal, reauth: () => assertNamespaceAccess(session, params.ns) });
  }
  const { lines, truncated } = await readLogs(target, container, { tail, sinceTime, redactor });
  return Response.json({ source: 'kubernetes', phase: pod.status?.phase, target, container, targets: [target], lines, truncated, redaction } satisfies LogSnapshot, { headers: HEADERS });
});
