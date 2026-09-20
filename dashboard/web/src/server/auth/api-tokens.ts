import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { currentUserAuthorization, type CurrentUserAuthorization } from '../aws/cognito';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../errors';
import { getRepo } from '../store/repo';
import type { KV, Item } from '../store/dynamo';
import type { Project } from './projects';
import type { Session } from './session';
import { projectRoleFromGroups, roleFromGroups, type ProjectRole } from './rbac';

export const API_SCOPES = ['workflows:read', 'workflows:write', 'datasets:read', 'datasets:write', 'sessions:read', 'sessions:write', 'models:read', 'metrics:read'] as const;
export type ApiScope = typeof API_SCOPES[number];
export interface TokenSession extends Session {
  subject: string; role: 'viewer' | 'researcher'; groups: string[]; tokenProjectId: string; authMethod: 'token'; scopes: ApiScope[]; tokenId: string;
}
export type TokenPrincipal = Session & { authMethod?: string; tokenProjectId?: string };
export interface ApiTokenMetadata {
  id: string; projectId: string; name: string; ownerSubject: string; ownerUsername: string;
  scopes: ApiScope[]; createdAt: string; expiresAt: string; revokedAt?: string;
}
interface StoredToken extends ApiTokenMetadata { tokenHash: string; roleCeiling: 'viewer' | 'researcher'; revision: number }
export interface ApiTokenDeps {
  kv: KV; now(): number; randomToken(): string; randomId(): string;
  currentUser(username: string): Promise<CurrentUserAuthorization>;
}
export const apiTokenInputSchema = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(z.enum(API_SCOPES)).min(1).max(8), expiresInDays: z.number().int().min(1).max(30).default(7) }).strict();
const tokenPattern = /^pai_[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenKey = (digest: string) => ({ pk: `API_TOKEN#${digest}`, sk: 'META' });
const ownerKey = (projectId: string, subject: string, id: string) => ({ pk: `PROJECT#${projectId}`, sk: `TOKEN#${hash(subject)}#${id}` });
const unavailable = () => new HttpError(503, '토큰 권한을 확인할 수 없습니다. 다시 시도하세요.', 'token_unavailable');
const invalid = () => unauthorized('API 토큰이 유효하지 않거나 만료·폐기되었습니다.');
function defaults(): ApiTokenDeps {
  return { kv: getRepo().kv, now: Date.now, randomToken: () => `pai_${randomBytes(32).toString('base64url')}`, randomId: () => randomBytes(16).toString('hex'), currentUser: currentUserAuthorization };
}
function interactive(principal: TokenPrincipal) {
  if (!principal.subject || principal.authMethod === 'token' || principal.tokenProjectId) throw forbidden('브라우저 로그인으로 본인의 API 토큰을 관리하세요.');
}
export function assertBrowserManagementRequest(req: Request): void {
  if (req.headers.has('authorization') || req.headers.get('x-pai-auth-method') === 'token') {
    throw forbidden('이 작업은 브라우저 로그인으로만 사용할 수 있습니다.');
  }
}
function projectMembership(groups: readonly string[] | undefined, projectId: string): ProjectRole {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(projectId)) throw forbidden();
  const role = projectRoleFromGroups(groups, projectId);
  if (!role) throw forbidden('현재 프로젝트 멤버십이 필요합니다.');
  return role;
}
async function assertProjectExists(projectId: string, deps: ApiTokenDeps) {
  if (!(await deps.kv.get(`PROJECT#${projectId}`, 'META'))) throw forbidden('현재 프로젝트 멤버십이 필요합니다.');
}
async function current(username: string, subject: string, deps: ApiTokenDeps) {
  let user: CurrentUserAuthorization;
  try { user = await deps.currentUser(username); } catch { throw unavailable(); }
  if (!user.enabled || !user.username || user.subject !== subject || !Array.isArray(user.groups)) throw invalid();
  return user;
}
function effectiveRole(user: CurrentUserAuthorization, membership: ProjectRole): 'viewer' | 'researcher' {
  return roleFromGroups(user.groups) === 'viewer' || membership === 'viewer' ? 'viewer' : 'researcher';
}
function publicMetadata(record: StoredToken): ApiTokenMetadata {
  return { id: record.id, projectId: record.projectId, name: record.name, ownerSubject: record.ownerSubject, ownerUsername: record.ownerUsername,
    scopes: [...record.scopes], createdAt: record.createdAt, expiresAt: record.expiresAt, ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}) };
}
function storedToken(item: Item): StoredToken {
  const { pk: _pk, sk: _sk, ttl: _ttl, ...record } = item;
  return record as unknown as StoredToken;
}
function validateStored(item: Item | undefined, digest: string, now: number): StoredToken {
  const record = item ? storedToken(item) : undefined;
  if (!record || record.tokenHash !== digest || record.revokedAt || !record.ownerSubject || !record.ownerUsername ||
    !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now ||
    !Number.isFinite(Date.parse(record.createdAt)) || Date.parse(record.expiresAt) - Date.parse(record.createdAt) > 30 * 86400_000 ||
    !['viewer', 'researcher'].includes(record.roleCeiling) || !Array.isArray(record.scopes) || !record.scopes.length || record.scopes.some((scope) => !API_SCOPES.includes(scope))) throw invalid();
  return record;
}
export async function createApiToken(principal: TokenPrincipal, project: Project, input: z.input<typeof apiTokenInputSchema>, deps = defaults()) {
  interactive(principal);
  const parsed = apiTokenInputSchema.safeParse(input);
  if (!parsed.success) throw badRequest('토큰 이름, 범위 및 만료 기간(1–30일)을 확인하세요.');
  await assertProjectExists(project.id, deps);
  const user = await current(principal.user, principal.subject!, deps);
  const membership = projectMembership(user.groups, project.id);
  const roleCeiling = effectiveRole(user, membership);
  const scopes = [...new Set(parsed.data.scopes)];
  if (roleCeiling === 'viewer' && scopes.some((scope) => scope.endsWith(':write'))) throw forbidden('현재 권한으로 쓰기 범위 토큰을 만들 수 없습니다.');
  const token = deps.randomToken(), id = deps.randomId();
  if (!tokenPattern.test(token) || Buffer.from(token.slice(4), 'base64url').length !== 32 || !/^[a-f0-9]{32}$/.test(id)) throw unavailable();
  const now = deps.now();
  const record: StoredToken = { id, projectId: project.id, name: parsed.data.name, ownerSubject: principal.subject!, ownerUsername: user.username,
    scopes, roleCeiling, tokenHash: hash(token), revision: 0, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + parsed.data.expiresInDays * 86400_000).toISOString() };
  if (!(await deps.kv.transaction([
    { kind: 'put', item: { ...tokenKey(record.tokenHash), ...record, ttl: Math.floor(Date.parse(record.expiresAt) / 1000) }, condition: { absent: true } },
    { kind: 'put', item: { ...ownerKey(project.id, record.ownerSubject, id), ...record }, condition: { absent: true } },
  ]))) throw new HttpError(409, '토큰 생성이 충돌했습니다. 다시 시도하세요.', 'token_conflict');
  return { token, metadata: publicMetadata(record) };
}
export async function listApiTokens(principal: TokenPrincipal, project: Project, deps = defaults()): Promise<ApiTokenMetadata[]> {
  interactive(principal); await assertProjectExists(project.id, deps); projectMembership(principal.groups, project.id);
  return (await deps.kv.query(`PROJECT#${project.id}`, `TOKEN#${hash(principal.subject!)}#`))
    .map((item) => item as unknown as StoredToken).filter((record) => record.ownerSubject === principal.subject && record.projectId === project.id).map(publicMetadata);
}
export async function revokeApiToken(principal: TokenPrincipal, project: Project, id: string, deps = defaults()): Promise<void> {
  interactive(principal); await assertProjectExists(project.id, deps); projectMembership(principal.groups, project.id);
  if (!/^[a-f0-9]{32}$/.test(id)) throw notFound('토큰');
  const owner = ownerKey(project.id, principal.subject!, id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await deps.kv.get(owner.pk, owner.sk);
    const record = item ? storedToken(item) : undefined;
    if (!record || record.ownerSubject !== principal.subject || record.projectId !== project.id) throw notFound('토큰');
    if (record.revokedAt) return;
    const revised = { ...record, revokedAt: new Date(deps.now()).toISOString(), revision: record.revision + 1 };
    // An expired digest may already be removed by TTL; the owner index remains for history.
    const digestRecord = await deps.kv.get(tokenKey(record.tokenHash).pk, 'META');
    if (await deps.kv.transaction([
      { kind: 'put', item: { ...owner, ...revised }, condition: { equals: { revision: record.revision } } },
      ...(digestRecord ? [{ kind: 'put' as const, item: { ...tokenKey(record.tokenHash), ...revised, ttl: Math.floor(Date.parse(record.expiresAt) / 1000) }, condition: { equals: { revision: record.revision } } }] : []),
    ])) return;
  }
  throw new HttpError(409, '토큰 상태가 변경되었습니다. 다시 조회하세요.', 'token_conflict');
}
interface Permission { scope?: ApiScope; write: boolean; resource?: { family: 'WF' | 'DS' | 'SESS' | 'MODEL'; id: string } }
function permission(method: string, path: string): Permission {
  if (!/^(GET|HEAD|POST|PATCH|DELETE)$/.test(method) || !path.startsWith('/api/') || /[%?#\\\s\x00-\x1f]/.test(path) || path.includes('//') || path.split('/').some((part) => part === '.' || part === '..')) throw forbidden('토큰으로 지원하지 않는 API입니다.');
  const read = method === 'GET' || method === 'HEAD';
  if (read && path === '/api/me') return { write: false };
  if (method === 'POST' && path === '/api/metrics/query') return { scope: 'metrics:read', write: false };
  if (path === '/api/workflows' && (read || method === 'POST')) return { scope: read ? 'workflows:read' : 'workflows:write', write: !read };
  if (method === 'POST' && path === '/api/workflows/validate') return { scope: 'workflows:write', write: true };
  let match = /^\/api\/workflows\/([a-z0-9][a-z0-9-]{0,62})(?:\/(events|export|metrics|cancel|retry|tasks\/[a-z0-9][a-z0-9-]{0,62}\/logs))?$/.exec(path);
  if (match && !['validate', 'bulk-cancel'].includes(match[1]) && (read && (!match[2] || ['events', 'export', 'metrics'].includes(match[2]) || match[2].endsWith('/logs')) || method === 'POST' && ['cancel', 'retry'].includes(match[2]) || method === 'DELETE' && !match[2])) {
    return { scope: match[2] === 'metrics' ? 'metrics:read' : read ? 'workflows:read' : 'workflows:write', write: !read, resource: { family: 'WF', id: match[1] } };
  }
  if (path === '/api/datasets' && (read || method === 'POST')) return { scope: read ? 'datasets:read' : 'datasets:write', write: !read };
  match = /^\/api\/datasets\/([a-z0-9][a-z0-9-]{0,199})(?:\/(versions(?:\/[1-9][0-9]*)?|upload-url))?$/.exec(path);
  if (match && (read && match[2] !== 'upload-url' || method === 'POST' && !!match[2] || method === 'DELETE' && !match[2])) return { scope: read ? 'datasets:read' : 'datasets:write', write: !read, resource: { family: 'DS', id: match[1] } };
  if (path === '/api/sessions' && (read || method === 'POST')) return { scope: read ? 'sessions:read' : 'sessions:write', write: !read };
  if (read && path === '/api/sessions/connect') return { scope: 'sessions:read', write: false };
  match = /^\/api\/sessions\/([a-z0-9][a-z0-9-]{0,62})(?:\/(launch))?$/.exec(path);
  if (match && !['dcv', 'connect'].includes(match[1]) && (read && !match[2] || method === 'POST' && match[2] === 'launch' || ['PATCH', 'DELETE'].includes(method) && !match[2])) return { scope: read ? 'sessions:read' : 'sessions:write', write: !read, resource: { family: 'SESS', id: match[1] } };
  if (read && path === '/api/models') return { scope: 'models:read', write: false };
  match = /^\/api\/models\/([a-z0-9-]{1,100})$/.exec(path);
  if (read && match && !['legacy', 'outputs'].includes(match[1])) return { scope: 'models:read', write: false, resource: { family: 'MODEL', id: match[1] } };
  throw forbidden('토큰으로 지원하지 않는 API입니다.');
}
export async function verifyApiToken(token: string, method: string, canonicalApiPath: string, deps = defaults()): Promise<TokenSession> {
  try {
    const allowed = permission(method, canonicalApiPath);
    if (!tokenPattern.test(token)) throw invalid();
    const digest = hash(token), key = tokenKey(digest);
    const record = validateStored(await deps.kv.get(key.pk, key.sk), digest, deps.now());
    if (allowed.scope && !record.scopes.includes(allowed.scope)) throw forbidden('이 API 범위가 없는 토큰입니다.');
    await assertProjectExists(record.projectId, deps);
    const user = await current(record.ownerUsername, record.ownerSubject, deps);
    const membership = projectMembership(user.groups, record.projectId);
    const role = record.roleCeiling === 'viewer' ? 'viewer' : effectiveRole(user, membership);
    if (allowed.write && role !== 'researcher') throw forbidden('현재 사용자 또는 프로젝트 권한이 읽기 전용입니다.');
    if (allowed.resource) {
      const { family, id } = allowed.resource;
      const resource = await deps.kv.get(family === 'MODEL' ? `MODEL#${record.projectId}#${id}` : `${family}#${id}`, 'META');
      if (!resource || resource.projectId !== record.projectId) throw forbidden('토큰 프로젝트 밖의 리소스입니다.');
    }
    validateStored(await deps.kv.get(key.pk, key.sk), digest, deps.now());
    return { user: user.username, subject: user.subject, email: user.email, role, groups: user.groups, tokenProjectId: record.projectId, authMethod: 'token',
      scopes: record.scopes.filter((scope) => role !== 'viewer' || !scope.endsWith(':write')), tokenId: record.id };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
