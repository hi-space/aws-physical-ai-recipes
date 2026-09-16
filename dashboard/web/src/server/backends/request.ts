import type { NextRequest } from 'next/server';
import type { Session } from '../auth/session';
import { assertResourceAccess, requestProject } from '../auth/projects';
import { forbidden, notFound } from '../errors';
import { getRepo } from '../store/repo';
import { runOnBackend } from './context';
import { backendId, DEFAULT_BACKEND } from './registry';
import { assertWorkflowBackend } from './binding';

export async function withRequestBackend<T>(req: NextRequest, session: Session, operation: () => Promise<T>): Promise<T> {
  const path = req.nextUrl.pathname.replace(/^\/api\/v1\//, '/api/');
  const repo = getRepo();
  const wfId = /^\/api\/workflows\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  if (wfId && !['validate', 'bulk-cancel'].includes(wfId)) {
    // Ledger-only reads remain available even while an external backend is unavailable.
    if (req.method === 'GET' && !/\/events$|\/tasks\/[^/]+\/logs$/.test(path)) return operation();
    const wf = await repo.getWorkflow(decodeURIComponent(wfId));
    await assertResourceAccess(session, wf, 'workflow', req.method !== 'GET');
    if (!wf) throw notFound('workflow');
    await assertWorkflowBackend(wf, repo);
    return runOnBackend(wf, operation, repo, () => new Date(), req.method === 'GET' || req.method === 'DELETE' || path.endsWith('/cancel') ? 'observe' : 'execute');
  }
  const sid = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  if (sid && !['dcv', 'connect'].includes(sid)) {
    const s = await repo.getSession(decodeURIComponent(sid));
    await assertResourceAccess(session, s, 'session', req.method !== 'GET');
    if (!s) throw notFound('session');
    if (s.kind === 'dcv') return operation();
    await assertWorkflowBackend(s, repo);
    return runOnBackend(s, operation, repo, () => new Date(), req.method === 'DELETE' ? 'observe' : 'execute');
  }
  const dataset = /^\/api\/datasets\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  if (dataset) {
    const record = await repo.getDataset(decodeURIComponent(dataset));
    await assertResourceAccess(session, record, 'dataset', req.method !== 'GET');
    const project = record?.projectId ? await repo.kv.get(`PROJECT#${record.projectId}`, 'META') : undefined;
    if (record?.projectId && !project) throw notFound('project');
    return runOnBackend({ backendId: project?.backendId as string | undefined, backendConfigHash: project?.backendConfigHash as string | undefined }, operation, repo, () => new Date(), 'observe');
  }
  if (!/^\/api\/(?:k8s(?:\/|$)|queues$|quotas$|fsx(?:\/|$)|s3(?:\/|$)|clusters(?:\/|$)|metrics\/query$|overview$|image-profiles\/preflight$|workflows\/validate$)/.test(path) &&
    !(req.method === 'POST' && ['/api/workflows', '/api/sessions', '/api/sessions/connect'].includes(path))) return operation();
  const selected = session.tokenProjectId || req.headers.get('x-pai-project') || /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const project = selected || session.role !== 'admin' ? await requestProject(req, session) : undefined;
  const requested = req.nextUrl.searchParams.get('backendId') ?? undefined;
  if (requested && project && requested !== backendId(project.backendId) || requested && !project && session.role !== 'admin') throw forbidden('Backend is bound to the selected project');
  return runOnBackend(project ?? { backendId: requested ?? DEFAULT_BACKEND }, operation, repo);
}
