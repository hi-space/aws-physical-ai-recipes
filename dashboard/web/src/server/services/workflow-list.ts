import { createHash } from 'node:crypto';
import { badRequest, forbidden, HttpError } from '../errors';
import { canReadResource, resolveProject } from '../auth/projects';
import type { Session } from '../auth/session';
import { getRepo, type Repo } from '../store/repo';
import type { Workflow } from '../store/types';

export interface WorkflowListOptions {
  projectId?: string; status?: string; owner?: string; namespace?: string; search?: string;
  cursor?: string; limit?: number;
  /** Server-side work budget, never supplied from public query parameters. */
  maxPages?: number; maxScanned?: number;
}
function decodeCursor(cursor: string | undefined, scope: string): string | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.scope !== scope || typeof value.inner !== 'string' || !value.inner || value.inner.length > 4096) throw new Error();
    return value.inner;
  } catch { throw badRequest('Invalid workflow cursor or changed filters; restart the search'); }
}

/** Discovery uses the GSI; matching and authorization use fresh primary records. */
export async function listMatchingWorkflows(session: Session, options: WorkflowListOptions = {}, repo: Repo = getRepo()) {
  if (session.tokenProjectId && options.projectId && session.tokenProjectId !== options.projectId) throw forbidden('Token is bound to another project');
  const filters = {
    projectId: options.projectId ?? session.tokenProjectId,
    status: options.status || undefined, owner: options.owner || undefined,
    namespace: options.namespace || undefined, search: options.search?.trim().toLowerCase() || undefined,
  };
  const limit = options.limit ?? 50, maxPages = options.maxPages ?? 100, maxScanned = options.maxScanned ?? 2000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isSafeInteger(maxScanned) || maxScanned < 1 || maxScanned > 10000) throw badRequest('Invalid workflow pagination limit');
  if (filters.status && !['PENDING','RUNNING','FINALIZING','SUCCEEDED','FAILED','CANCELLING','CANCELLED'].includes(filters.status)) throw badRequest('Invalid workflow status');
  const scope = createHash('sha256').update(JSON.stringify({ principal: session.subject ?? session.user, role: session.role, tokenProjectId: session.tokenProjectId, filters })).digest('hex');
  let inner = decodeCursor(options.cursor, scope), items: Workflow[] = [], pages = 0, scanned = 0, exhausted = false;
  if (filters.projectId) await resolveProject(session, filters.projectId, repo);
  const cursors = new Set(inner ? [inner] : []), ids = new Set<string>();
  const matches = (workflow: Workflow) => (!filters.projectId || workflow.projectId === filters.projectId)
    && (!filters.status || workflow.status === filters.status)
    && (!filters.owner || workflow.owner === filters.owner)
    && (!filters.namespace || workflow.namespace === filters.namespace)
    && (!filters.search || [workflow.name,workflow.id,workflow.owner].some(value => value.toLowerCase().includes(filters.search!)));
  const refresh = async (candidates: Workflow[]) => {
    const rows = await Promise.all(candidates.map(async candidate => {
      const current = await repo.getWorkflow(candidate.id);
      return current && current.id === candidate.id && matches(current) && await canReadResource(session,current,repo) ? current : undefined;
    }));
    return rows.filter((row): row is Workflow => row !== undefined);
  };
  for (;;) {
    if (items.length === limit || exhausted || pages >= maxPages || scanned >= maxScanned) {
      // Revalidate accumulated results, then refill any removed matches if budget remains.
      items = await refresh(items);
      if (filters.projectId) await resolveProject(session, filters.projectId, repo);
      if (items.length === limit || exhausted || pages >= maxPages || scanned >= maxScanned) break;
    }
    const fetchLimit = Math.min(limit - items.length, maxScanned - scanned);
    let page: Awaited<ReturnType<Repo['listWorkflowsPage']>>;
    try { page = await repo.listWorkflowsPage({ projectId: filters.projectId, limit: fetchLimit, cursor: inner }); }
    catch (error) { if (error instanceof Error && /invalid pagination cursor/i.test(error.message)) throw badRequest('Invalid workflow cursor'); throw error; }
    if (page.items.length > fetchLimit) throw new HttpError(502,'Workflow pagination returned more rows than requested');
    pages++; scanned += page.items.length; inner = page.cursor; exhausted = !inner;
    if (inner) { if (cursors.has(inner)) throw new HttpError(502,'Workflow pagination cursor did not advance'); cursors.add(inner); }
    for (const workflow of await refresh(page.items)) if (!ids.has(workflow.id)) { ids.add(workflow.id); items.push(workflow); }
  }
  const scanLimited = !exhausted && items.length < limit;
  return {
    items,
    cursor: inner ? Buffer.from(JSON.stringify({v:1,scope,inner})).toString('base64url') : undefined,
    scanned, pages, scanLimited, exhausted,
    message: scanLimited ? '검색하지 않은 이력이 남아 있습니다. 다음 페이지에서 계속 검색하세요.' : undefined,
  };
}
