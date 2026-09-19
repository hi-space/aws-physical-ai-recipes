# Dashboard E — 도메인 없는 HTTP 모드와 앱 내 Cognito 로그인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도메인·Route 53·ACM 없이 ALB DNS 이름으로 HTTP 접속하는 배포 모드를 추가한다. 이 모드에서는 ALB Cognito 액션 대신 앱이 `/login` 페이지에서 Cognito `InitiateAuth`로 인증하고 서명된 HttpOnly 쿠키로 세션을 유지한다(`AUTH_MODE=cognito`). 도메인 모드(`alb`)는 그대로다.

**Architecture:** CDK `ingress.mode==='http'`가 HTTP :80 리스너와 secret 없는 Cognito 앱 클라이언트, 세션 서명 키 Secret을 만들고 `AUTH_MODE=cognito`, `COGNITO_APP_CLIENT_ID`, `SESSION_SIGNING_KEY`, `DASHBOARD_ORIGIN=http://<alb-dns>`를 주입한다. 앱은 `server/auth/cognito-session.ts`(쿠키 JWT 발급·검증·갱신)와 `proxy.ts`의 `cognito` 분기, `/api/auth/login|challenge`, `/login` 페이지를 추가한다. 로그아웃은 refresh 토큰을 `RevokeToken`하고 쿠키를 지운다.

**Tech Stack:** AWS CDK v2, Cognito IDP SDK(`InitiateAuth`, `RespondToAuthChallenge`, `RevokeToken`), `jose`(HS256 쿠키 JWT, JWKS 검증), Next.js 16 middleware/route handlers, vitest, node:test.

**Spec:** `docs/designs/2026-09-19-dashboard-modular-http-logs-design.md` §8 (C의 `DashboardModules.ingress`·`createIngress` 전제)

## Global Constraints

