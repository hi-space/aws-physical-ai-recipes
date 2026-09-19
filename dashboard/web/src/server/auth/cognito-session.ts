/**
 * AUTH_MODE=cognito session primitives for deployments without a domain
 * (no ALB `authenticate-cognito`). The app signs users in with Cognito
 * `InitiateAuth` and keeps the session in a signed HttpOnly cookie:
 *
 *  - the cookie is an HS256 JWT signed with `SESSION_SIGNING_KEY`; it carries
 *    the Cognito access token (`at`) and refresh token (`rt`) plus the subject
 *    and the access-token expiry;
 *  - `verifyAccessToken` re-verifies the access token against the user pool
 *    JWKS (reusing `readGroupsFromAccessToken`) so authorization never trusts
 *    only the app-signed envelope;
 *  - `refreshAccess` mints a fresh access token from the refresh token.
 *
 * This module imports only from `./alb-jwt` (never `../config`) to keep the
 * dependency acyclic: `config.ts` imports `cognitoSessionEnv` from here.
 */
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { readGroupsFromAccessToken } from './alb-jwt';

export const AUTH_COOKIE = 'pai-auth';
export interface AuthCookiePayload { at: string; rt: string; sub: string; exp: number }
export interface CognitoSessionEnv { region: string; userPoolId: string; appClientId: string; signingKey: string; origin: string }
export interface VerifiedAccess { sub: string; username: string; email: string; groups: string[]; exp: number }

export function cognitoSessionEnv(env: NodeJS.ProcessEnv = process.env): CognitoSessionEnv {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required for AUTH_MODE=cognito`);
    return v;
  };
  // Check presence of every required variable first (so a missing app client id
  // is reported even when the signing key is also absent), then the key length.
  const userPoolId = need('COGNITO_USER_POOL_ID');
  const appClientId = need('COGNITO_APP_CLIENT_ID');
  const origin = need('DASHBOARD_ORIGIN');
  const signingKey = need('SESSION_SIGNING_KEY');
  if (signingKey.length < 32) throw new Error('SESSION_SIGNING_KEY must be at least 32 characters');
  return { region: env.AWS_REGION ?? 'us-east-1', userPoolId, appClientId, signingKey, origin };
}

const secret = (key: string) => new TextEncoder().encode(key);

export async function sealAuthCookie(payload: AuthCookiePayload, key: string): Promise<string> {
  return new SignJWT({ at: payload.at, rt: payload.rt })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setExpirationTime(payload.exp)
    .setIssuedAt()
    .sign(secret(key));
}

export async function openAuthCookie(value: string | undefined, key: string): Promise<AuthCookiePayload | undefined> {
  if (!value) return undefined;
  try {
    // The cookie exp equals the access-token expiry; a huge clockTolerance lets
    // the middleware still open an expired cookie so it can refresh the tokens.
    const { payload } = await jwtVerify(value, secret(key), { algorithms: ['HS256'], clockTolerance: 60 * 60 * 24 * 31 });
    if (typeof payload.at !== 'string' || typeof payload.rt !== 'string' || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return undefined;
    return { at: payload.at, rt: payload.rt, sub: payload.sub, exp: payload.exp };
  } catch {
    return undefined;
  }
}

const secure = (origin: string) => (origin.startsWith('https:') ? '; Secure' : '');
export const authCookieHeader = (value: string, origin: string, maxAgeSeconds: number) =>
  `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure(origin)}`;
export const clearAuthCookieHeader = (origin: string) =>
  `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(origin)}`;

export async function verifyAccessToken(
  at: string,
  env: CognitoSessionEnv,
  deps: { jwks?: NonNullable<Parameters<typeof readGroupsFromAccessToken>[3]>['jwks'] } = {},
): Promise<VerifiedAccess> {
  const groups = await readGroupsFromAccessToken(at, env.region, env.userPoolId, { expectedClientId: env.appClientId, jwks: deps.jwks });
  const claims = decodeJwt(at);
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') throw new Error('Cognito access token is missing sub/exp');
  return {
    sub: claims.sub,
    username: typeof claims.username === 'string' ? claims.username : claims.sub,
    email: typeof claims.email === 'string' ? claims.email : '',
    groups,
    exp: claims.exp,
  };
}

export async function refreshAccess(
  rt: string,
  env: CognitoSessionEnv,
  send: (cmd: InitiateAuthCommand) => Promise<unknown> = (cmd) => new CognitoIdentityProviderClient({ region: env.region }).send(cmd),
): Promise<{ at: string; exp: number }> {
  const out = (await send(
    new InitiateAuthCommand({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: env.appClientId, AuthParameters: { REFRESH_TOKEN: rt } }),
  )) as { AuthenticationResult?: { AccessToken?: string; ExpiresIn?: number } };
  const at = out.AuthenticationResult?.AccessToken;
  if (!at) throw new Error('Cognito refresh returned no access token');
  return { at, exp: Math.floor(Date.now() / 1000) + (out.AuthenticationResult?.ExpiresIn ?? 3600) };
}
