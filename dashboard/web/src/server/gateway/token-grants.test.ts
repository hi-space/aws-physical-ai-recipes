import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { authorizeCookie, consumeTicket, issueLaunchTicket } from './auth';
import { resolveRoute } from './routing';
import { tokenFixture } from './token-fixtures.test-helpers';
const host = 'derived.apps.physical-ai.hi-yoo.com';

async function cookieFixture() {
  const f = await tokenFixture();
  const launch = await issueLaunchTicket(f.session, f.principal, f.options);
  const exchanged = await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, f.options), f.options);
  return { ...f, launch, cookie: exchanged.cookie.split(';')[0] };
}
describe('derived token gateway grants', () => {
  it('binds token identity/project/role/maximum expiry into the one-use ticket and cookie', async () => {
    const f = await tokenFixture();
    const launch = await issueLaunchTicket(f.session, f.principal, f.options);
    const ticket = await f.repo.kv.get(`GATEWAY#TICKET#${createHash('sha256').update(launch.ticket).digest('hex')}`, 'META');
    expect(ticket).toMatchObject({ tokenId: f.principal.tokenId, tokenProjectId: f.project.id, tokenRole: 'researcher', tokenExpiresAt: f.issued.metadata.expiresAt });
    const exchanged = await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, f.options), f.options);
    const secret = exchanged.cookie.split(';')[0].split('=')[1];
    const grant = await f.repo.kv.get(`GATEWAY#COOKIE#${createHash('sha256').update(secret).digest('hex')}`, 'META');
    expect(grant).toMatchObject({ tokenId: f.principal.tokenId, tokenRole: 'researcher', expiresAt: Date.parse(f.session.expiresAt) });
    expect(JSON.stringify(grant)).not.toContain(f.issued.token);
  });
  it('rejects an outstanding ticket after source token revocation', async () => {
    const f = await tokenFixture();
    const launch = await issueLaunchTicket(f.session, f.principal, f.options);
    await f.revoke();
    await expect(consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, f.options), f.options)).rejects.toMatchObject({ status: 401 });
  });
  it.each(['revoked', 'disabled', 'recreated', 'cognito-role', 'project-role', 'project-namespace', 'token-project', 'role-ceiling', 'scope', 'owner-only-revocation', 'digest-only-revocation'])('invalidates exchanged cookies after %s changes', async (change) => {
    const f = await cookieFixture();
    if (change === 'revoked') await f.revoke();
    if (change === 'disabled') f.state.user.enabled = false;
    if (change === 'recreated') f.state.user.subject = 'different-subject';
    if (change === 'cognito-role') f.state.user.groups = ['viewers'];
    // Still a proj-team-a member, but the platform group downgrades the composed project role to viewer.
    if (change === 'project-role') f.state.user.groups = ['viewers', 'proj-team-a'];
    // Namespace is now derived purely from the (immutable) project id, so a project's namespace can no
    // longer drift on its own; tamper with the persisted session's namespace instead to exercise the same
    // sourceAuthorization mismatch guard (a stale/tampered session no longer matching the live project).
    if (change === 'project-namespace') await f.repo.kv.put({ pk: 'SESS#derived', sk: 'META', ...f.session, namespace: 'different-namespace' });
    if (change === 'token-project') await f.changeToken({ projectId: 'other' });
    if (change === 'role-ceiling') await f.changeToken({ roleCeiling: 'viewer' });
    if (change === 'scope') await f.changeToken({ scopes: ['sessions:read'] });
    if (change === 'owner-only-revocation') await f.changeToken({ revokedAt: new Date().toISOString() }, 'owner');
    if (change === 'digest-only-revocation') await f.changeToken({ revokedAt: new Date().toISOString() }, 'digest');
    await expect(authorizeCookie(f.cookie, resolveRoute({ host, path: '/' }, f.options), f.options)).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed on Cognito provider errors without exposing their details', async () => {
    const f = await cookieFixture(); f.state.failUser = true;
    await expect(authorizeCookie(f.cookie, resolveRoute({ host, path: '/' }, f.options), f.options)).rejects.toMatchObject({ status: 503, message: 'Token authorization unavailable' });
  });
  it('rechecks source records after an in-flight Cognito lookup', async () => {
    const f = await cookieFixture();
    f.options.currentUser = async () => { await f.revoke(); return f.state.user; };
    await expect(authorizeCookie(f.cookie, resolveRoute({ host, path: '/' }, f.options), f.options)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects forged token role/project markers and token launch of an unbound browser session', async () => {
    const f = await tokenFixture();
    await expect(issueLaunchTicket(f.session, { ...f.principal, role: 'admin' }, f.options)).rejects.toMatchObject({ status: 403 });
    await expect(issueLaunchTicket(f.session, { ...f.principal, tokenProjectId: 'other' }, f.options)).rejects.toMatchObject({ status: 403 });
    const { authMethod, tokenId, tokenExpiresAt, tokenRole, tokenProjectId, ...browserSession } = f.session;
    await f.repo.kv.put({ pk: 'SESS#derived', sk: 'META', ...browserSession });
    await expect(issueLaunchTicket(browserSession, f.principal, f.options)).rejects.toMatchObject({ status: 403 });
    await expect(issueLaunchTicket(browserSession, f.browser, f.options)).resolves.toHaveProperty('url');
  });
  it('cannot exchange or extend a grant beyond its original token expiry', async () => {
    const f = await tokenFixture();
    const expiry = new Date(f.state.now + 15_000).toISOString();
    await f.changeToken({ expiresAt: expiry });
    f.session.tokenExpiresAt = expiry;
    f.session.expiresAt = expiry;
    await f.repo.kv.put({ pk: 'SESS#derived', sk: 'META', ...f.session });
    const launch = await issueLaunchTicket(f.session, f.principal, f.options);
    expect(launch.expiresAt).toBe(expiry);
    const { cookie } = await consumeTicket(launch.ticket, resolveRoute({ host, path: '/' }, f.options), f.options);
    f.state.now = Date.parse(expiry);
    await expect(authorizeCookie(cookie.split(';')[0], resolveRoute({ host, path: '/' }, f.options), f.options)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects an inconsistent grant role and a stored session that exceeds its source expiry', async () => {
    const f = await cookieFixture();
    const key = `GATEWAY#COOKIE#${createHash('sha256').update(f.cookie.split('=')[1]).digest('hex')}`;
    await f.repo.kv.put({ ...(await f.repo.kv.get(key, 'META'))!, tokenRole: 'admin' });
    await expect(authorizeCookie(f.cookie, resolveRoute({ host, path: '/' }, f.options), f.options)).rejects.toMatchObject({ status: 401 });
    const tooLong = { ...f.session, expiresAt: new Date(Date.parse(f.session.tokenExpiresAt!) + 1).toISOString() };
    await f.repo.kv.put({ pk: 'SESS#derived', sk: 'META', ...tooLong });
    await expect(issueLaunchTicket(tooLong, f.browser, f.options)).rejects.toMatchObject({ status: 401 });
  });
});
