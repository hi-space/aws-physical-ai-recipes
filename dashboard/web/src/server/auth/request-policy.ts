import type { NextRequest } from 'next/server';
import { forbidden } from '../errors';
import { getRepo } from '../store/repo';
import { assertNamespaceAccess, assertResourceAccess, requestProject } from './projects';
import type { Session } from './session';

/**
 * All routes share this resource lookup before their handler runs, including
 * streaming and proxy routes. Route-local mutation checks remain in place.
 */
export async function authorizeApiResource(req: NextRequest, session: Session) {
  const path = req.nextUrl.pathname.replace(/^\/api\/v1\//, '/api/');
  const repo = getRepo();
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const workflow = /^\/api\/workflows\/([^/]+)/.exec(path)?.[1];
  if (workflow && !['validate', 'bulk-cancel'].includes(workflow)) {
    await assertResourceAccess(session, await repo.getWorkflow(decodeURIComponent(workflow)), 'workflow', write);
  }
  const dataset = /^\/api\/datasets\/([^/]+)/.exec(path)?.[1];
  if (dataset) await assertResourceAccess(session, await repo.getDataset(decodeURIComponent(dataset)), 'dataset', write);
  const sessionId = /^\/api\/sessions\/([^/]+)/.exec(path)?.[1];
  if (sessionId && !['dcv', 'connect'].includes(sessionId)) {
    await assertResourceAccess(session, await repo.getSession(decodeURIComponent(sessionId)), 'session', write);
  }
  const ns = /^\/api\/k8s\/(?:jobs|pods)\/([^/]+)/.exec(path)?.[1];
  if (ns) await assertNamespaceAccess(session, decodeURIComponent(ns), req.method !== 'GET');
  if (session.role !== 'admin' && ['/api/k8s/jobs', '/api/k8s/events'].includes(path)) {
    const project = await requestProject(req, session);
    const requested = req.nextUrl.searchParams.get('ns') ?? req.nextUrl.searchParams.get('namespace');
    if (requested && requested !== project.namespace) throw forbidden('No access to this project namespace');
    req.nextUrl.searchParams.set('ns', project.namespace);
    req.nextUrl.searchParams.set('namespace', project.namespace);
  }
}

export function assertSameOrigin(req: Request, expectedOrigin: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.get('origin');
  // Browser cookies must never authorize a cross-site mutation. CLI tokens use
  // a separate authenticated endpoint rather than bypassing this check.
  if (!origin || origin !== expectedOrigin) throw forbidden('A same-origin request is required');
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw forbidden('Cross-site mutation is not allowed');
}
