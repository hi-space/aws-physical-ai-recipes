import { createHash, randomBytes } from 'node:crypto';
import type { Session } from '../auth/session';
import { HttpError } from '../errors';
import { principalBinding } from './auth';
import { LIMITS, type LogDeps, type LogHead } from './types';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export async function issueCursor(head: LogHead, after: number, p: Session, deps: LogDeps) {
  const value = randomBytes(32).toString('base64url'), now = (deps.now ?? Date.now)();
  const expiresAt = Math.min(now + LIMITS.cursorMs, head.expiresAt);
  if (!(await deps.repo.kv.put({ pk: `LOG_CURSOR#${hash(value)}`, sk: 'META', streamId: head.id, after, principal: principalBinding(p), projectId: head.scope.projectId, workflowId: head.scope.workflowId, taskName: head.scope.taskName, expiresAt, ttl: Math.ceil(expiresAt / 1000) }, 'not_exists'))) throw new HttpError(503, 'Log cursor unavailable');
  return value;
}
export async function resolveCursor(value: string, p: Session, workflowId: string, taskName: string, deps: LogDeps) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError(400, 'Invalid log cursor', 'log_cursor_invalid');
  const r = await deps.repo.kv.get(`LOG_CURSOR#${hash(value)}`, 'META');
  if (!r || r.principal !== principalBinding(p) || r.workflowId !== workflowId || r.taskName !== taskName || typeof r.expiresAt !== 'number' || r.expiresAt <= (deps.now ?? Date.now)() || !Number.isSafeInteger(r.after) || Number(r.after) < 0) throw new HttpError(410, 'Log cursor expired or does not match this reader', 'log_cursor_invalid');
  return { streamId: String(r.streamId), after: Number(r.after), projectId: String(r.projectId) };
}
