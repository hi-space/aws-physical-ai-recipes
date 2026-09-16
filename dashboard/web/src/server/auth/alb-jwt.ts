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
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';

export interface OidcIdentity {
  sub: string;
  email?: string;
  username?: string;
  exp?: number;
}

type KeyFetcher = (kid: string) => Promise<string>;

const albKeyCache = new Map<string, Promise<CryptoKey>>();

async function defaultAlbKeyFetcher(region: string, kid: string): Promise<string> {
  const res = await fetch(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`);
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

export async function verifyAlbOidcData(
  jwt: string,
  region: string,
  opts: { expectedSigner?: string; fetchKey?: KeyFetcher } = {},
): Promise<OidcIdentity> {
  const token = normalizeAlbJwt(jwt);
  const header = decodeProtectedHeader(token) as { kid?: string; signer?: string; alg?: string };
  if (!header.kid) throw new Error('ALB JWT missing kid');
  if (header.alg !== 'ES256') throw new Error(`ALB JWT unexpected alg ${header.alg}`);
  if (opts.expectedSigner && header.signer !== opts.expectedSigner) {
    throw new Error('ALB JWT signer mismatch');
  }
  const cacheKey = `${region}:${header.kid}`;
  let keyP = albKeyCache.get(cacheKey);
  if (!keyP) {
    const fetcher = opts.fetchKey ?? ((kid) => defaultAlbKeyFetcher(region, kid));
    keyP = fetcher(header.kid).then((pem) => importSPKI(pem, 'ES256'));
    albKeyCache.set(cacheKey, keyP);
    keyP.catch(() => albKeyCache.delete(cacheKey));
  }
  const key = await keyP;
  const { payload } = await jwtVerify(token, key, { algorithms: ['ES256'] });
  return {
    sub: String(payload.sub ?? ''),
    email: typeof payload.email === 'string' ? payload.email : undefined,
    username: typeof payload.username === 'string' ? payload.username : (typeof payload['cognito:username'] === 'string' ? (payload['cognito:username'] as string) : undefined),
    exp: payload.exp,
  };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Read Cognito groups from the access token. The token is verified against the
 * user pool JWKS when a pool id is provided; otherwise it is decoded only
 * (acceptable because the ALB has already validated it and we only trust the
 * request when x-amzn-oidc-data verified).
 */
export async function readGroupsFromAccessToken(
  accessToken: string,
  region: string,
  userPoolId?: string,
): Promise<string[]> {
  if (!accessToken) return [];
  let payload: Record<string, unknown>;
  if (userPoolId) {
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    let jwks = jwksCache.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
      jwksCache.set(issuer, jwks);
    }
    payload = (await jwtVerify(accessToken, jwks, { issuer })).payload as Record<string, unknown>;
  } else {
    payload = decodeJwt(accessToken) as Record<string, unknown>;
  }
  const g = payload['cognito:groups'];
  return Array.isArray(g) ? g.map(String) : [];
}
