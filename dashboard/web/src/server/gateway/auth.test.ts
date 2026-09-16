import { beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { createHash } from 'node:crypto';
import { HttpError } from '../errors';
import { authorizeCookie, consumeTicket, issueLaunchTicket } from './auth';
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
  it('exchanges exactly once even when two replicas consume concurrently', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    expect(launch.host).toBe(host);
    expect(Date.parse(launch.expiresAt)).toBe(now + 60_000);
    const ticketKey = `GATEWAY#TICKET#${createHash('sha256').update(launch.ticket).digest('hex')}`;
    expect(await repo.kv.get(ticketKey, 'META')).toMatchObject({ host, sessionId: session.id, ownerSubject: 'owner-sub', expiresAt: now + 60_000 });
    expect(JSON.stringify(await repo.kv.get(ticketKey, 'META'))).not.toContain(launch.ticket);
    const attempts = await Promise.allSettled([consumeTicket(launch.ticket, host, options()), consumeTicket(launch.ticket, host, options())]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const success = attempts.find((a) => a.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof consumeTicket>>>;
    expect(success.value.cookie).toMatch(/^__Host-pai-session=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
    expect(success.value.cookie).not.toMatch(/Domain=/i);
    const cookie = success.value.cookie.split(';')[0];
    expect((await authorizeCookie(cookie, host, options())).id).toBe(session.id);
    expect(await repo.kv.get(ticketKey, 'META')).toBeUndefined();
  });
  it('rejects ticket at the exact deadline without relying on DynamoDB TTL cleanup', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    now += 60_000;
    await expect(consumeTicket(launch.ticket, host, options())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects wrong and noncanonical hosts without consuming the valid ticket', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    for (const wrong of ['other.apps.physical-ai.hi-yoo.com', `${host}.evil.test`, `${host}:443`, `${host}.`, host.toUpperCase()]) {
      await expect(consumeTicket(launch.ticket, wrong, options())).rejects.toBeDefined();
    }
    await expect(consumeTicket(launch.ticket, host, options())).resolves.toMatchObject({ session });
  });
  it('requires the registered owner Cognito subject and ignores unsigned user aliases', async () => {
    await expect(issueLaunchTicket(session, { subject: 'other' }, options())).rejects.toBeInstanceOf(HttpError);
    await expect(issueLaunchTicket(session, { subject: 'other' }, options())).rejects.toMatchObject({ status: 403 });
    await expect(issueLaunchTicket(session, { user: 'owner-sub' }, options())).rejects.toMatchObject({ status: 403 });
    await expect(issueLaunchTicket({ ...session, port: 1234 }, { subject: 'owner-sub' }, options())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects cookies on another host, duplicate auth cookies and session expiration', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    const exchange = await consumeTicket(launch.ticket, host, options());
    const cookie = exchange.cookie.split(';')[0];
    await expect(authorizeCookie(cookie, 'other.apps.physical-ai.hi-yoo.com', options())).rejects.toBeDefined();
    await expect(authorizeCookie(`${cookie}; ${cookie}`, host, options())).rejects.toMatchObject({ status: 401 });
    now = Date.parse(session.expiresAt);
    await expect(authorizeCookie(cookie, host, options())).rejects.toMatchObject({ status: 401 });
  });
  it.each(['delete', 'revoke', 'owner', 'pod', 'attempt'])('invalidates existing cookies on %s', async (change) => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    const { cookie } = await consumeTicket(launch.ticket, host, options());
    if (change === 'delete') await repo.deleteSession(session.id);
    if (change === 'revoke') await save({ ...session, revokedAt: new Date(now).toISOString() });
    if (change === 'owner') await save({ ...session, ownerSubject: 'other' });
    if (change === 'pod') await save({ ...session, podName: 'other-pod' });
    if (change === 'attempt') await save({ ...session, attempt: 2 });
    await expect(authorizeCookie(cookie.split(';')[0], host, options())).rejects.toMatchObject({ status: 401 });
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
    await expect(consumeTicket(launch.ticket, host, options())).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed for a cookie grant without a numeric expiry', async () => {
    const launch = await issueLaunchTicket(session, { subject: 'owner-sub' }, options());
    const { cookie } = await consumeTicket(launch.ticket, host, options());
    const secret = cookie.split(';')[0].split('=')[1];
    const key = `GATEWAY#COOKIE#${createHash('sha256').update(secret).digest('hex')}`;
    const grant = (await repo.kv.get(key, 'META'))!;
    delete grant.expiresAt;
    await repo.kv.put(grant);
    await expect(authorizeCookie(cookie.split(';')[0], host, options())).rejects.toMatchObject({ status: 401 });
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
    const { cookie } = await consumeTicket(launch.ticket, host, options());
    await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', phase: 'RUNNING', attempts: 2 });
    await expect(authorizeCookie(cookie.split(';')[0], host, options())).rejects.toMatchObject({ status: 401 });
    await repo.kv.put({ pk: 'WF#w', sk: 'TASK#train', phase: 'RUNNING', attempts: 1 });
    await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', namespace: 'research', members: {} });
    await expect(authorizeCookie(cookie.split(';')[0], host, options())).rejects.toMatchObject({ status: 401 });
  });
});
