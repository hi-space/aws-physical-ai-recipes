/**
 * Verification of the identity headers the Application Load Balancer sets after
 * `authenticate-cognito`:
 *
 *  - `x-amzn-oidc-data`        JWT signed (ES256) by the ALB. Public key at
 *                              https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
 *  - `x-amzn-oidc-accesstoken` Cognito access token (contains `cognito:groups`).
 *  - `x-amzn-oidc-identity`    subject.
 *
 * The ALB JWT uses base64url with padding in some versions and a non-standard
 * header; `jose` handles both once the padding is stripped.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface OidcIdentity {
  sub: string;
  email?: string;
  username?: string;
  exp?: number;
}

type KeyFetcher = (kid: string) => Promise<string>;

const albKeyCache = new Map<string, Promise<KeyObject>>();

async function defaultAlbKeyFetcher(region: string, kid: string): Promise<string> {
  const res = await fetch(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`ALB public key fetch failed: ${res.status}`);
  return res.text();
}

/** Strip base64url padding on each segment (ALB emits padded segments). */
export function normalizeAlbJwt(jwt: string): string {
  return jwt
    .split('.')
    .map((s) => s.replace(/=+$/g, ''))
    .join('.');
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verify an ALB-signed JWT. The ALB signs the *padded* base64 segments, which
 * standard JWS libraries reject, so the ES256 signature (raw r||s) is checked
 * with node:crypto over the segments exactly as received, falling back to the
 * unpadded form for forward compatibility.
 */
export async function verifyAlbOidcData(
  jwt: string,
  region: string,
  opts: { expectedSigner: string; expectedIssuer?: string; expectedClient?: string; fetchKey?: KeyFetcher },
): Promise<OidcIdentity> {
  if (!opts.expectedSigner) throw new Error('ALB signer (load balancer ARN) is not configured; refusing to accept identity headers');
  const parts = jwt.trim().split('.');
  if (parts.length !== 3) throw new Error('ALB JWT malformed');
  let header: { kid?: string; signer?: string; alg?: string; iss?: string; client?: string; exp?: number };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64(parts[0]).toString('utf8'));
    payload = JSON.parse(b64(parts[1]).toString('utf8'));
  } catch {
    throw new Error('ALB JWT is not decodable');
  }
  if (!header.kid || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)) throw new Error('ALB JWT missing kid');
  if (header.alg !== 'ES256') throw new Error(`ALB JWT unexpected alg ${header.alg}`);
  if (header.signer !== opts.expectedSigner) throw new Error('ALB JWT signer mismatch');
  if (opts.expectedIssuer && header.iss !== opts.expectedIssuer) throw new Error('ALB JWT issuer mismatch');
  if (opts.expectedClient && header.client !== opts.expectedClient) throw new Error('ALB JWT client mismatch');

  const cacheKey = `${region}:${header.kid}`;
  let keyP = albKeyCache.get(cacheKey);
  if (!keyP) {
    const fetcher = opts.fetchKey ?? ((kid) => defaultAlbKeyFetcher(region, kid));
    keyP = fetcher(header.kid).then((pem) => createPublicKey(pem));
    albKeyCache.set(cacheKey, keyP);
    keyP.catch(() => albKeyCache.delete(cacheKey));
  }
  const key = await keyP;
  const signature = b64(parts[2]);
  const candidates = [`${parts[0]}.${parts[1]}`, `${parts[0].replace(/=+$/g, '')}.${parts[1].replace(/=+$/g, '')}`];
  const ok = candidates.some((input) => {
    try {
      return cryptoVerify('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error('signature verification failed');
  const exp = typeof header.exp === 'number' ? header.exp : typeof payload.exp === 'number' ? payload.exp : undefined;
  if (exp === undefined || !Number.isFinite(exp)) throw new Error('ALB JWT missing expiry');
  if (exp * 1000 < Date.now() - 30_000) throw new Error('ALB JWT expired');
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw new Error('ALB JWT missing subject');
  return {
    sub: String(payload.sub ?? ''),
    email: typeof payload.email === 'string' ? payload.email : undefined,
    username: typeof payload.username === 'string' ? payload.username : typeof payload['cognito:username'] === 'string' ? (payload['cognito:username'] as string) : undefined,
    exp,
  };
}

type Jwks = Parameters<typeof jwtVerify>[1];
const jwksCache = new Map<string, Jwks>();

/**
 * Read Cognito groups from the access token after verifying its signature
 * against the user pool JWKS. Fails closed: no pool id or no token → error.
 * `opts.jwks` lets tests inject a local key.
 */
export async function readGroupsFromAccessToken(
  accessToken: string,
  region: string,
  userPoolId: string,
  opts: { jwks?: Jwks; expectedSubject?: string; expectedClientId?: string } = {},
): Promise<string[]> {
  if (!accessToken) throw new Error('missing x-amzn-oidc-accesstoken');
  if (!userPoolId) throw new Error('COGNITO_USER_POOL_ID is not configured; refusing to derive roles');
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  let jwks = opts.jwks ?? jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    jwksCache.set(issuer, jwks as ReturnType<typeof createRemoteJWKSet>);
  }
  const { payload } = await jwtVerify(accessToken, jwks, { issuer });
  if (payload.token_use !== 'access') throw new Error('Cognito token_use must be access');
  if (typeof payload.exp !== 'number') throw new Error('Cognito access token missing expiry');
  if (opts.expectedSubject && payload.sub !== opts.expectedSubject) throw new Error('Cognito access token subject mismatch');
  if (opts.expectedClientId && payload.client_id !== opts.expectedClientId) throw new Error('Cognito access token client mismatch');
  const g = (payload as Record<string, unknown>)['cognito:groups'];
  return Array.isArray(g) ? g.map(String) : [];
}
