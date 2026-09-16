import { describe, expect, it } from 'vitest';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { normalizeAlbJwt, readGroupsFromAccessToken, verifyAlbOidcData } from './alb-jwt';
import { roleFromGroups } from './rbac';

describe('verifyAlbOidcData', () => {
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
  it('decodes cognito:groups without a pool id', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const jwt = await new SignJWT({ 'cognito:groups': ['researchers'] }).setProtectedHeader({ alg: 'ES256' }).sign(privateKey);
    expect(await readGroupsFromAccessToken(jwt, 'us-east-1')).toEqual(['researchers']);
  });
  it('maps groups to roles', () => {
    expect(roleFromGroups(['admins', 'researchers'])).toBe('admin');
    expect(roleFromGroups(['researchers'])).toBe('researcher');
    expect(roleFromGroups([])).toBe('viewer');
    expect(roleFromGroups(undefined)).toBe('viewer');
  });
});
