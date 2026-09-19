import { beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../errors';
import { authorizeCookie, consumeTicket, issueLaunchTicket, sessionBinding } from './auth';
import { resolveRoute } from './routing';
import type { GatewaySession } from './types';

const host = 'session-a.apps.physical-ai.hi-yoo.com';
let repo: Repo;
let now: number;
let session: GatewaySession;
const options = () => ({ repo, now: () => now });
async function save(value: GatewaySession) {
  await repo.kv.put({ pk: `SESS#${value.id}`, sk: 'META', ...value });
}
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  now = Date.parse('2026-09-16T12:00:00Z');
  session = { id: 'session-a', kind: 'jupyter', ownerSubject: 'owner-sub', namespace: 'research',
    podName: 'job-pod', container: 'main', port: 8888, expiresAt: new Date(now + 300_000).toISOString() };
  await save(session);
});

describe('gateway launch credentials', () => {
  it('rejects HTTP grants for a trusted host-network profile and legacy exec without strong approval fields', async () => {
    session = { ...session, kind: 'port-forward', workflowId: 'wf', taskName: 'train', attempt: 1 };
    await save(session);
    await repo.kv.put({ pk: 'WF#wf', sk: 'META', status: 'RUNNING', namespace: session.namespace, projectId: session.projectId, executionProfilePins: { train: { policy: { hostNetwork: true } } } });
    await repo.kv.put({ pk: 'WF#wf', sk: 'TASK#train', phase: 'RUNNING', attempts: 1 });
    await expect(issueLaunchTicket(session, { subject: 'owner-sub' }, options())).rejects.toBeDefined();
    session.kind = 'terminal'; await save(session);
    await expect(issueLaunchTicket(session, { subject: 'owner-sub' }, options())).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a registered shared-host HTTP target even without a workflow pin', async () => {
    session = { ...session, hostNetwork: true }; await save(session);
    await expect(issueLaunchTicket(session, { subject: 'owner-sub' }, options())).rejects.toMatchObject({ status: 401 });
  });
  it('exchanges exactly once even when two replicas consume concurrently', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    expect(launch.host).toBe(host);
    expect(Date.parse(launch.expiresAt)).toBe(now + 60_000);
    const ticketKey = `GATEWAY#TICKET#${createHash('sha256').update(launch.ticket).digest('hex')}`;
    expect(await repo.kv.get(ticketKey, 'META')).toMatchObject({ host, sessionId: session.id, ownerSubject: 'owner-sub', expiresAt: now + 60_000 });
    expect(JSON.stringify(await repo.kv.get(ticketKey, 'META'))).not.toContain(launch.ticket);
    const attempts = await Promise.allSettled([consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options()), consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options())]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const success = attempts.find((a) => a.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof consumeTicket>>>;
    expect(success.value.cookie).toMatch(/^__Host-pai-session=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
    expect(success.value.cookie).not.toMatch(/Domain=/i);
    const cookie = success.value.cookie.split(';')[0];
    expect((await authorizeCookie(cookie, resolveRoute({ host, path: '/' }, options()), options())).id).toBe(session.id);
    expect(await repo.kv.get(ticketKey, 'META')).toBeUndefined();
  });
  it('rejects ticket at the exact deadline without relying on DynamoDB TTL cleanup', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    now += 60_000;
    await expect(consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects wrong and noncanonical hosts without consuming the valid ticket', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    for (const wrong of ['other.apps.physical-ai.hi-yoo.com', `${host}.evil.test`, `${host}:443`, `${host}.`, host.toUpperCase()]) {
      await expect((async () => consumeTicket(launch.ticket, resolveRoute({ host: wrong, path: '/' }, options()), options()))()).rejects.toBeDefined();
    }
    await expect(consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options())).resolves.toMatchObject({ session });
  });
  it('requires the registered owner Cognito subject and ignores unsigned user aliases', async () => {
    await expect(issueLaunchTicket(session, { subject: 'other' }, options())).rejects.toBeInstanceOf(HttpError);
    await expect(issueLaunchTicket(session, { subject: 'other' }, options())).rejects.toMatchObject({ status: 403 });
    await expect(issueLaunchTicket(session, { user: 'owner-sub' }, options())).rejects.toMatchObject({ status: 403 });
    await expect(issueLaunchTicket({ ...session, port: 1234 }, { subject: 'owner-sub' }, options())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects cookies on another host, duplicate auth cookies and session expiration', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    const exchange = await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options());
    const cookie = exchange.cookie.split(';')[0];
    await expect(authorizeCookie(cookie, resolveRoute({ host: 'other.apps.physical-ai.hi-yoo.com', path: '/' }, options()), options())).rejects.toBeDefined();
    await expect(authorizeCookie(`${cookie}; ${cookie}`, resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
    now = Date.parse(session.expiresAt);
    await expect(authorizeCookie(cookie, resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
  });
  it.each(['delete', 'revoke', 'owner', 'pod', 'attempt'])('invalidates existing cookies on %s', async (change) => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    const { cookie } = await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options());
    if (change === 'delete') await repo.deleteSession(session.id);
    if (change === 'revoke') await save({ ...session, revokedAt: new Date(now).toISOString() });
    if (change === 'owner') await save({ ...session, ownerSubject: 'other' });
    if (change === 'pod') await save({ ...session, podName: 'other-pod' });
    if (change === 'attempt') await save({ ...session, attempt: 2 });
    await expect(authorizeCookie(cookie.split(';')[0], resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
  });
  it('bounds ticket expiry by session expiry', async () => {
    session.expiresAt = new Date(now + 5_000).toISOString();
    await save(session);
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    expect(launch.expiresAt).toBe(session.expiresAt);
  });
  it('rejects a ticket if the session was revoked before exchange', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    await repo.deleteSession(session.id);
    await expect(consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed for a cookie grant without a numeric expiry', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    const { cookie } = await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options());
    const secret = cookie.split(';')[0].split('=')[1];
    const key = `GATEWAY#COOKIE#${createHash('sha256').update(secret).digest('hex')}`;
    const grant = (await repo.kv.get(key, 'META'))!;
    delete grant.expiresAt;
    await repo.kv.put(grant);
    await expect(authorizeCookie(cookie.split(';')[0], resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a session namespace outside its registered project', async () => {
    session.projectId = 'p'; await save(session);
    await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: 'other-namespace', members: { 'owner-sub': 'researcher' } });
    await expect(issueLaunchTicket(session, { subject: 'owner-sub' }, options())).rejects.toMatchObject({ status: 401 });
  });
  it('checks current project membership and task attempt after exchange', async () => {
    session = { ...session, projectId: 'p', workflowId: 'w', taskName: 'train', attempt: 1 };
    await save(session);
    await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: 'research', members: { 'owner-sub': 'researcher' } });
    await repo.kv.put({ pk: 'WF#w', sk: 'META', status: 'RUNNING', namespace: 'research', projectId: 'p' });
    await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', phase: 'RUNNING', attempts: 1 });
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    const { cookie } = await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, options()), options());
    await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', phase: 'RUNNING', attempts: 2 });
    await expect(authorizeCookie(cookie.split(';')[0], resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
    await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', phase: 'RUNNING', attempts: 1 });
    await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: 'research', members: {} });
    await expect(authorizeCookie(cookie.split(';')[0], resolveRoute({ host, path: '/' }, options()), options())).rejects.toMatchObject({ status: 401 });
  });
  it('path mode: ticket exchange sets a per-session path cookie and the grant binds to origin+prefix', async () => {
    const principal = { subject: 'owner-sub' };
    const options = { repo, now: () => now, mode: 'path' as const, publicOrigin: 'http://alb.example.com:8080' };
    const issued = await issueLaunchTicket(session, principal, options);
    expect(issued.url).toBe(`http://alb.example.com:8080/s/${session.id}/?ticket=${issued.ticket}`);
    const route = resolveRoute({ host: 'alb.example.com:8080', path: `/s/${session.id}/?ticket=${issued.ticket}` }, options);
    const exchange = await consumeTicket(issued.ticket, route, options);
    expect(exchange.cookie).toMatch(new RegExp(`^pai-session-${session.id}=[A-Za-z0-9_-]{43}; Path=/s/${session.id}/; HttpOnly; SameSite=Strict`));
    const cookieValue = exchange.cookie.split(';')[0];
    await expect(authorizeCookie(cookieValue, route, options)).resolves.toMatchObject({ id: session.id });
    await expect(authorizeCookie(cookieValue, resolveRoute({ host: 'alb.example.com:8080', path: '/s/other/' }, options), options)).rejects.toThrow();
  });
  it('accepts a legacy host-mode grant written before routeBinding (integrity digest under `binding`, no routeBinding)', async () => {
    const route = resolveRoute({ host, path: '/' }, options());
    const expires = Date.parse(session.expiresAt);
    // Ticket shaped exactly as the currently deployed code writes it: route binding lives in `host`,
    // the integrity digest in `binding`, and there is no `routeBinding` field.
    const ticket = randomBytes(32).toString('base64url');
    await repo.kv.put({ pk: `GATEWAY#TICKET#${createHash('sha256').update(ticket).digest('hex')}`, sk: 'META',
      sessionId: session.id, host, ownerSubject: session.ownerSubject, binding: sessionBinding(session),
      expiresAt: now + 60_000, ttl: Math.ceil((now + 60_000) / 1000) });
    const exchange = await consumeTicket(ticket, route, options());
    expect(exchange.session.id).toBe(session.id);
    // A cookie grant of the same legacy shape must authorize unchanged.
    const secret = randomBytes(32).toString('base64url');
    await repo.kv.put({ pk: `GATEWAY#COOKIE#${createHash('sha256').update(secret).digest('hex')}`, sk: 'META',
      sessionId: session.id, host, ownerSubject: session.ownerSubject, binding: sessionBinding(session),
      expiresAt: expires, ttl: Math.ceil(expires / 1000) });
    await expect(authorizeCookie(`__Host-pai-session=${secret}`, route, options())).resolves.toMatchObject({ id: session.id });
  });
});

describe('optional session-host domain', () => {
  it('reports absence as a 503 not-configured error instead of crashing', async () => {
    const { baseDomain, sessionHostsConfigured } = await import('./auth');
    expect(sessionHostsConfigured({ baseDomain: 'apps.example.com' })).toBe(true);
    const saved = process.env.GATEWAY_BASE_DOMAIN; delete process.env.GATEWAY_BASE_DOMAIN;
    try {
      expect(sessionHostsConfigured()).toBe(false);
      expect(() => baseDomain()).toThrow(/GATEWAY_BASE_DOMAIN/);
      try { baseDomain(); } catch (e) { expect((e as { status?: number }).status).toBe(503); }
    } finally { process.env.GATEWAY_BASE_DOMAIN = saved; }
  });
});
