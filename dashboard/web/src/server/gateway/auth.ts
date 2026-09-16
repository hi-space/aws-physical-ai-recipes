import { createHash, randomBytes } from 'node:crypto';
import { getRepo } from '../store/repo';
import type { Repo } from '../store/repo';
import { GatewayError, type AuthOptions, type GatewaySession } from './types';
import { assertTokenLaunchPrincipal, authorizeDerivedToken, hasTokenBinding, matchesTokenGrant, tokenGrantFields, type GatewayPrincipal } from './token-grants';
import { backendId } from '../backends/registry';
import { assertWorkflowBackend } from '../backends/binding';

export const COOKIE_NAME = '__Host-pai-session';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const kinds = new Set(['terminal', 'port-forward', 'tensorboard', 'jupyter', 'code-server', 'dcv']);
const invalid = () => new GatewayError(401, 'Session authorization expired or invalid');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const context = (o: AuthOptions) => ({ repo: o.repo ?? getRepo(), now: o.now ?? Date.now });

export function baseDomain(options: AuthOptions = {}): string {
  const domain = options.baseDomain ?? process.env.GATEWAY_BASE_DOMAIN ?? 'apps.physical-ai.hi-yoo.com';
  if (domain.length > 190 || !domain.includes('.') || !domain.split('.').every((part) => labelPattern.test(part))) {
    throw new GatewayError(500, 'Invalid gateway domain configuration');
  }
  return domain;
}

export function sessionHost(id: string, options: AuthOptions = {}): string {
  if (!labelPattern.test(id)) throw invalid();
  return `${id}.${baseDomain(options)}`;
}

/** Do not normalize authorities: aliases, ports, case variants and trailing dots fail closed. */
export function sessionIdFromHost(host: string | undefined, options: AuthOptions = {}): string {
  if (!host) throw invalid();
  const suffix = `.${baseDomain(options)}`;
  if (!host.endsWith(suffix)) throw invalid();
  const id = host.slice(0, -suffix.length);
  if (!labelPattern.test(id) || sessionHost(id, options) !== host) throw invalid();
  return id;
}

/** Only these persisted fields may affect routing or authorization. Changes invalidate every grant. */
export function sessionBinding(s: GatewaySession): string {
  const binding = [
    s.id, s.ownerSubject, s.expiresAt, s.kind, s.namespace, s.podName, s.podUid, s.container,
    s.port, s.nodeName, s.ssmTarget, s.dcvSessionId, s.projectId, s.workflowId, s.taskName,
    s.attempt, s.attemptEpoch, s.createdAt,
  ];
  if (s.backendId || s.backendConfigHash) binding.push(s.backendId, s.backendConfigHash);
  // Preserve existing browser grant digests; only derived grants append source authority.
  if (hasTokenBinding(s)) binding.push(s.authMethod, s.tokenId, s.tokenProjectId, s.tokenRole, s.tokenExpiresAt);
  return digest(JSON.stringify(binding));
}

function validateSession(value: unknown, now: number): GatewaySession {
  const s = value as GatewaySession | undefined;
  if (!s || typeof s.id !== 'string' || !labelPattern.test(s.id) || typeof s.ownerSubject !== 'string' || !s.ownerSubject ||
    typeof s.expiresAt !== 'string' || !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt) <= now ||
    !kinds.has(s.kind) || s.revokedAt ||
    ['revoked', 'expired', 'deleted', 'stopped', 'failed', 'terminated'].includes(s.status?.toLowerCase() ?? '')) throw invalid();
  if (s.attempt !== undefined && (!Number.isSafeInteger(s.attempt) || s.attempt < 0)) throw invalid();
  if (s.kind === 'dcv') {
    if (!s.nodeName || !s.ssmTarget || !s.dcvSessionId) throw new GatewayError(503, 'DCV session target is not registered');
  } else {
    if (typeof s.namespace !== 'string' || !labelPattern.test(s.namespace) || typeof s.podName !== 'string' || s.podName.length > 253 ||
      !s.podName.split('.').every((part) => labelPattern.test(part)) ||
      s.container !== undefined && !labelPattern.test(s.container)) throw new GatewayError(503, 'Session pod target is not registered');
    if (s.kind === 'terminal' && !s.container) throw new GatewayError(503, 'Terminal container is not registered');
    if (s.kind !== 'terminal' && (!Number.isInteger(s.port) || s.port! < 1 || s.port! > 65535)) {
      throw new GatewayError(503, 'Session port is not registered');
    }
  }
  return s;
}

