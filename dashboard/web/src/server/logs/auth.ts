import { createHash } from 'node:crypto';
import type { Session } from '../auth/session';
import { API_SCOPES } from '../auth/api-tokens';
import { projectRoleFromGroups, roleFromGroups } from '../auth/rbac';
import { projectFromItem } from '../auth/projects';
import { currentUserAuthorization } from '../aws/cognito';
import { HttpError } from '../errors';
import { backendId } from '../backends/registry';
import type { Item } from '../store/dynamo';
import type { LogDeps } from './types';
const fail = () => new HttpError(403, 'Log access is no longer authorized', 'log_forbidden');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function token(item: Item | undefined, p: Session, projectId: string, now: number) {
  if (!item || item.id !== p.tokenId || item.projectId !== projectId || item.ownerSubject !== p.subject || item.revokedAt ||
    typeof item.ownerUsername !== 'string' || !item.ownerUsername || typeof item.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.tokenHash) ||
    typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= now ||
    !['viewer', 'researcher'].includes(String(item.roleCeiling)) || !Array.isArray(item.scopes) || !item.scopes.includes('workflows:read') || item.scopes.some(scope => !API_SCOPES.includes(scope))) throw fail();
  return item;
}
function stamp(item: Item) { return JSON.stringify([item.id, item.projectId, item.ownerSubject, item.ownerUsername, item.tokenHash, item.expiresAt, item.revokedAt, item.roleCeiling, item.revision, item.scopes]); }
export async function authorizeLogs(p: Session, workflowId: string, taskName: string, deps: LogDeps) {
  if (!p.subject || !['viewer', 'researcher', 'admin'].includes(p.role)) throw fail();
  const wf = await deps.repo.getWorkflow(workflowId);
  if (!wf?.projectId) throw new HttpError(404, 'Project workflow not found');
  const task = wf.spec.workflow.tasks.find(t => t.name === taskName);
  if (!task) throw new HttpError(404, 'Workflow task not found');
  const now = deps.now ?? Date.now;
  const marked = p.authMethod === 'token' || p.tokenId !== undefined || p.tokenProjectId !== undefined;
  let record: Item | undefined, ownerKey: string | undefined;
  if (marked) {
    if (p.authMethod !== 'token' || !p.tokenId || !/^[a-f0-9]{32}$/.test(p.tokenId) || p.tokenProjectId !== wf.projectId || p.role === 'admin' || !p.scopes?.includes('workflows:read')) throw fail();
    ownerKey = `TOKEN#${hash(p.subject)}#${p.tokenId}`;
    record = token(await deps.repo.kv.get(`PROJECT#${wf.projectId}`, ownerKey), p, wf.projectId, now());
    const copy = token(await deps.repo.kv.get(`API_TOKEN#${record.tokenHash}`, 'META'), p, wf.projectId, now());
    if (stamp(copy) !== stamp(record)) throw fail();
  }
  let user;
  try { user = await (deps.currentUser ?? currentUserAuthorization)(String(record?.ownerUsername ?? p.user)); }
  catch { throw new HttpError(503, 'Current log authorization is unavailable', 'log_auth_unavailable'); }
  if (!user.enabled || user.subject !== p.subject || !user.username || !Array.isArray(user.groups)) throw fail();
  const projectItem = await deps.repo.kv.get(`PROJECT#${wf.projectId}`, 'META');
  const project = projectItem ? projectFromItem(projectItem) : undefined;
  const membership = projectRoleFromGroups(user.groups, wf.projectId);
  const actualAdmin = !marked && p.role === 'admin' && roleFromGroups(user.groups) === 'admin';
  if (!project || project.namespace !== wf.namespace || backendId(project.backendId) !== backendId(wf.backendId) ||
    project.backendConfigHash !== wf.backendConfigHash || !actualAdmin && !membership) throw fail();
  if (record) {
    const [owner, copy] = await Promise.all([deps.repo.kv.get(`PROJECT#${wf.projectId}`, ownerKey!), deps.repo.kv.get(`API_TOKEN#${record.tokenHash}`, 'META')]);
    if (stamp(token(owner, p, wf.projectId, now())) !== stamp(record) || stamp(token(copy, p, wf.projectId, now())) !== stamp(record)) throw fail();
  }
  return wf;
}
