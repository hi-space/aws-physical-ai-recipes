import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../errors';
import type { AuthContext } from './ledger';
import { RUNTIME_LIMITS } from './limits';

export interface PlanPage { pageSize: number; cursor?: string }
export function parsePlanPage(url: URL): PlanPage | undefined {
  if (!url.searchParams.has('pageSize') && !url.searchParams.has('cursor')) return;
  const size = url.searchParams.get('pageSize') ?? '';
  if (!/^[1-9][0-9]*$/.test(size) || Number(size) > RUNTIME_LIMITS.pageFiles ||
    url.searchParams.getAll('pageSize').length !== 1 || url.searchParams.getAll('cursor').length > 1) {
    throw new HttpError(400, 'Invalid runtime plan pagination');
  }
  return { pageSize: Number(size), cursor: url.searchParams.get('cursor') ?? undefined };
}
/** Cursor binds all immutable metadata and the task/epoch; signed URLs are added
 * only after selection. Every aggregate limit is checked before returning page 1. */
export function selectPlanPage<G extends { files: unknown[] }>(
  groups: G[], context: AuthContext, signingKey: string, kind: string, query?: PlanPage,
) {
  const total = groups.reduce((count, group) => count + group.files.length, 0);
  if (groups.length > RUNTIME_LIMITS.groups || (query && total > RUNTIME_LIMITS.files) ||
    Buffer.byteLength(JSON.stringify(groups)) > RUNTIME_LIMITS.responseBytes) {
    throw new HttpError(409, 'Runtime plan exceeds supported group/file/metadata admission limits');
  }
  if (!query) return { groups, nextCursor: undefined };
  const c = context.claims;
  const fingerprint = createHash('sha256').update(JSON.stringify({
    kind, workflowId: c.workflowId, projectId: c.projectId, namespace: c.namespace,
    task: c.task, attempt: c.attempt, epoch: c.epoch, backendId: c.backendId, groups,
  })).digest('hex');
  const mac = (body: string) => createHmac('sha256', signingKey).update(`runtime-plan-v2:${body}`).digest();
  let offset = 0;
  if (query.cursor) {
    if (query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(query.cursor)) throw new HttpError(400, 'Invalid runtime plan cursor');
    const [body, signature] = query.cursor.split('.');
    const expected = mac(body), supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new HttpError(400, 'Invalid runtime plan cursor signature');
    let decoded: { fingerprint?: string; offset?: number };
    try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString()); }
    catch { throw new HttpError(400, 'Malformed runtime plan cursor'); }
    if (decoded.fingerprint !== fingerprint) throw new HttpError(409, 'Runtime plan identity changed between pages');
    if (!Number.isSafeInteger(decoded.offset) || decoded.offset! <= 0 || decoded.offset! >= total) throw new HttpError(400, 'Invalid runtime plan cursor offset');
    offset = decoded.offset!;
  }
  const stop = Math.min(total, offset + query.pageSize);
  let visited = 0;
  const selected: G[] = [];
  for (const group of groups) {
    const start = Math.max(0, offset - visited), end = Math.min(group.files.length, stop - visited);
    if (end > start) selected.push({ ...group, files: group.files.slice(start, end) });
    visited += group.files.length;
  }
  let nextCursor: string | undefined;
  if (stop < total) {
    const body = Buffer.from(JSON.stringify({ fingerprint, offset: stop })).toString('base64url');
    nextCursor = `${body}.${mac(body).toString('base64url')}`;
  }
  return { groups: selected, nextCursor };
}