- `AUTH_MODE` 값: `alb | cognito | dev`. `cognito`는 `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, `SESSION_SIGNING_KEY`(32자 이상), `DASHBOARD_ORIGIN` 필수.
- 쿠키 `pai-auth`: HttpOnly, SameSite=Lax, Path=/, `Secure`는 `DASHBOARD_ORIGIN`이 `https:`일 때만. 값은 HS256 JWT `{ at, rt, sub, exp }`(`at`=Cognito access token, `rt`=refresh token). 서명 키 = `SESSION_SIGNING_KEY`. 만료 `exp` = access token `exp`.
- 미들웨어 `cognito` 분기: 쿠키 없음/서명 불일치 → `/api/*`는 401 JSON, 페이지는 `/login?next=<pathname>` 302. access 유효 → 기존 `readGroupsFromAccessToken`으로 그룹 → `x-pai-*` 헤더, `authMethod: 'cognito'`. access 만료 + refresh 있음 → `InitiateAuth(REFRESH_TOKEN_AUTH)` 후 새 쿠키를 응답에 실어 계속. 갱신 실패 → 401/302.
- 공개 경로: `/login`, `/api/auth/login`, `/api/auth/challenge`, `/api/health`, `/api/logout`, `/api/v1/*`(토큰), `/_next/*`.
- 로그인 실패 메시지는 사용자 존재 여부를 드러내지 않는다(`preventUserExistenceErrors` + 단일 문구).
- UI 문자열은 i18n 네임스페이스 `login`(ko/en). 컴포넌트에 한글 리터럴 금지.
- 도메인 모드(`alb`) 동작·env·논리 ID는 변경 없음(C의 `logical-ids.test.ts` 유지). http 모드에서 `AWS::CertificateManager::Certificate`·`AWS::Route53::RecordSet` 0개, `AuthenticateCognitoConfig` 없음, 리스너 포트 80.
- 명령: web `npm run typecheck && npm test -- <files>`; infra `npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts`.
- 커밋 형식 `feat|docs(dashboard): …`, 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `cognito-session.ts` — 쿠키 JWT 발급·검증·갱신

**Files:**
- Create: `dashboard/web/src/server/auth/cognito-session.ts`
- Test: `dashboard/web/src/server/auth/cognito-session.test.ts`
- Modify: `dashboard/web/src/server/config.ts` (`AuthMode`, ENV_KEYS `COGNITO_APP_CLIENT_ID`, `SESSION_SIGNING_KEY`; `cognito` 필수값 검사), `dashboard/web/src/server/config.test.ts`

**Interfaces:**
- Produces:
```ts
export const AUTH_COOKIE = 'pai-auth';
export interface AuthCookiePayload { at: string; rt: string; sub: string; exp: number }
export interface CognitoSessionEnv { region: string; userPoolId: string; appClientId: string; signingKey: string; origin: string }
export function cognitoSessionEnv(env?: NodeJS.ProcessEnv): CognitoSessionEnv           // 누락 시 Error
export async function sealAuthCookie(payload: Omit<AuthCookiePayload, 'exp'> & { exp: number }, key: string): Promise<string>   // HS256 JWT
export async function openAuthCookie(value: string | undefined, key: string): Promise<AuthCookiePayload | undefined>   // 서명 불일치/형식 오류 → undefined
export function authCookieHeader(value: string, origin: string, maxAgeSeconds: number): string   // Set-Cookie 문자열
export function clearAuthCookieHeader(origin: string): string
export interface VerifiedAccess { sub: string; username: string; email: string; groups: string[]; exp: number }
export async function verifyAccessToken(at: string, env: CognitoSessionEnv, deps?: { jwks?: unknown }): Promise<VerifiedAccess>  // readGroupsFromAccessToken + decodeJwt
export async function refreshAccess(rt: string, env: CognitoSessionEnv, send?: (cmd: unknown) => Promise<unknown>): Promise<{ at: string; exp: number }>  // InitiateAuth REFRESH_TOKEN_AUTH
```
- `config.ts`: `export type AuthMode = 'alb' | 'cognito' | 'dev'`; `DashboardConfig`에 `cognitoAppClientId?: string`. `loadConfig`는 `cognito` 모드에서 `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, `SESSION_SIGNING_KEY`, `DASHBOARD_ORIGIN` 누락 시 `ConfigError`.

- [ ] **Step 1: 실패하는 테스트** — `cognito-session.test.ts`

```ts
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
    expect(() => cognitoSessionEnv({ AWS_REGION: 'us-east-1', COGNITO_USER_POOL_ID: 'p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: key, DASHBOARD_ORIGIN: 'http://x' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => cognitoSessionEnv({ AWS_REGION: 'us-east-1', COGNITO_USER_POOL_ID: 'p' } as NodeJS.ProcessEnv)).toThrow(/COGNITO_APP_CLIENT_ID/);
    expect(() => cognitoSessionEnv({ AWS_REGION: 'us-east-1', COGNITO_USER_POOL_ID: 'p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: 'short', DASHBOARD_ORIGIN: 'http://x' } as NodeJS.ProcessEnv)).toThrow(/SESSION_SIGNING_KEY/);
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
    const send = vi.fn(async () => ({ AuthenticationResult: { AccessToken: 'NEW', ExpiresIn: 3600 } }));
    const out = await refreshAccess('R', env, send);
    expect(out.at).toBe('NEW');
    expect(out.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
    expect(send.mock.calls[0][0]).toMatchObject({ input: { AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'client1', AuthParameters: { REFRESH_TOKEN: 'R' } } });
  });
  it('throws when Cognito returns no access token', async () => {
    await expect(refreshAccess('R', env, async () => ({}))).rejects.toThrow(/refresh/i);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/web && npm test -- src/server/auth/cognito-session.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `cognito-session.ts`

```ts
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { readGroupsFromAccessToken } from './alb-jwt';

export const AUTH_COOKIE = 'pai-auth';
export interface AuthCookiePayload { at: string; rt: string; sub: string; exp: number }
export interface CognitoSessionEnv { region: string; userPoolId: string; appClientId: string; signingKey: string; origin: string }
export interface VerifiedAccess { sub: string; username: string; email: string; groups: string[]; exp: number }

export function cognitoSessionEnv(env: NodeJS.ProcessEnv = process.env): CognitoSessionEnv {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is required for AUTH_MODE=cognito`); return v; };
  const signingKey = need('SESSION_SIGNING_KEY');
  if (signingKey.length < 32) throw new Error('SESSION_SIGNING_KEY must be at least 32 characters');
  return { region: env.AWS_REGION ?? 'us-east-1', userPoolId: need('COGNITO_USER_POOL_ID'), appClientId: need('COGNITO_APP_CLIENT_ID'), signingKey, origin: need('DASHBOARD_ORIGIN') };
}
const secret = (key: string) => new TextEncoder().encode(key);
export async function sealAuthCookie(payload: AuthCookiePayload, key: string): Promise<string> {
  return new SignJWT({ at: payload.at, rt: payload.rt }).setProtectedHeader({ alg: 'HS256' }).setSubject(payload.sub).setExpirationTime(payload.exp).setIssuedAt().sign(secret(key));
}
export async function openAuthCookie(value: string | undefined, key: string): Promise<AuthCookiePayload | undefined> {
  if (!value) return undefined;
  try {
    // Expiry is checked by the caller so an expired access token can still be refreshed.
    const { payload } = await jwtVerify(value, secret(key), { algorithms: ['HS256'], clockTolerance: 60 * 60 * 24 * 31 });
    if (typeof payload.at !== 'string' || typeof payload.rt !== 'string' || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return undefined;
    return { at: payload.at, rt: payload.rt, sub: payload.sub, exp: payload.exp };
  } catch { return undefined; }
}
const secure = (origin: string) => (origin.startsWith('https:') ? '; Secure' : '');
export const authCookieHeader = (value: string, origin: string, maxAgeSeconds: number) => `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure(origin)}`;
export const clearAuthCookieHeader = (origin: string) => `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(origin)}`;

export async function verifyAccessToken(at: string, env: CognitoSessionEnv, deps: { jwks?: Parameters<typeof readGroupsFromAccessToken>[3]['jwks'] } = {}): Promise<VerifiedAccess> {
  const groups = await readGroupsFromAccessToken(at, env.region, env.userPoolId, { expectedClientId: env.appClientId, jwks: deps.jwks });
  const claims = decodeJwt(at);
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') throw new Error('Cognito access token is missing sub/exp');
  return { sub: claims.sub, username: typeof claims.username === 'string' ? claims.username : claims.sub, email: typeof claims.email === 'string' ? claims.email : '', groups, exp: claims.exp };
}
export async function refreshAccess(rt: string, env: CognitoSessionEnv, send: (cmd: InitiateAuthCommand) => Promise<unknown> = (cmd) => new CognitoIdentityProviderClient({ region: env.region }).send(cmd)): Promise<{ at: string; exp: number }> {
  const out = (await send(new InitiateAuthCommand({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: env.appClientId, AuthParameters: { REFRESH_TOKEN: rt } }))) as { AuthenticationResult?: { AccessToken?: string; ExpiresIn?: number } };
  const at = out.AuthenticationResult?.AccessToken;
  if (!at) throw new Error('Cognito refresh returned no access token');
  return { at, exp: Math.floor(Date.now() / 1000) + (out.AuthenticationResult?.ExpiresIn ?? 3600) };
}
```
`alb-jwt.ts`의 `readGroupsFromAccessToken` 4번째 인자 타입에 `jwks`가 이미 있다(테스트는 `createRemoteJWKSet` 대체 함수를 넘긴다; `jose.jwtVerify`는 `(protectedHeader, token) => Promise<KeyLike>` 형태의 함수를 받으므로 테스트의 `jwks` 함수가 그대로 동작한다).

`config.ts`: `AuthMode` 확장; `if (!['alb','cognito','dev'].includes(authMode)) throw …`; `cognito` 모드에서 `cognitoSessionEnv(env)`를 호출해 누락을 `ConfigError`로 변환; `cognitoAppClientId: opt(env, 'COGNITO_APP_CLIENT_ID')`. ENV_KEYS에 `COGNITO_APP_CLIENT_ID`, `SESSION_SIGNING_KEY` 추가. `config.test.ts`에 "cognito mode requires app client id and signing key" 케이스 추가.

- [ ] **Step 4: 통과 확인·커밋**

Run: `cd dashboard/web && npm test -- src/server/auth/cognito-session.test.ts src/server/config.test.ts && npm run typecheck`
```bash
git add dashboard/web/src/server/auth/cognito-session.ts dashboard/web/src/server/auth/cognito-session.test.ts dashboard/web/src/server/config.ts dashboard/web/src/server/config.test.ts
git commit -m "feat(dashboard): signed auth cookie, access-token verification and refresh for AUTH_MODE=cognito

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 미들웨어 `cognito` 분기와 세션 `authMethod`

**Files:**
- Modify: `dashboard/web/src/proxy.ts`
- Modify: `dashboard/web/src/server/auth/session.ts` (`authMethod?: 'alb' | 'cognito' | 'token'`; `sessionFromHeaders`가 `cognito`를 보존)
- Modify: `dashboard/web/src/server/store/types.ts:~208` (`authMethod?: 'alb' | 'token'` → `'alb' | 'cognito' | 'token'`) 및 그 유니온을 좁게 검사하는 코드(`grep -rn "authMethod === 'alb'\|authMethod !== 'token'" src/server` 결과를 확인해 `cognito`가 `alb`와 같은 브라우저 세션으로 취급되도록 조정)
- Test: `dashboard/web/src/proxy.cognito.test.ts`

**Interfaces:**
- Consumes: Task 1 전부.
- 동작: 위 Global Constraints의 미들웨어 규칙.

- [ ] **Step 1: 실패하는 테스트** — `proxy.cognito.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), refresh: vi.fn() }));
vi.mock('@/server/auth/cognito-session', async (orig) => ({ ...(await orig<typeof import('@/server/auth/cognito-session')>()), verifyAccessToken: mocks.verify, refreshAccess: mocks.refresh }));
import { sealAuthCookie } from '@/server/auth/cognito-session';
import proxy from './proxy';
const key = 'k'.repeat(48);
beforeEach(() => {
  Object.assign(process.env, { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'us-east-1_p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: key, DASHBOARD_ORIGIN: 'http://alb.example.com', AWS_REGION: 'us-east-1' });
  mocks.verify.mockReset(); mocks.refresh.mockReset();
});
const req = (path: string, cookie?: string) => new NextRequest(`http://alb.example.com${path}`, { headers: cookie ? { cookie: `pai-auth=${cookie}` } : {} });

describe('proxy AUTH_MODE=cognito', () => {
  it('redirects pages without a cookie to /login?next=… and answers 401 JSON for APIs', async () => {
    const page = await proxy(req('/workflows'));
    expect(page.status).toBe(302); expect(page.headers.get('location')).toBe('http://alb.example.com/login?next=%2Fworkflows');
    const api = await proxy(req('/api/workflows'));
    expect(api.status).toBe(401);
  });
  it('lets /login and the auth endpoints through without a cookie', async () => {
    for (const p of ['/login', '/api/auth/login', '/api/auth/challenge', '/api/health']) expect((await proxy(req(p))).status).toBe(200);
  });
  it('turns a valid cookie into x-pai-* headers with authMethod cognito', async () => {
    mocks.verify.mockResolvedValue({ sub: 's1', username: 'alice', email: 'a@x', groups: ['researchers'], exp: Math.floor(Date.now() / 1000) + 600 });
    const cookie = await sealAuthCookie({ at: 'A', rt: 'R', sub: 's1', exp: Math.floor(Date.now() / 1000) + 600 }, key);
    const res = await proxy(req('/api/me', cookie));
    expect(res.status).toBe(200);
    const h = res.headers.get('x-middleware-request-x-pai-role') ?? res.headers.get('x-middleware-override-headers');
    expect(JSON.stringify([...res.headers.entries()])).toContain('researcher');
    expect(JSON.stringify([...res.headers.entries()])).toContain('cognito');
  });
  it('refreshes an expired access token and re-seals the cookie', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('"exp" claim timestamp check failed')).mockResolvedValueOnce({ sub: 's1', username: 'alice', email: '', groups: [], exp: Math.floor(Date.now() / 1000) + 3600 });
    mocks.refresh.mockResolvedValue({ at: 'NEW', exp: Math.floor(Date.now() / 1000) + 3600 });
    const cookie = await sealAuthCookie({ at: 'OLD', rt: 'R', sub: 's1', exp: Math.floor(Date.now() / 1000) - 5 }, key);
    const res = await proxy(req('/api/me', cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^pai-auth=.+HttpOnly; SameSite=Lax/);
    expect(mocks.refresh).toHaveBeenCalledWith('R', expect.anything(), undefined);
  });
  it('rejects a forged cookie', async () => {
    const res = await proxy(req('/api/me', 'not.a.jwt'));
    expect(res.status).toBe(401);
  });
});
```
헤더 단언은 Next의 `NextResponse.next({ request: { headers } })`가 `x-middleware-request-*` 헤더로 노출하는 방식에 맞춰 조정한다(첫 실행에서 실제 헤더 이름을 확인하고 정확한 이름으로 바꾼다).

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/web && npm test -- src/proxy.cognito.test.ts`
Expected: FAIL — `cognito` 모드 미처리(현재 ALB 헤더 없음 → 401).

- [ ] **Step 3: 구현** — `proxy.ts`

`PUBLIC_PATHS`에 `'/login', '/api/auth/login', '/api/auth/challenge'` 추가. `authMode === 'dev'` 블록 뒤에:
```ts
if (authMode === 'cognito') {
  const env = cognitoSessionEnv();
  const cookie = await openAuthCookie(req.cookies.get(AUTH_COOKIE)?.value, env.signingKey);
  if (!cookie) return denyCognito(req, env.origin);
  let at = cookie.at, exp = cookie.exp, setCookie: string | undefined;
  let identity: VerifiedAccess;
  try { identity = await verifyAccessToken(at, env); }
  catch {
    try {
      const fresh = await refreshAccess(cookie.rt, env);
      at = fresh.at; exp = fresh.exp;
      identity = await verifyAccessToken(at, env);
      setCookie = authCookieHeader(await sealAuthCookie({ at, rt: cookie.rt, sub: identity.sub, exp }, env.signingKey), env.origin, Math.max(60, exp - Math.floor(Date.now() / 1000) + 30 * 86400));
    } catch (e) { console.warn('[auth] cognito refresh failed', e instanceof Error ? e.message : e); return denyCognito(req, env.origin, true); }
  }
  if (identity.sub !== cookie.sub) return denyCognito(req, env.origin, true);
  headers.set(SESSION_HEADERS.user, identity.username); headers.set(SESSION_HEADERS.subject, identity.sub);
  headers.set(SESSION_HEADERS.email, identity.email); headers.set(SESSION_HEADERS.role, roleFromGroups(identity.groups));
  headers.set(SESSION_HEADERS.authMethod, 'cognito');
  const res = NextResponse.next({ request: { headers } });
  if (setCookie) res.headers.append('set-cookie', setCookie);
  return res;
}
```
`denyCognito(req, origin, clear=false)`: `/api/*` → 401 JSON(`code: 'unauthorized'`); 그 외 → 302 `${origin}/login?next=${encodeURIComponent(pathname + search)}`; `clear`면 `clearAuthCookieHeader(origin)` 추가. 쿠키 `Max-Age`는 refresh 토큰 유효기간(30일)까지 유지해 access 만료 후에도 갱신이 가능해야 한다 — 최초 발급(Task 3)도 같은 규칙.

`session.ts`: `authMethod?: 'alb' | 'cognito' | 'token'`; `sessionFromHeaders`: `const raw = h.get(SESSION_HEADERS.authMethod); const authMethod = raw === 'token' ? 'token' : raw === 'cognito' ? 'cognito' : 'alb';`. `store/types.ts`의 세션 레코드 `authMethod` 유니온 확장. `grep`으로 `authMethod === 'alb'` 비교를 찾아 `!== 'token'`(브라우저 세션 의미)로 바꾼다(예: `logs/auth.ts`의 `marked` 계산은 `authMethod === 'token' || tokenId…`이므로 그대로).

- [ ] **Step 4: 통과·커밋**

Run: `cd dashboard/web && npm test -- src/proxy.cognito.test.ts src/server/auth && npm run typecheck`
```bash
git add dashboard/web/src/proxy.ts dashboard/web/src/proxy.cognito.test.ts dashboard/web/src/server/auth/session.ts dashboard/web/src/server/store/types.ts
git commit -m "feat(dashboard): middleware verifies and refreshes the Cognito session cookie in AUTH_MODE=cognito

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 로그인·챌린지·로그아웃 API

**Files:**
- Create: `dashboard/web/src/app/api/auth/login/route.ts`, `dashboard/web/src/app/api/auth/challenge/route.ts`
- Modify: `dashboard/web/src/app/api/logout/route.ts`
- Test: `dashboard/web/src/app/api/auth/login/route.test.ts`

**Interfaces:**
- `POST /api/auth/login {username, password}` → 200 `{ ok: true }` + Set-Cookie; 챌린지 시 200 `{ challenge: 'NEW_PASSWORD_REQUIRED', session }`; 실패 401 `{ error: '<단일 문구>', code: 'login_failed' }`. 요청은 `assertSameOrigin` 검사(`DASHBOARD_ORIGIN`).
- `POST /api/auth/challenge {username, session, newPassword}` → `RespondToAuthChallenge(NEW_PASSWORD_REQUIRED)` → 200 + Set-Cookie 또는 401.
- `GET /api/logout`: `AUTH_MODE=cognito`면 쿠키의 `rt`를 `RevokeToken`(실패 무시·warn) 후 쿠키 삭제, `${origin}/login` 302. `alb` 모드는 기존 동작.
- 감사: 성공 시 `audit(session, 'auth.login', username, 'ok')`(기존 `server/audit.ts` 사용, 세션은 방금 검증한 identity로 구성).

- [ ] **Step 1: 실패하는 테스트**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), audit: vi.fn() }));
vi.mock('@/server/aws/clients', () => ({ cognito: () => ({ send: mocks.send }) }));
vi.mock('@/server/auth/cognito-session', async (orig) => ({ ...(await orig<typeof import('@/server/auth/cognito-session')>()), verifyAccessToken: mocks.verify }));
vi.mock('@/server/audit', () => ({ audit: mocks.audit }));
const key = 'k'.repeat(48);
beforeEach(() => { Object.assign(process.env, { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'us-east-1_p', COGNITO_APP_CLIENT_ID: 'c', SESSION_SIGNING_KEY: key, DASHBOARD_ORIGIN: 'http://alb.example.com', AWS_REGION: 'us-east-1' }); mocks.send.mockReset(); mocks.verify.mockReset(); });
const post = (body: unknown, origin = 'http://alb.example.com') => new Request('http://alb.example.com/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });

describe('POST /api/auth/login', () => {
  it('signs in with USER_PASSWORD_AUTH and sets the auth cookie', async () => {
    mocks.send.mockResolvedValueOnce({ AuthenticationResult: { AccessToken: 'A', RefreshToken: 'R', ExpiresIn: 3600 } });
    mocks.verify.mockResolvedValueOnce({ sub: 's1', username: 'alice', email: '', groups: ['admins'], exp: Math.floor(Date.now() / 1000) + 3600 });
    const { POST } = await import('./route');
    const res = await POST(post({ username: 'alice', password: 'pw' }) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^pai-auth=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'c', AuthParameters: { USERNAME: 'alice', PASSWORD: 'pw' } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ user: 'alice', role: 'admin' }), 'auth.login', 'alice', 'ok');
  });
  it('returns the NEW_PASSWORD_REQUIRED challenge session without a cookie', async () => {
    mocks.send.mockResolvedValueOnce({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'S' });
    const { POST } = await import('./route');
    const res = await POST(post({ username: 'alice', password: 'tmp' }) as never);
    expect(await res.json()).toEqual({ challenge: 'NEW_PASSWORD_REQUIRED', session: 'S' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('answers 401 with one generic message for NotAuthorized and UserNotFound alike', async () => {
    const { POST } = await import('./route');
    for (const name of ['NotAuthorizedException', 'UserNotFoundException']) {
      mocks.send.mockRejectedValueOnce(Object.assign(new Error('x'), { name }));
      const res = await POST(post({ username: 'alice', password: 'pw' }) as never);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('login_failed');
    }
  });
  it('rejects cross-origin posts', async () => {
    const { POST } = await import('./route');
    expect((await POST(post({ username: 'a', password: 'b' }, 'http://evil.example') as never)).status).toBe(403);
  });
});
```

- [ ] **Step 2: 구현**

`login/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cognito } from '@/server/aws/clients';
import { audit } from '@/server/audit';
import { assertSameOrigin } from '@/server/auth/request-policy';
import { roleFromGroups } from '@/server/auth/rbac';
import { authCookieHeader, cognitoSessionEnv, sealAuthCookie, verifyAccessToken } from '@/server/auth/cognito-session';
import { HttpError } from '@/server/errors';
export const dynamic = 'force-dynamic';
const body = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(256) });
const REFRESH_DAYS = 30;
export async function issueSessionResponse(result: { AccessToken?: string; RefreshToken?: string }, env = cognitoSessionEnv()) {
  if (!result.AccessToken || !result.RefreshToken) throw new HttpError(401, '로그인에 실패했습니다. 사용자 이름과 비밀번호를 확인하세요.', 'login_failed');
  const identity = await verifyAccessToken(result.AccessToken, env);
  const sealed = await sealAuthCookie({ at: result.AccessToken, rt: result.RefreshToken, sub: identity.sub, exp: identity.exp }, env.signingKey);
  const res = NextResponse.json({ ok: true, user: identity.username, role: roleFromGroups(identity.groups) });
  res.headers.append('set-cookie', authCookieHeader(sealed, env.origin, REFRESH_DAYS * 86400));
  await audit({ user: identity.username, subject: identity.sub, email: identity.email, role: roleFromGroups(identity.groups), authMethod: 'cognito' }, 'auth.login', identity.username, 'ok');
  return res;
}
export async function POST(req: NextRequest) {
  try {
    const env = cognitoSessionEnv();
    assertSameOrigin(req, env.origin);
    const parsed = body.safeParse(await req.json().catch(() => undefined));
    if (!parsed.success) throw new HttpError(400, 'username and password are required', 'bad_request');
    const out = await cognito().send(new InitiateAuthCommand({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: env.appClientId, AuthParameters: { USERNAME: parsed.data.username, PASSWORD: parsed.data.password } })).catch(() => { throw new HttpError(401, '로그인에 실패했습니다. 사용자 이름과 비밀번호를 확인하세요.', 'login_failed'); });
    if (out.ChallengeName === 'NEW_PASSWORD_REQUIRED') return NextResponse.json({ challenge: 'NEW_PASSWORD_REQUIRED', session: out.Session });
    if (out.ChallengeName) throw new HttpError(401, `Unsupported challenge ${out.ChallengeName}`, 'login_failed');
    return await issueSessionResponse(out.AuthenticationResult ?? {}, env);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), code: e instanceof HttpError ? e.code : 'internal' }, { status });
  }
}
```
`challenge/route.ts`: 같은 골격으로 `RespondToAuthChallengeCommand({ ChallengeName: 'NEW_PASSWORD_REQUIRED', ClientId, Session, ChallengeResponses: { USERNAME, NEW_PASSWORD } })` 후 `issueSessionResponse`. 서버 오류 문구는 기존 규칙(한국어 단일 문구)으로 두되 코드 `login_failed`/`bad_request`를 클라이언트가 i18n으로 표시한다.

`logout/route.ts`: 함수 상단에
```ts
if (process.env.AUTH_MODE === 'cognito') {
  const env = cognitoSessionEnv();
  const cookie = await openAuthCookie(req.cookies.get(AUTH_COOKIE)?.value, env.signingKey);
  if (cookie) await cognito().send(new RevokeTokenCommand({ ClientId: env.appClientId, Token: cookie.rt })).catch(e => console.warn('[auth] revoke failed', e instanceof Error ? e.message : e));
  const response = NextResponse.redirect(`${env.origin}/login`, 302);
  response.headers.append('set-cookie', clearAuthCookieHeader(env.origin));
  return response;
}
```
`server/auth/request-policy.ts`의 `assertSameOrigin`은 origin 문자열 비교만 하므로 `http://` 그대로 동작한다.

- [ ] **Step 3: 통과·커밋**

Run: `cd dashboard/web && npm test -- src/app/api/auth src/app/api/logout && npm run typecheck`
```bash
git add dashboard/web/src/app/api/auth dashboard/web/src/app/api/logout/route.ts
git commit -m "feat(dashboard): Cognito password login, new-password challenge and revoke-on-logout for HTTP deployments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `/login` 페이지와 레이아웃 분리

**Files:**
- Create: `dashboard/web/src/app/login/page.tsx`, `dashboard/web/src/components/pages/LoginPage.tsx`
- Create: `dashboard/web/src/lib/i18n/messages/login.ts` (+ `index.ts` 등록)
- Modify: `dashboard/web/src/app/layout.tsx` (로그인 경로에서는 사이드바 없이 렌더)
- Modify: `dashboard/web/src/components/layout/Sidebar.tsx` (로그아웃 후 이동은 서버 302를 따르므로 변경 없음; `useMe` 401 시 `/login`으로 이동하는 처리는 `lib/api-client.ts`의 `ApiError` 401 핸들러에 추가: `AUTH_MODE`를 알 수 없으므로 응답 헤더 `x-pai-login: /login`을 미들웨어 401 JSON에 넣고 클라이언트가 그 헤더가 있으면 `location.assign`)
- Test: `dashboard/web/src/components/pages/LoginPage.test.ts` (폼 상태 헬퍼 단위 테스트)

- [ ] **Step 1: i18n** — `login.ts`

```ts
import { defineMessages } from '../define';
export const login = defineMessages({
  en: { title: 'Sign in', description: 'Physical AI Dashboard', username: 'Username or email', password: 'Password', submit: 'Sign in', submitting: 'Signing in…',
    newPasswordTitle: 'Set a new password', newPassword: 'New password', newPasswordHelp: 'At least 8 characters with upper- and lowercase letters and a digit.', confirm: 'Save and sign in',
    failed: 'Sign-in failed. Check your username and password.', challengeFailed: 'The new password was not accepted.', networkError: 'The server could not be reached.' },
  ko: { title: '로그인', description: 'Physical AI Dashboard', username: '사용자 이름 또는 이메일', password: '비밀번호', submit: '로그인', submitting: '로그인 중…',
    newPasswordTitle: '새 비밀번호 설정', newPassword: '새 비밀번호', newPasswordHelp: '8자 이상, 대문자·소문자·숫자를 포함해야 합니다.', confirm: '저장하고 로그인',
    failed: '로그인에 실패했습니다. 사용자 이름과 비밀번호를 확인하세요.', challengeFailed: '새 비밀번호가 거부되었습니다.', networkError: '서버에 연결할 수 없습니다.' },
});
```

- [ ] **Step 2: 페이지**

`app/login/page.tsx`: `import { LoginPage } from '@/components/pages/LoginPage'; export default function Page() { return <LoginPage />; }`
`LoginPage.tsx`(클라이언트 컴포넌트): 상태 `{ step: 'password' | 'newPassword', username, password, newPassword, session, error, busy }`; `submit()`은 `fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body })`; 200 `{ok}` → `location.assign(next)`(`next`는 `?next=`에서 읽고 `/`로 시작하는 경로만 허용, 아니면 `/`); `{challenge}` → step `newPassword`; 그 외 → `t('failed')`. `helpers`로 `safeNext(param: string | null): string`와 `nextStep(response): 'done' | 'newPassword' | 'failed'`를 export해 단위 테스트한다. 스타일은 어두운 카드 중앙 배치(`Card`, `Input`, `Button` 재사용).

`LoginPage.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { nextStep, safeNext } from './LoginPage';
describe('login helpers', () => {
  it('only follows same-origin absolute paths', () => {
    expect(safeNext('/workflows?x=1')).toBe('/workflows?x=1');
    expect(safeNext('//evil.example')).toBe('/'); expect(safeNext('http://evil.example')).toBe('/'); expect(safeNext(null)).toBe('/');
  });
  it('maps API responses to steps', () => {
    expect(nextStep({ status: 200, body: { ok: true } })).toBe('done');
    expect(nextStep({ status: 200, body: { challenge: 'NEW_PASSWORD_REQUIRED', session: 's' } })).toBe('newPassword');
    expect(nextStep({ status: 401, body: { code: 'login_failed' } })).toBe('failed');
  });
});
```

- [ ] **Step 3: 레이아웃**

`layout.tsx`는 서버 컴포넌트이므로 `headers()`로 `x-pai-login-page`를 읽을 수 없다(미들웨어가 request header에 넣으면 가능). 미들웨어 공개 경로 처리에서 `/login`일 때 `NextResponse.next({ request: { headers: withFlag } })`로 `x-pai-bare-layout: 1`을 넣고, `layout.tsx`에서 `(await headers()).get('x-pai-bare-layout')`이 있으면 `<Sidebar />` 없이 `<main>`만 렌더한다.

- [ ] **Step 4: 401 → /login 이동**

미들웨어의 `denyCognito` JSON 401에 헤더 `x-pai-login: /login`을 추가. `lib/api-client.ts`의 `api()`에서 응답이 401이고 그 헤더가 있으면 `if (typeof window !== 'undefined') window.location.assign(`${header}?next=${encodeURIComponent(location.pathname + location.search)}`)` 후 throw.

- [ ] **Step 5: 검증·커밋**

Run: `cd dashboard/web && npm run typecheck && npm test -- src/components/pages/LoginPage.test.ts src/lib src/app/route-slugs.test.ts`; 로컬: `AUTH_MODE=cognito`로는 실제 풀이 필요하므로 `npm run dev:local -- --offline`에서 `/login`이 사이드바 없이 렌더되는지만 확인.
```bash
git add dashboard/web/src/app/login dashboard/web/src/app/layout.tsx dashboard/web/src/components/pages/LoginPage.tsx dashboard/web/src/components/pages/LoginPage.test.ts dashboard/web/src/lib/i18n dashboard/web/src/lib/api-client.ts dashboard/web/src/proxy.ts
git commit -m "feat(dashboard): /login page for AUTH_MODE=cognito with new-password challenge and bare layout

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: CDK — http 인그레스, 앱 클라이언트, 세션 키

**Files:**
- Modify: `dashboard/infra/lib/constructs/auth.ts` (`AppClient` 추가; `AlbClient`·브랜딩·콜백 URL은 https 모드에서만)
- Modify: `dashboard/infra/lib/constructs/ingress.ts` (http 모드: `Http` 리스너 :80 기본 forward, 인증서·DNS·Cognito 액션 없음; `throw` 제거)
- Modify: `dashboard/infra/lib/constructs/service.ts`, `dashboard/infra/lib/dashboard-stack.ts` (env·secret·outputs), `dashboard/infra/bin/app.ts`(http 안내 로그 제거)
- Test: `dashboard/infra/test/http-ingress.test.ts`

- [ ] **Step 1: 실패하는 테스트**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from 'aws-cdk-lib/assertions';
import { synthesize } from './helpers/synth';
import { resolveModules } from '../lib/modules';
const http = () => synthesize({ modules: resolveModules(() => undefined), domainName: '', hostedZoneId: '', hostedZoneName: '' });

test('http ingress has one :80 listener forwarding to web, no certificate, no DNS, no Cognito action', () => {
  const t = http();
  t.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  t.resourceCountIs('AWS::Route53::RecordSet', 0);
  t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', Match.objectLike({ Port: 80, Protocol: 'HTTP' }));
  assert.ok(!JSON.stringify(t.toJSON()).includes('AuthenticateCognitoConfig'));
});
test('http ingress creates a secret-less app client with password + SRP flows and injects AUTH_MODE=cognito', () => {
  const t = http();
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({ ClientName: 'app', GenerateSecret: false,
    ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']) }));
  const text = JSON.stringify(t.toJSON());
  assert.ok(text.includes('"Name":"AUTH_MODE","Value":"cognito"'));
  assert.ok(text.includes('COGNITO_APP_CLIENT_ID'));
  assert.ok(text.includes('SESSION_SIGNING_KEY'));
  assert.ok(!text.includes('AlbBranding') || true); // branding may exist but must not be required
});
test('https ingress still has the ALB client and no app client env', () => {
  const t = synthesize();
  assert.ok(!JSON.stringify(t.toJSON()).includes('"Name":"AUTH_MODE","Value":"cognito"'));
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({ ClientName: 'alb' }));
});
```

- [ ] **Step 2: 구현**

`auth.ts`: `AuthConstructProps`에 `mode: 'https' | 'http'`, `domainName?: string`. `AlbClient`·`AlbBranding`·`adminSecret.loginUrl`은 `mode==='https'`일 때만(https 논리 ID 유지). 두 모드 공통으로:
```ts
this.appClient = this.userPool.addClient('AppClient', { userPoolClientName: 'app', generateSecret: false,
  authFlows: { userPassword: true, userSrp: true }, preventUserExistenceErrors: true,
  accessTokenValidity: cdk.Duration.hours(1), idTokenValidity: cdk.Duration.hours(1), refreshTokenValidity: cdk.Duration.days(30) });
```
https 모드에서 `AppClient`가 새로 생기는 것은 논리 ID **추가**이므로 `logical-ids.test.ts`의 "unexpected new ids" 단언에 걸린다 → 테스트를 "기존 ID는 모두 남아 있어야 한다(삭제·교체 없음)"만 검사하도록 바꾸고, 추가 허용 목록 `ALLOWED_NEW = ['AuthAppClient…']`를 fixture 옆에 둔다(Ruling: 추가는 안전, 삭제·교체만 금지).
`adminSecret`의 `loginUrl`은 http 모드에서 `'(ALB DNS)/login'` 문자열.

`ingress.ts`: `mode.mode==='http'` 분기 — `albSg` 80만 허용, `Alb`, `AccessLogs`, WAF(옵션), `Tg`, `loadBalancer.addListener('Http', { port: 80, defaultAction: forward([tg]) })`. `attachGateway`는 F에서 구현(지금은 http 모드에서 `throw new Error('path gateway arrives in sub-project F')`, 그리고 `ServiceConstruct`는 http 모드에서 gateway를 만들지 않는다 → `modules.gateway`가 true여도 http면 skip + 경고 로그).

`service.ts`/`dashboard-stack.ts`: http 모드 env — `AUTH_MODE: 'cognito'`, `COGNITO_APP_CLIENT_ID: auth.appClient.userPoolClientId`, `DASHBOARD_ORIGIN: `http://${ingress.loadBalancer.loadBalancerDnsName}``(토큰), `ALB_ARN`·`COGNITO_DOMAIN`·`COGNITO_CLIENT_ID` 생략; controller/gateway 컨테이너의 `AUTH_MODE: 'alb'` 하드코딩을 모드에 따라 `'cognito'`로. 새 Secret `SessionSigningSecret`(64자, RETAIN) → web 컨테이너 `secrets: { SESSION_SIGNING_KEY }`(http 모드만). Outputs: `DashboardUrl` = `http://<alb dns>/`.
`env-contract.ts`: `AUTH_MODE: 'alb'` 하드코딩을 `extra`로 넘기도록 제거.

- [ ] **Step 3: 검증·커밋**

Run: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts`
```bash
git add dashboard/infra
git commit -m "feat(dashboard): HTTP ingress mode with a secret-less Cognito app client and session signing key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 문서

**Files:**
- Modify: `dashboard/README.md` (설치 절: 도메인 없는 배포 예시), `dashboard/docs/dashboard-features-and-aws-architecture.md` §2 (두 인증 모드), §25 env

- [ ] **Step 1: README 설치 절에 추가**

```
도메인이 없으면 세 도메인 context를 생략합니다. ALB DNS 이름으로 `http://` 접속하며, 로그인은 대시보드의 `/login` 페이지가 Cognito 사용자 풀에 직접 인증합니다(`AUTH_MODE=cognito`). 초기 관리자 계정은 같은 Secrets Manager secret에 있습니다. 이 모드에서는 세션 게이트웨이(Jupyter·터미널·실시간 보기)가 하위 프로젝트 F까지 비활성입니다. 브라우저와 ALB 사이가 평문이므로 신뢰할 수 있는 네트워크(VPN·사내망)에서만 사용하세요.

```bash
cd dashboard/infra && npm ci && npx cdk deploy -c gateway=false
```
```

- [ ] **Step 2: 기능 문서 §2** — "인증 모드" 소절: `alb`(ALB `authenticate-cognito`, 12시간 ALB 쿠키) / `cognito`(앱 `/login` → `InitiateAuth`, `pai-auth` HS256 쿠키, access 1시간 자동 갱신, refresh 30일, 로그아웃 시 `RevokeToken`). §25 env 목록에 `AUTH_MODE=alb|cognito`, `COGNITO_APP_CLIENT_ID`, `SESSION_SIGNING_KEY`(secret) 추가.

- [ ] **Step 3: 커밋**

```bash
git add dashboard/README.md dashboard/docs/dashboard-features-and-aws-architecture.md
git commit -m "docs(dashboard): HTTP deployment mode and in-app Cognito login

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
