import { route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { currentBackend } from '@/server/backends/context';
import { backendId } from '@/server/backends/registry';
import { LogArchive } from '@/server/logs/archive';
import { taskLogResponse } from '@/server/logs/http';
import { HttpError } from '@/server/errors';
import { retainedPodLogs } from '@/server/logs/retained';
export const dynamic = 'force-dynamic';
export const GET = route<{ ns: string; name: string }>('viewer', async ({ params, req, session }) => {
  const repo = getRepo(), archive = new LogArchive({ repo }), url = new URL(req.url);
  if (url.searchParams.get('source') === 'retained') return retainedPodLogs(session, params.ns, params.name, url, req.signal);
  let stream = url.searchParams.get('stream');
  if (!stream) {
    const rows = await repo.kv.query(`LOG_POD#${backendId(currentBackend()?.id)}#${params.ns}#${params.name}`, '', { limit: 257 });
    // Reused names cannot silently select another UID. Containers on one UID can use the main stream.
    const scopes = await Promise.all(rows.map(row => archive.head(String(row.id))));
    if (!scopes.length || rows.length > 256 || new Set(scopes.map(h => h.scope.podUid)).size !== 1) throw new HttpError(409, 'Select the workflow task log archive and exact Pod UID', 'log_source_required');
    const candidates = scopes.filter(h => !url.searchParams.has('container') || h.scope.container === url.searchParams.get('container'));
    stream = candidates.sort((a, b) => Number(b.scope.container === 'main') - Number(a.scope.container === 'main') || b.scope.restartCount - a.scope.restartCount || b.createdAt.localeCompare(a.createdAt))[0]?.id;
    if (!stream) throw new HttpError(404, 'Container log archive not found');
  }
  const head = await archive.head(stream);
  if (head.scope.namespace !== params.ns || head.scope.podName !== params.name || head.scope.backendId !== backendId(currentBackend()?.id)) throw new HttpError(403, 'Log source binding mismatch');
  url.searchParams.set('stream', stream); url.searchParams.set('podName', params.name);
  // Existing Jobs panel polls JSON with follow=1. EventSource explicitly accepts SSE.
  if (!req.headers.get('accept')?.includes('text/event-stream')) url.searchParams.delete('follow');
  return taskLogResponse(new Request(url, { headers: req.headers, signal: req.signal }), session, head.scope.workflowId, head.scope.taskName, { repo });
});
