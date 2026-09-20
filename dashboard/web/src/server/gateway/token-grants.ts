import { createHash } from 'node:crypto';
import { API_SCOPES, type ApiTokenMetadata } from '../auth/api-tokens';
import { projectRoleFromGroups, roleFromGroups } from '../auth/rbac';
import { projectFromItem } from '../auth/projects';
import { currentUserAuthorization } from '../aws/cognito';
import { getRepo } from '../store/repo';
import type { Item } from '../store/dynamo';
import { GatewayError, type AuthOptions, type DerivedTokenBinding } from './types';

interface TokenSource extends ApiTokenMetadata {
  tokenHash: string;
  roleCeiling: 'viewer' | 'researcher';
  revision: number;
}
export interface GatewayPrincipal {
  subject?: string;
  user?: string;
  role?: string;
  authMethod?: string;
  tokenId?: string;
  tokenProjectId?: string;
  scopes?: string[];
}
export interface TokenBoundSession {
  ownerSubject?: string;
  projectId?: string;
  namespace?: string;
  expiresAt?: string;
  authMethod?: string;
  tokenId?: string;
  tokenProjectId?: string;
  tokenRole?: string;
  tokenExpiresAt?: string;
}
const tokenKeys = ['authMethod', 'tokenId', 'tokenProjectId', 'tokenRole', 'tokenExpiresAt'] as const;
const invalid = () => new GatewayError(401, 'Derived token session authorization expired or invalid');
const forbidden = () => new GatewayError(403, 'Token authority does not match this session');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

export function hasTokenBinding(s: TokenBoundSession): boolean {
  return s.authMethod === 'token' || tokenKeys.slice(1).some((key) => s[key] !== undefined);
}
function markedPrincipal(p: GatewayPrincipal): boolean {
  return p.authMethod === 'token' || p.tokenId !== undefined || p.tokenProjectId !== undefined;
}
export function assertTokenRequestProject(p: GatewayPrincipal, projectId: string | undefined, write = true): void {
  if (!markedPrincipal(p)) return;
  if (p.authMethod !== 'token' || !p.subject || !p.tokenId || !/^[a-f0-9]{32}$/.test(p.tokenId) ||
    !projectId || p.tokenProjectId !== projectId || !['viewer', 'researcher'].includes(p.role ?? '') ||
    write && p.role !== 'researcher' || !p.scopes?.includes(write ? 'sessions:write' : 'sessions:read')) throw forbidden();
}
export function assertTokenLaunchPrincipal(s: TokenBoundSession, p: GatewayPrincipal): void {
  assertTokenRequestProject(p, s.projectId);
  if (markedPrincipal(p) && (!hasTokenBinding(s) || s.authMethod !== 'token' ||
    s.tokenId !== p.tokenId || s.tokenProjectId !== p.tokenProjectId || s.tokenRole !== p.role)) throw forbidden();
}

function sourceIdentity(record: TokenSource): string {
  return JSON.stringify([record.id, record.projectId, record.ownerSubject, record.ownerUsername, record.tokenHash,
    record.createdAt, record.expiresAt, record.roleCeiling, record.revision, [...record.scopes].sort()]);
}
function checkedSource(item: Item | undefined, expected: { tokenId: string; projectId: string; ownerSubject: string }, now: number): TokenSource {
  const record = item as unknown as TokenSource | undefined;
  if (!record || record.id !== expected.tokenId || record.projectId !== expected.projectId ||
    record.ownerSubject !== expected.ownerSubject || typeof record.ownerUsername !== 'string' || !record.ownerUsername ||
    typeof record.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.tokenHash) ||
    record.revokedAt || record.roleCeiling !== 'researcher' || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
    typeof record.expiresAt !== 'string' || typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.expiresAt)) || !Number.isFinite(Date.parse(record.createdAt)) ||
    Date.parse(record.expiresAt) <= now || Date.parse(record.expiresAt) <= Date.parse(record.createdAt) ||
    Date.parse(record.expiresAt) - Date.parse(record.createdAt) > 30 * 86400_000 ||
    !Array.isArray(record.scopes) || !record.scopes.includes('sessions:write') ||
    record.scopes.some((scope) => !API_SCOPES.includes(scope))) throw invalid();
  return record;
}

