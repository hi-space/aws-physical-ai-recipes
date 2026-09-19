import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { authCookieHeader, clearAuthCookieHeader, cognitoSessionEnv, openAuthCookie, refreshAccess, sealAuthCookie, verifyAccessToken } from './cognito-session';

const key = 'k'.repeat(48);
const env = { region: 'us-east-1', userPoolId: 'us-east-1_abc', appClientId: 'client1', signingKey: key, origin: 'http://alb.example.com' };

describe('auth cookie', () => {
  it('round-trips a payload and rejects a tampered or foreign-key token', async () => {
    const sealed = await sealAuthCookie({ at: 'A', rt: 'R', sub: 's1', exp: 1_800_000_000 }, key);
    expect(await openAuthCookie(sealed, key)).toEqual({ at: 'A', rt: 'R', sub: 's1', exp: 1_800_000_000 });
    expect(await openAuthCookie(sealed + 'x', key)).toBeUndefined();
    expect(await openAuthCookie(sealed, 'z'.repeat(48))).toBeUndefined();
    expect(await openAuthCookie(undefined, key)).toBeUndefined();
  });
  it('sets Secure only for https origins and clears with Max-Age=0', () => {
    expect(authCookieHeader('v', 'http://alb.example.com', 3600)).toBe('pai-auth=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600');
    expect(authCookieHeader('v', 'https://d.example.com', 3600)).toContain('; Secure');
    expect(clearAuthCookieHeader('http://alb.example.com')).toBe('pai-auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
});
describe('cognitoSessionEnv', () => {
  it('requires every variable', () => {
    expect(() => cognitoSessionEnv({ AWS_REGION: 'us-east-1', COGNITO_USER_POOL_ID: 'p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: key, DASHBOARD_ORIGIN: 'http://x' } as unknown as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => cognitoSessionEnv({ AWS_REGION: 'us-east-1', COGNITO_USER_POOL_ID: 'p' } as unknown as NodeJS.ProcessEnv)).toThrow(/COGNITO_APP_CLIENT_ID/);
    expect(() => cognitoSessionEnv({ AWS_REGION: 'us-east-1', COGNITO_USER_POOL_ID: 'p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: 'short', DASHBOARD_ORIGIN: 'http://x' } as unknown as NodeJS.ProcessEnv)).toThrow(/SESSION_SIGNING_KEY/);
  });
});
describe('verifyAccessToken', () => {
  it('accepts a pool-signed access token for the app client and returns identity + groups', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const issuer = `https://cognito-idp.us-east-1.amazonaws.com/${env.userPoolId}`;
    const at = await new SignJWT({ token_use: 'access', client_id: 'client1', username: 'alice', 'cognito:groups': ['researchers'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setSubject('sub-1').setExpirationTime('1h').sign(privateKey);
    const jwks = async () => publicKey;
    const out = await verifyAccessToken(at, env, { jwks: Object.assign(jwks, { jwk }) as never });
    expect(out).toMatchObject({ sub: 'sub-1', username: 'alice', groups: ['researchers'] });
    expect(out.exp).toBeGreaterThan(Date.now() / 1000);
  });
});
describe('refreshAccess', () => {
  it('calls InitiateAuth REFRESH_TOKEN_AUTH and returns the new access token and expiry', async () => {
    const send = vi.fn(async (_cmd: unknown) => ({ AuthenticationResult: { AccessToken: 'NEW', ExpiresIn: 3600 } }));
    const out = await refreshAccess('R', env, send);
    expect(out.at).toBe('NEW');
    expect(out.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
    expect(send.mock.calls[0][0]).toMatchObject({ input: { AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'client1', AuthParameters: { REFRESH_TOKEN: 'R' } } });
  });
  it('throws when Cognito returns no access token', async () => {
    await expect(refreshAccess('R', env, async () => ({}))).rejects.toThrow(/refresh/i);
  });
});
