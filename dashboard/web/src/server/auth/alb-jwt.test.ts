import { describe, expect, it } from 'vitest';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

/** Mimic the ALB: base64 segments WITH padding, ES256 raw signature over the padded input. */
async function albStyleToken(privateKey: CryptoKey, header: object, payload: object): Promise<string> {
  const pad = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const input = `${pad(header)}.${pad(payload)}`;
  const { exportPKCS8 } = await import('jose');
  const pem = await exportPKCS8(privateKey);
  const sig = cryptoSign('sha256', Buffer.from(input), { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')}`;
}
import { normalizeAlbJwt, readGroupsFromAccessToken, verifyAlbOidcData } from './alb-jwt';
import { roleFromGroups } from './rbac';

describe('verifyAlbOidcData', () => {
  it('verifies an ALB-style padded token (signature over padded segments)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportSPKI(publicKey);
    const jwt = await albStyleToken(privateKey, { typ: 'JWT', kid: 'kp', alg: 'ES256', signer: 'arn:alb', exp: Math.floor(Date.now() / 1000) + 120 }, { sub: 'pad', email: 'p@x.y', username: 'padded', exp: Math.floor(Date.now() / 1000) + 120 });
    expect(jwt).toMatch(/=\./); // padding really present
    const id = await verifyAlbOidcData(jwt, 'us-east-1', { expectedSigner: 'arn:alb', fetchKey: async () => pem });
    expect(id).toMatchObject({ sub: 'pad', username: 'padded' });
  });
  it('rejects a tampered payload', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportSPKI(publicKey);
    const jwt = await albStyleToken(privateKey, { kid: 'kt', alg: 'ES256', signer: 'arn:alb' }, { sub: 'a' });
    const parts = jwt.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'b' })).toString('base64');
    await expect(verifyAlbOidcData(parts.join('.'), 'us-east-1', { expectedSigner: 'arn:alb', fetchKey: async () => pem })).rejects.toThrow(/signature/);
  });
  it('verifies an ES256 token using the fetched key and returns identity', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const pem = await exportSPKI(publicKey);
    const jwt = await new SignJWT({ sub: 'abc', email: 'a@b.c', username: 'alice' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', signer: 'arn:alb' } as never)
      .setExpirationTime('5m')
      .sign(privateKey);
    const id = await verifyAlbOidcData(jwt, 'us-east-1', { expectedSigner: 'arn:alb', fetchKey: async () => pem });
    expect(id).toMatchObject({ sub: 'abc', email: 'a@b.c', username: 'alice' });
  });
  it('rejects a signer mismatch', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const pem = await exportSPKI(publicKey);
    const jwt = await new SignJWT({ sub: 'x' }).setProtectedHeader({ alg: 'ES256', kid: 'k2', signer: 'other' } as never).sign(privateKey);
    await expect(verifyAlbOidcData(jwt, 'us-east-1', { expectedSigner: 'arn:alb', fetchKey: async () => pem })).rejects.toThrow(/signer/);
  });
  it('strips padding', () => {
    expect(normalizeAlbJwt('aa==.bb=.cc')).toBe('aa.bb.cc');
  });
});

describe('groups and roles', () => {
  it('verifies the access token against the pool issuer and reads cognito:groups', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const issuer = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc';
    const jwt = await new SignJWT({ 'cognito:groups': ['researchers'] }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).sign(privateKey);
    expect(await readGroupsFromAccessToken(jwt, 'us-east-1', 'us-east-1_abc', { jwks: publicKey })).toEqual(['researchers']);
    await expect(readGroupsFromAccessToken(jwt, 'us-east-1', 'us-east-1_other', { jwks: publicKey })).rejects.toThrow();
    await expect(readGroupsFromAccessToken(jwt, 'us-east-1', '')).rejects.toThrow(/not configured/);
    await expect(readGroupsFromAccessToken('', 'us-east-1', 'us-east-1_abc')).rejects.toThrow(/missing/);
  });
  it('refuses to verify ALB data without an expected signer', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const pem = await exportSPKI(publicKey);
    const jwt = await new SignJWT({ sub: 'x' }).setProtectedHeader({ alg: 'ES256', kid: 'k3', signer: 'arn:alb' } as never).sign(privateKey);
    await expect(verifyAlbOidcData(jwt, 'us-east-1', { expectedSigner: '', fetchKey: async () => pem })).rejects.toThrow(/not configured/);
  });
  it('maps groups to roles', () => {
    expect(roleFromGroups(['admins', 'researchers'])).toBe('admin');
    expect(roleFromGroups(['researchers'])).toBe('researcher');
    expect(roleFromGroups([])).toBe('viewer');
    expect(roleFromGroups(undefined)).toBe('viewer');
  });
});