/** Read-only companion to the token verifier's owner/digest contract; no bearer is needed or reconstructed. */
async function sourceAuthorization(
  expected: { tokenId: string; projectId: string; ownerSubject: string; namespace?: string },
  options: AuthOptions,
): Promise<TokenSource> {
  const repo = options.repo ?? getRepo(), now = options.now ?? Date.now;
  if (!/^[a-f0-9]{32}$/.test(expected.tokenId) || !/^[a-z][a-z0-9-]{0,39}$/.test(expected.projectId) || !expected.ownerSubject) throw invalid();
  const ownerKey = { pk: `PROJECT#${expected.projectId}`, sk: `TOKEN#${digest(expected.ownerSubject)}#${expected.tokenId}` };
  try {
    const owner = checkedSource(await repo.kv.get(ownerKey.pk, ownerKey.sk), expected, now());
    const tokenKey = { pk: `API_TOKEN#${owner.tokenHash}`, sk: 'META' };
    const original = sourceIdentity(owner);
    const source = checkedSource(await repo.kv.get(tokenKey.pk, tokenKey.sk), expected, now());
    if (sourceIdentity(source) !== original) throw invalid();

    const user = await (options.currentUser ?? currentUserAuthorization)(owner.ownerUsername);
    if (!user || user.enabled !== true || user.subject !== expected.ownerSubject || user.username !== owner.ownerUsername ||
      !Array.isArray(user.groups) || roleFromGroups(user.groups) === 'viewer') throw invalid();
    const item = await repo.kv.get(`PROJECT#${expected.projectId}`, 'META');
    const project = item ? projectFromItem(item) : undefined;
    const role = projectRoleFromGroups(user.groups, expected.projectId);
    if (!project || expected.namespace !== undefined && project.namespace !== expected.namespace ||
      role !== 'researcher' && role !== 'project-admin') throw invalid();

    // Revocation may race the external Cognito/group lookup. Check both strongly-read records again.
    const [ownerAfter, sourceAfter] = await Promise.all([
      repo.kv.get(ownerKey.pk, ownerKey.sk), repo.kv.get(tokenKey.pk, tokenKey.sk),
    ]);
    if (sourceIdentity(checkedSource(ownerAfter, expected, now())) !== original ||
      sourceIdentity(checkedSource(sourceAfter, expected, now())) !== original) throw invalid();
    return owner;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(503, 'Token authorization unavailable');
  }
}

/** Capture the token's original maximum lifetime; callers cannot supply it in JSON or headers. */
export async function tokenBindingForPrincipal(p: GatewayPrincipal, projectId: string, options: AuthOptions = {}): Promise<DerivedTokenBinding | undefined> {
  assertTokenRequestProject(p, projectId);
  if (!markedPrincipal(p)) return undefined;
  const record = await sourceAuthorization({ tokenId: p.tokenId!, projectId, ownerSubject: p.subject! }, options);
  if (p.user !== record.ownerUsername) throw forbidden();
  return { authMethod: 'token', tokenId: record.id, tokenProjectId: record.projectId, tokenRole: 'researcher', tokenExpiresAt: record.expiresAt };
}

export async function authorizeDerivedToken(s: TokenBoundSession, options: AuthOptions = {}): Promise<void> {
  if (!hasTokenBinding(s)) return;
  const now = options.now ?? Date.now;
  if (s.authMethod !== 'token' || !s.tokenId || !s.projectId || s.tokenProjectId !== s.projectId ||
    s.tokenRole !== 'researcher' || !s.ownerSubject || !s.namespace ||
    typeof s.tokenExpiresAt !== 'string' || !Number.isFinite(Date.parse(s.tokenExpiresAt)) || Date.parse(s.tokenExpiresAt) <= now() ||
    typeof s.expiresAt !== 'string' || !Number.isFinite(Date.parse(s.expiresAt)) ||
    Date.parse(s.expiresAt) > Date.parse(s.tokenExpiresAt) || Date.parse(s.expiresAt) <= now()) throw invalid();
  const source = await sourceAuthorization({ tokenId: s.tokenId, projectId: s.projectId, ownerSubject: s.ownerSubject, namespace: s.namespace }, options);
  if (source.expiresAt !== s.tokenExpiresAt || Date.parse(s.expiresAt) <= now()) throw invalid();
}

export function tokenGrantFields(s: TokenBoundSession): Record<string, unknown> {
  return hasTokenBinding(s) ? Object.fromEntries(tokenKeys.map((key) => [key, s[key]])) : {};
}
export function matchesTokenGrant(grant: Record<string, unknown>, s: TokenBoundSession): boolean {
  if (hasTokenBinding(s)) return tokenKeys.every((key) => grant[key] === s[key]);
  return tokenKeys.every((key) => grant[key] === undefined);
}