async function currentSession(repo: Repo, id: string, now: () => number, options: AuthOptions): Promise<GatewaySession> {
  const s = validateSession(await repo.getSession(id), now());
  if (s.id !== id) throw invalid();
  if (s.kind !== 'dcv') await assertWorkflowBackend(s, repo);
  await authorizeDerivedToken(s, { ...options, repo, now });
  if (s.projectId && !hasTokenBinding(s)) {
    const project = await repo.kv.get(`PROJECT#${s.projectId}`, 'META');
    const members = project?.members as Record<string, unknown> | undefined;
    if (project?.namespace !== s.namespace || !members || !Object.hasOwn(members, s.ownerSubject) ||
      !['researcher', 'project-admin'].includes(String(members[s.ownerSubject]))) throw invalid();
  }
  if (s.workflowId) {
    const [workflow, cancellation] = await Promise.all([
      repo.getWorkflow(s.workflowId), repo.cancellation(s.workflowId),
    ]);
    if (!workflow || cancellation || backendId(workflow.backendId) !== backendId(s.backendId) || workflow.backendConfigHash !== s.backendConfigHash ||
      workflow.namespace !== s.namespace || workflow.projectId !== s.projectId || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELLING'].includes(workflow.status)) throw invalid();
    if (s.taskName) {
      const task = await repo.kv.get(`WF#${s.workflowId}`, `TASK#${s.taskName}`);
      if (!task || task.phase !== 'RUNNING' ||
        s.attempt !== undefined && task.attempts !== s.attempt ||
        s.attemptEpoch !== undefined && task.attemptEpoch !== s.attemptEpoch) throw invalid();
    }
  }
  return validateSession(s, now());
}

export async function issueLaunchTicket(
  sessionRecord: GatewaySession,
  principal: GatewayPrincipal,
  options: AuthOptions = {},
): Promise<{ ticket: string; url: string; expiresAt: string; host: string }> {
  if (!principal.subject || principal.subject !== sessionRecord.ownerSubject) {
    throw new GatewayError(403, 'Only the verified session owner may launch this session');
  }
  assertTokenLaunchPrincipal(sessionRecord, principal);
  const { repo, now } = context(options);
  const host = sessionHost(sessionRecord.id, options);
  const session = await currentSession(repo, sessionRecord.id, now, options);
  if (sessionBinding(sessionRecord) !== sessionBinding(session)) throw invalid();
  const expires = Math.min(now() + 60_000, Date.parse(session.expiresAt));
  const ticket = token();
  const stored = await repo.kv.put({
    pk: `GATEWAY#TICKET#${digest(ticket)}`, sk: 'META',
    sessionId: session.id, host, ownerSubject: session.ownerSubject, binding: sessionBinding(session),
    workflowId: session.workflowId, attempt: session.attempt, expiresAt: expires, ttl: Math.ceil(expires / 1000),
    ...tokenGrantFields(session),
  }, 'not_exists');
  if (!stored) throw new GatewayError(503, 'Unable to issue launch ticket');
  return { ticket, host, url: `https://${host}/?ticket=${ticket}`, expiresAt: new Date(expires).toISOString() };
}

export async function consumeTicket(ticket: string, host: string, options: AuthOptions = {}) {
  const id = sessionIdFromHost(host, options);
  if (!tokenPattern.test(ticket)) throw invalid();
  const { repo, now } = context(options);
  const pk = `GATEWAY#TICKET#${digest(ticket)}`;
  const grant = await repo.kv.get(pk, 'META');
  if (!grant || grant.sessionId !== id || grant.host !== host ||
    typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now()) throw invalid();
  const session = await currentSession(repo, id, now, options);
  if (grant.ownerSubject !== session.ownerSubject || grant.binding !== sessionBinding(session) || !matchesTokenGrant(grant, session)) throw invalid();
  const secret = token();
  const expires = Date.parse(session.expiresAt);
  const ok = await repo.kv.transaction([
    { kind: 'delete', pk, sk: 'META', condition: {
      equals: { sessionId: id, host, ownerSubject: session.ownerSubject, binding: grant.binding },
      after: { expiresAt: now() },
    } },
    { kind: 'put', item: {
      pk: `GATEWAY#COOKIE#${digest(secret)}`, sk: 'META',
      sessionId: id, host, ownerSubject: session.ownerSubject, binding: grant.binding,
      workflowId: session.workflowId, attempt: session.attempt, expiresAt: expires, ttl: Math.ceil(expires / 1000),
      ...tokenGrantFields(session),
    }, condition: { absent: true } },
  ]);
  if (!ok) throw invalid();
  return {
    cookie: `${COOKIE_NAME}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expires - now()) / 1000))}; Expires=${new Date(expires).toUTCString()}`,
    session,
  };
}

export async function authorizeCookie(cookieHeader: string | undefined, host: string, options: AuthOptions = {}): Promise<GatewaySession> {
  const id = sessionIdFromHost(host, options);
  const cookies = (cookieHeader ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.split('=', 1)[0] === COOKIE_NAME);
  if (cookies.length !== 1) throw invalid();
  const secret = cookies[0].slice(COOKIE_NAME.length + 1);
  if (!tokenPattern.test(secret)) throw invalid();
  const { repo, now } = context(options);
  const grant = await repo.kv.get(`GATEWAY#COOKIE#${digest(secret)}`, 'META');
  if (!grant || grant.host !== host || grant.sessionId !== id ||
    typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now()) throw invalid();
  const session = await currentSession(repo, id, now, options);
  if (grant.ownerSubject !== session.ownerSubject || grant.binding !== sessionBinding(session) || !matchesTokenGrant(grant, session)) throw invalid();
  return session;
}
