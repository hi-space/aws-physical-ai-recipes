# Dashboard F — 경로 기반 세션 게이트웨이 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도메인 없는 HTTP 배포에서도 세션(Jupyter·code-server·TensorBoard·터미널·파일·실시간 보기·DCV)을 쓸 수 있도록, 게이트웨이를 `GATEWAY_MODE=path`에서 `http://<ALB DNS>:8080/s/<sessionId>/…` 경로 기반으로 동작시킨다. 대시보드(:80)와 다른 origin(포트)이라 세션 앱의 XSS가 대시보드 쿠키에 닿지 않는다. 기존 host 모드(`<id>.apps.<domain>`)는 그대로 둔다.

**Architecture:** `server/gateway/routing.ts`가 모드별로 (host | path) → `{ sessionId, prefix, publicOrigin }`를 해석한다. `auth.ts`의 티켓·쿠키 grant는 `host` 대신 `binding` 문자열(`<origin>/s/<id>` 또는 `<host>`)에 바인딩된다. `server.ts`는 path 모드에서 접두어를 벗겨 upstream에 보내고, `headers.ts`는 `Location`·`Set-Cookie Path`·`X-Forwarded-Prefix`를 접두어에 맞게 재작성한다. 업스트림 앱은 `PAI_SESSION_PREFIX` env로 base path를 받는다(Jupyter `base_url`, TensorBoard `path_prefix`; code-server는 상대경로). CDK는 http 모드에서 ALB :8080 리스너를 게이트웨이로 연결한다.

**Tech Stack:** Node `http` 서버(게이트웨이), Next.js 16, Python(session.py), Go(files server), AWS CDK v2, vitest/Playwright.

**Spec:** `docs/designs/2026-09-19-dashboard-modular-http-logs-design.md` §9 (E의 http 인그레스·`DASHBOARD_ORIGIN=http://…` 전제)

## Global Constraints

- 모드: `GATEWAY_MODE=host|path`. https 배포 기본 `host`(변경 없음). http 배포는 `path`. path 모드 필수 env: `GATEWAY_PUBLIC_ORIGIN`(예 `http://alb-123.us-east-1.elb.amazonaws.com:8080`), `DASHBOARD_ORIGIN`(`http://` 허용).
- 경로 규약: `/s/<sessionId>/<rest>`; `<sessionId>`는 기존 `labelPattern`. 접두어 없는 요청은 401(`/health` 제외).
- 쿠키: path 모드 `pai-session-<id>`, `Path=/s/<id>/`, `HttpOnly`, `SameSite=Strict`, `Secure`는 `GATEWAY_PUBLIC_ORIGIN`이 https일 때만, `__Host-` 접두어 없음. host 모드는 현재 `__Host-pai-session` 그대로.
- grant 레코드는 `host` 필드 대신 `binding` 필드를 저장한다(host 모드 값 = 기존 host 문자열이라 기존 grant와 호환). 티켓 URL: host 모드 `https://<host>/?ticket=`, path 모드 `${GATEWAY_PUBLIC_ORIGIN}/s/<id>/?ticket=`.
- upstream 헤더: path 모드 `X-Forwarded-Prefix: /s/<id>`, `X-Forwarded-Proto`는 공개 origin의 스킴, `Host`는 공개 origin의 host. downstream: 루트 상대 `Location`에 접두어를 붙이고, `Set-Cookie`의 `Path=/…`를 `Path=/s/<id>/…`로, `__Host-` 접두 앱 쿠키는 `pai-app-` 이름으로 바꾸며 `Secure` 강제는 https일 때만.
- Origin 검사: path 모드 기대 origin = `GATEWAY_PUBLIC_ORIGIN`; 티켓 교환은 `DASHBOARD_ORIGIN`도 허용(http 정규식 허용).
- 업스트림 앱: `PAI_SESSION_PREFIX`(`/s/<id>` 또는 빈 문자열)을 세션 Pod에 주입. Jupyter `--ServerApp.base_url=<prefix>/`, TensorBoard `--path_prefix=<prefix>`. live-view·files 서버·터미널 페이지는 상대 URL만 사용.
- DCV: 접두어 제거 후 통과. 임베드는 host 모드만; path 모드는 "새 창"만 노출(실측 후 README에 기록).
- 대시보드 `/api/me`에 `gateway: { mode, origin? }` 추가; 클라이언트 URL 검증은 모드별.
- 명령: web `npm run typecheck && npm test -- <files>`; infra 테스트; `session-image`는 `python3 -m pytest session-image/test_session_image.py`.
- 커밋 형식 `feat|docs(dashboard): …`, 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `routing.ts` — 모드 해석과 바인딩

**Files:**
- Create: `dashboard/web/src/server/gateway/routing.ts`
- Test: `dashboard/web/src/server/gateway/routing.test.ts`
- Modify: `dashboard/web/src/server/gateway/types.ts` (`AuthOptions`에 `mode?`, `publicOrigin?` 추가)

**Interfaces:**
- Produces:
```ts
export type GatewayMode = 'host' | 'path';
export interface GatewayRoute { mode: GatewayMode; sessionId: string; binding: string; publicOrigin: string; prefix: string; rest: string }
export function gatewayMode(options?: AuthOptions): GatewayMode                  // env GATEWAY_MODE, 기본 host
export function publicOrigin(options?: AuthOptions): string                       // path: GATEWAY_PUBLIC_ORIGIN(검증 ^https?://[a-z0-9.-]+(:\d+)?$); host: 'https://' + host 는 요청마다 다르므로 throw
export function resolveRoute(req: { host?: string; path: string }, options?: AuthOptions): GatewayRoute
export function launchUrl(sessionId: string, options?: AuthOptions): { url: string; binding: string }
export function cookieName(sessionId: string, options?: AuthOptions): string       // host: '__Host-pai-session', path: `pai-session-${id}`
export function cookieAttributes(sessionId: string, maxAge: number, expires: Date, options?: AuthOptions): string
```
- host 모드 `binding` = 호스트 문자열(기존 grant와 동일), `prefix` = `''`, `rest` = 원래 path. path 모드 `binding` = `${publicOrigin}/s/${id}`, `prefix` = `/s/${id}`, `rest` = 접두어를 뗀 나머지(`/`로 시작, 비어 있으면 `/`).

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it } from 'vitest';
import { cookieAttributes, cookieName, gatewayMode, launchUrl, resolveRoute } from './routing';
const host = { baseDomain: 'apps.example.com' };
const path = { mode: 'path' as const, publicOrigin: 'http://alb.example.com:8080' };
describe('host mode (unchanged)', () => {
  it('resolves the session from the host label and keeps the whole path', () => {
    expect(resolveRoute({ host: 'abc.apps.example.com', path: '/lab?x=1' }, host)).toEqual({ mode: 'host', sessionId: 'abc', binding: 'abc.apps.example.com', publicOrigin: 'https://abc.apps.example.com', prefix: '', rest: '/lab?x=1' });
    expect(launchUrl('abc', host)).toEqual({ url: 'https://abc.apps.example.com/?ticket=', binding: 'abc.apps.example.com' });
    expect(cookieName('abc', host)).toBe('__Host-pai-session');
    expect(cookieAttributes('abc', 60, new Date(0), host)).toBe('Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });
});
describe('path mode', () => {
  it('resolves /s/<id>/rest, strips the prefix and binds to origin+prefix', () => {
    expect(resolveRoute({ host: 'alb.example.com:8080', path: '/s/abc/lab/tree?x=1' }, path)).toEqual({ mode: 'path', sessionId: 'abc', binding: 'http://alb.example.com:8080/s/abc', publicOrigin: 'http://alb.example.com:8080', prefix: '/s/abc', rest: '/lab/tree?x=1' });
    expect(resolveRoute({ host: 'alb.example.com:8080', path: '/s/abc' }, path).rest).toBe('/');
    expect(() => resolveRoute({ host: 'alb.example.com:8080', path: '/lab' }, path)).toThrow(/Session authorization/);
    expect(() => resolveRoute({ host: 'alb.example.com:8080', path: '/s/Not_Valid/x' }, path)).toThrow();
    expect(() => resolveRoute({ host: 'other.example.com', path: '/s/abc/' }, path)).toThrow(/Host/);
  });
  it('builds the launch URL, a per-session cookie without the __Host- prefix and Secure only on https', () => {
    expect(launchUrl('abc', path)).toEqual({ url: 'http://alb.example.com:8080/s/abc/?ticket=', binding: 'http://alb.example.com:8080/s/abc' });
    expect(cookieName('abc', path)).toBe('pai-session-abc');
    expect(cookieAttributes('abc', 60, new Date(0), path)).toBe('Path=/s/abc/; HttpOnly; SameSite=Strict; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cookieAttributes('abc', 60, new Date(0), { ...path, publicOrigin: 'https://gw.example.com' })).toContain('; Secure;');
  });
  it('requires a valid GATEWAY_PUBLIC_ORIGIN', () => {
    expect(() => gatewayMode({ mode: 'path' })).not.toThrow();
    expect(() => launchUrl('abc', { mode: 'path', publicOrigin: 'alb.example.com' })).toThrow(/GATEWAY_PUBLIC_ORIGIN/);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- src/server/gateway/routing.test.ts` → 모듈 없음.

- [ ] **Step 3: 구현**

```ts
import { GatewayError, type AuthOptions } from './types';
import { notConfigured } from '../errors';
import { baseDomain, sessionHost, sessionIdFromHost } from './auth';
export type GatewayMode = 'host' | 'path';
export interface GatewayRoute { mode: GatewayMode; sessionId: string; binding: string; publicOrigin: string; prefix: string; rest: string }
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const invalid = () => new GatewayError(401, 'Session authorization expired or invalid');
export function gatewayMode(o: AuthOptions = {}): GatewayMode {
  const m = o.mode ?? process.env.GATEWAY_MODE ?? 'host';
  if (m !== 'host' && m !== 'path') throw new GatewayError(500, 'GATEWAY_MODE must be host or path');
  return m;
}
export function publicOrigin(o: AuthOptions = {}): string {
  const origin = o.publicOrigin ?? process.env.GATEWAY_PUBLIC_ORIGIN;
  if (!origin) throw notConfigured('Session gateway (GATEWAY_PUBLIC_ORIGIN)');
  if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin)) throw new GatewayError(500, 'GATEWAY_PUBLIC_ORIGIN is malformed');
  return origin;
}
export function resolveRoute(req: { host?: string; path: string }, o: AuthOptions = {}): GatewayRoute {
  if (gatewayMode(o) === 'host') {
    const sessionId = sessionIdFromHost(req.host, o);
    return { mode: 'host', sessionId, binding: req.host!, publicOrigin: `https://${req.host}`, prefix: '', rest: req.path };
  }
  const origin = publicOrigin(o);
  if (!req.host || req.host.toLowerCase() !== new URL(origin).host.toLowerCase()) throw new GatewayError(403, 'Host does not match the gateway origin');
  const m = /^\/s\/([^/?#]+)(\/[^#]*|)(\?.*)?$/.exec(req.path);
  if (!m || !label.test(m[1])) throw invalid();
  const sessionId = m[1], rest = (m[2] || '/') + (m[3] ?? '');
  return { mode: 'path', sessionId, binding: `${origin}/s/${sessionId}`, publicOrigin: origin, prefix: `/s/${sessionId}`, rest };
}
export function launchUrl(sessionId: string, o: AuthOptions = {}): { url: string; binding: string } {
  if (!label.test(sessionId)) throw invalid();
  if (gatewayMode(o) === 'host') { const host = sessionHost(sessionId, o); return { url: `https://${host}/?ticket=`, binding: host }; }
  const origin = publicOrigin(o);
  return { url: `${origin}/s/${sessionId}/?ticket=`, binding: `${origin}/s/${sessionId}` };
}
export const cookieName = (sessionId: string, o: AuthOptions = {}) => (gatewayMode(o) === 'host' ? '__Host-pai-session' : `pai-session-${sessionId}`);
export function cookieAttributes(sessionId: string, maxAge: number, expires: Date, o: AuthOptions = {}): string {
  if (gatewayMode(o) === 'host') return `Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${expires.toUTCString()}`;
  const secure = publicOrigin(o).startsWith('https:') ? ' Secure;' : '';
  return `Path=/s/${sessionId}/;${secure} HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${expires.toUTCString()}`;
}
```
`types.ts` `AuthOptions`에 `mode?: GatewayMode; publicOrigin?: string;` 추가(타입 순환을 피하려면 `mode?: 'host' | 'path'` 리터럴로).

- [ ] **Step 4: 통과·커밋**

```bash
git add dashboard/web/src/server/gateway/routing.ts dashboard/web/src/server/gateway/routing.test.ts dashboard/web/src/server/gateway/types.ts
git commit -m "feat(dashboard): gateway routing for host and path modes with per-mode cookie and launch URL

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `auth.ts` grant 바인딩 일반화

**Files:**
- Modify: `dashboard/web/src/server/gateway/auth.ts` (`issueLaunchTicket`, `consumeTicket`, `authorizeCookie`)
- Modify: `dashboard/web/src/server/gateway/auth.test.ts`, `token-fixtures.test-helpers.ts`(host 픽스처 유지 + path 케이스 추가)

**Interfaces:**
- `issueLaunchTicket(record, principal, options)` → `{ ticket, url, expiresAt, binding }`(`host` 필드는 호환용으로 host 모드에서만 유지). grant 아이템은 `binding` 필드(host 모드에서는 기존 `host` 필드도 함께 써서 롤백 호환).
- `consumeTicket(ticket, route: GatewayRoute, options)` / `authorizeCookie(cookieHeader, route: GatewayRoute, options)` — 두 함수는 `host: string` 대신 `GatewayRoute`를 받는다. 쿠키 이름은 `cookieName(route.sessionId)`; 정확히 하나만 허용.

- [ ] **Step 1: 테스트** — 기존 `auth.test.ts`의 host 케이스를 `resolveRoute({ host, path: '/' }, options)`로 감싸 통과시키고, path 케이스 추가:
```ts
it('path mode: ticket exchange sets a per-session path cookie and the grant binds to origin+prefix', async () => {
  const options = { repo, now, mode: 'path' as const, publicOrigin: 'http://alb.example.com:8080' };
  const issued = await issueLaunchTicket(session, principal, options);
  expect(issued.url).toBe(`http://alb.example.com:8080/s/${session.id}/?ticket=${issued.ticket}`);
  const route = resolveRoute({ host: 'alb.example.com:8080', path: `/s/${session.id}/?ticket=${issued.ticket}` }, options);
  const exchange = await consumeTicket(issued.ticket, route, options);
  expect(exchange.cookie).toMatch(new RegExp(`^pai-session-${session.id}=[A-Za-z0-9_-]{43}; Path=/s/${session.id}/; HttpOnly; SameSite=Strict`));
  const cookieValue = exchange.cookie.split(';')[0];
  await expect(authorizeCookie(cookieValue, route, options)).resolves.toMatchObject({ id: session.id });
  await expect(authorizeCookie(cookieValue, resolveRoute({ host: 'alb.example.com:8080', path: '/s/other/' }, options), options)).rejects.toThrow();
});
```

- [ ] **Step 2: 구현** — `auth.ts`
- `issueLaunchTicket`: `const { url, binding } = launchUrl(sessionRecord.id, options);` grant put에 `binding`(+ host 모드면 `host: binding`). 반환 `{ ticket, url: `${url}${ticket}`, expiresAt, binding, host: gatewayMode(options)==='host' ? binding : undefined }`.
- `consumeTicket(ticket, route, options)`: `grant.binding ?? grant.host`가 `route.binding`과 같아야 함; 쿠키 문자열은 `${cookieName(route.sessionId, options)}=${secret}; ${cookieAttributes(route.sessionId, maxAge, expires, options)}`; 트랜잭션 조건 `equals`에 `binding` 사용(레거시 grant는 `host`).
- `authorizeCookie(cookieHeader, route, options)`: `cookieName(route.sessionId)`로 필터; grant의 `binding ?? host`가 `route.binding`과 일치.
- `sessionHostsConfigured()`는 `GATEWAY_BASE_DOMAIN || (GATEWAY_MODE==='path' && GATEWAY_PUBLIC_ORIGIN)`로 확장하고 이름을 `sessionGatewayConfigured`로 바꾸되 기존 이름도 alias export(호출부 `services/sessions.ts`, `dcv/sessions.ts`).

- [ ] **Step 3: 통과·커밋** — `npm test -- src/server/gateway`
```bash
git add dashboard/web/src/server/gateway
git commit -m "feat(dashboard): gateway grants bind to origin+prefix in path mode; per-session cookie name

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `server.ts`·`headers.ts`·`lifetime.ts` — 접두어 제거와 재작성

**Files:**
- Modify: `dashboard/web/src/server/gateway/server.ts`, `headers.ts`, `lifetime.ts`, `terminal.ts`, `browser/terminal-client.js`
- Modify tests: `server.test.ts`, `headers.test.ts`, `terminal.test.ts`, `connect-timeout.test.ts`, `token-lifetime.test.ts`(host 픽스처는 그대로 통과해야 함) + path 케이스

**Interfaces:**
- `requestUrl(req, options)` → `{ route: GatewayRoute; url: URL }` (`url`은 `${route.publicOrigin}${route.prefix}${route.rest}`).
- `upstreamHeaders(headers, route, websocket)`: `host`=`new URL(route.publicOrigin).host`, `x-forwarded-host` 동일, `x-forwarded-proto`=origin 스킴, path 모드면 `x-forwarded-prefix: route.prefix`. referer origin 비교는 `route.publicOrigin`.
- `downstreamHeaders(headers, route, websocket, requestPath, frameAncestors?)`: `Location` 재작성 — 절대 URL이면 origin을 `publicOrigin`으로 바꾸고 path 모드에서 경로가 `route.prefix`로 시작하지 않으면 접두어를 붙인다; `Set-Cookie`는 `isolatedCookies(cookies, route)` — path 모드에서 `Path=` 속성을 `Path=${route.prefix}${원래 path 또는 '/'}`로, 없으면 `Path=${route.prefix}/` 추가, `__Host-` 이름은 `pai-app-` + 나머지, `Secure` 강제는 https일 때만. `frameAncestors` 정규식은 `^https?://[a-z0-9.-]+(:\d+)?$`.
- `outgoing(...)`: `path: route.rest`.
- `checkOrigin(req, route, websocket, exchange, options)`: 기대 origin = `route.publicOrigin`; `dashboardOrigin()` 정규식 `^https?://…`.
- 터미널: `terminalPage`의 자산 경로를 `__gateway/assets/terminal.css|js`(상대), `terminal-client.js`의 `new URL('__gateway/terminal', location.href)`; server.ts의 자산 매칭은 `url.pathname`이 아니라 `route.rest`로(`/__gateway/assets/...`). 터미널 CSP `frame-ancestors 'none'` 유지.
- `lifetime.ts`: `guardConnection(session, cookie, route, controller, options)`; 재검증은 `authorizeCookie(cookie, route, options)`.
- 티켓 교환 303 `location`: `${route.prefix}${rest without ticket}`.

- [ ] **Step 1: 테스트 추가(발췌)** — `headers.test.ts`
```ts
const pathRoute = { mode: 'path' as const, sessionId: 'abc', binding: 'http://alb:8080/s/abc', publicOrigin: 'http://alb:8080', prefix: '/s/abc', rest: '/lab' };
it('path mode: adds X-Forwarded-Prefix, prefixes root-relative Location and scopes Set-Cookie paths', () => {
  const up = upstreamHeaders({ host: 'alb:8080', cookie: 'pai-session-abc=x; theme=dark' }, pathRoute);
  expect(up).toMatchObject({ host: 'alb:8080', 'x-forwarded-prefix': '/s/abc', 'x-forwarded-proto': 'http', cookie: 'theme=dark' });
  const down = downstreamHeaders({ location: '/lab/tree', 'set-cookie': ['sid=1; Path=/; Secure', '__Host-app=2; Path=/; Secure'] }, pathRoute, false, '/lab');
  expect(down.location).toBe('http://alb:8080/s/abc/lab/tree');
  expect(down['set-cookie']).toEqual(['sid=1; Path=/s/abc/', 'pai-app-app=2; Path=/s/abc/']);
});
it('host mode output is unchanged', () => { /* 기존 단언 그대로 */ });
```
`server.test.ts`: path 모드 서버 픽스처(`options.mode='path'`, `publicOrigin`)에서 `GET /s/<id>/?ticket=` → 303 `location: /s/<id>/` + `set-cookie pai-session-<id>`; 이후 `GET /s/<id>/lab`이 upstream에 `GET /lab`으로 도달; `GET /lab`(접두어 없음) → 401.

- [ ] **Step 2: 구현** — 위 인터페이스대로. 모든 `https://${host}` 문자열 리터럴을 `route.publicOrigin`으로 치환한다(`grep -n "https://\${host}" server.ts headers.ts auth.ts`가 비어야 함).

- [ ] **Step 3: 통과·커밋** — `npm test -- src/server/gateway && npm run typecheck && npm run build:services`
```bash
git add dashboard/web/src/server/gateway
git commit -m "feat(dashboard): path-mode gateway strips /s/<id>, rewrites Location/Set-Cookie and forwards the prefix

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 업스트림 앱의 base path

**Files:**
- Modify: `dashboard/session-image/session.py`, `dashboard/session-image/test_session_image.py`
- Modify: `dashboard/web/src/server/services/sessions.ts` (`sessionJob`의 workspace 컨테이너 env에 `PAI_SESSION_PREFIX`)
- Modify: `dashboard/web/src/server/workflow/live-view.ts` (페이지 JS의 `/stream`, `/status.json` → `stream`, `status.json`)
- Modify: `dashboard/runtime/files_linux.go` (`fileBrowserHTML()`의 절대 링크를 상대 링크로), `dashboard/runtime/*_test.go` 해당 단언

- [ ] **Step 1: session.py**
```python
def command(kind, prefix=""):
    if prefix and (not prefix.startswith("/s/") or prefix.endswith("/") or len(prefix) > 80):
        raise ValueError("Invalid session prefix")
    if kind == "tensorboard":
        return ["tensorboard", "--logdir=/logs", "--host=127.0.0.1", "--port=6006", "--reload_interval=15"] + ([f"--path_prefix={prefix}"] if prefix else [])
    if kind == "jupyter":
        return ["jupyter", "lab", "--ServerApp.ip=127.0.0.1", "--ServerApp.port=8888", "--ServerApp.port_retries=0", "--ServerApp.open_browser=False",
                "--ServerApp.root_dir=/workspace", "--ServerApp.allow_remote_access=True", "--ServerApp.trust_xheaders=True",
                "--IdentityProvider.token=", "--PasswordIdentityProvider.hashed_password="] + ([f"--ServerApp.base_url={prefix}/"] if prefix else [])
    ...
```
`main()`에서 `prefix = os.environ.get("PAI_SESSION_PREFIX", "")`를 읽어 `command(args[0], prefix)`. 테스트: `test_session_image.py`에 `command('jupyter', '/s/abc')`가 `--ServerApp.base_url=/s/abc/`를 포함, `command('tensorboard', '/s/abc')`가 `--path_prefix=/s/abc`, 잘못된 prefix는 `ValueError`.

- [ ] **Step 2: sessions.ts** — workspace 컨테이너 `env`에 `{ name: 'PAI_SESSION_PREFIX', value: gatewayMode() === 'path' ? `/s/${s.id}` : '' }` 추가(`routing.ts`의 `gatewayMode` import). 기존 `sessions.test.ts`의 Job 스냅샷 단언이 있으면 env 항목 추가를 반영.

- [ ] **Step 3: live-view.ts** — `v.src='/stream?'+Date.now()` → `v.src='stream?'+Date.now()`, `fetch('/status.json'…)` → `fetch('status.json'…)`. 서버 측 라우팅(`path == "/"`, `/stream`, `/status.json`)은 게이트웨이가 접두어를 벗기므로 변경 없음. `live-view.test.ts`에 페이지 문자열에 `'/stream'`·`'/status.json'` 절대경로가 없다는 단언 추가.

- [ ] **Step 4: files server** — `fileBrowserHTML()`에서 `href="/files/…"`, `fetch('/api/files…')` 등 절대 경로를 `files/…`, `api/files…` 상대 경로로. `go test ./...`(runtime) 통과.

- [ ] **Step 5: 커밋**
```bash
git add dashboard/session-image dashboard/web/src/server/services/sessions.ts dashboard/web/src/server/workflow/live-view.ts dashboard/runtime
git commit -m "feat(dashboard): session apps honour PAI_SESSION_PREFIX; live view and file browser use relative URLs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 대시보드 클라이언트와 `/api/me`

**Files:**
- Modify: `dashboard/web/src/app/api/me/route.ts` (`gateway: { mode, origin? }`, `features.sessions` 조건)
- Modify: `dashboard/web/src/server/config.ts` (`GATEWAY_MODE`, `GATEWAY_PUBLIC_ORIGIN` ENV_KEYS + config 필드)
- Modify: `dashboard/web/src/components/workflows/TaskConnections.tsx:~172`, `dashboard/web/src/components/sessions/DcvBrowserCard.tsx:~30`
- Modify: `dashboard/web/src/lib/api-client.ts` (`Me` 타입에 `gateway`)
- Tests: `TaskConnections.browser.test.ts`, `src/app/api/sessions/routes.test.ts` path 픽스처

- [ ] **Step 1: 클라이언트 URL 검증 헬퍼** — `dashboard/web/src/lib/session-url.ts`
```ts
export function isSafeLaunchUrl(url: URL, sessionId: string, gateway: { mode: 'host' | 'path'; origin?: string } | undefined): boolean {
  if (url.username || url.password || !url.searchParams.get('ticket')) return false;
  if (gateway?.mode === 'path') return !!gateway.origin && url.origin === gateway.origin && url.pathname.startsWith(`/s/${sessionId}/`);
  return url.protocol === 'https:' && url.hostname.startsWith(`${sessionId}.`);
}
```
단위 테스트 `session-url.test.ts`(host 통과/실패, path 통과/타 origin 실패/타 세션 접두어 실패).
`TaskConnections.tsx`·`DcvBrowserCard.tsx`의 인라인 검사를 `isSafeLaunchUrl(url, id, me.data?.gateway)`로 교체. DCV 카드: `me.data?.gateway?.mode === 'path'`면 "여기서 보기" 버튼을 숨기고 "새 창"만 노출.

- [ ] **Step 2: `/api/me`** — `gateway: c.gatewayMode === 'path' ? { mode: 'path', origin: c.gatewayPublicOrigin } : { mode: 'host' }`; `features.sessions: Boolean(c.gatewayBaseDomain || (c.gatewayMode === 'path' && c.gatewayPublicOrigin))`.

- [ ] **Step 3: 통과·커밋** — `npm run typecheck && npm test -- src/lib src/components src/app/api/sessions src/app/api/me`
```bash
git add dashboard/web/src
git commit -m "feat(dashboard): clients validate launch URLs per gateway mode; /api/me exposes gateway mode and origin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: CDK — http 모드 게이트웨이 리스너 :8080

**Files:**
- Modify: `dashboard/infra/lib/constructs/ingress.ts` (`attachGateway` path 모드 구현), `service.ts`, `dashboard-stack.ts`
- Test: `dashboard/infra/test/http-ingress.test.ts`(추가 케이스)

- [ ] **Step 1: 테스트**
```ts
test('http ingress with gateway adds a :8080 listener to the gateway service and injects GATEWAY_MODE=path', () => {
  const t = http(); // gateway 기본 true
  t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', Match.objectLike({ Port: 8080, Protocol: 'HTTP' }));
  const text = JSON.stringify(t.toJSON());
  assert.ok(text.includes('"Name":"GATEWAY_MODE","Value":"path"'));
  assert.ok(text.includes('GATEWAY_PUBLIC_ORIGIN'));
  assert.ok(!text.includes('GATEWAY_BASE_DOMAIN'));
});
```

- [ ] **Step 2: 구현** — `ingress.ts` path 모드 `attachGateway(service)`: `albSg.addIngressRule(anyIpv4, tcp(8080))`; `loadBalancer.addListener('GatewayHttp', { port: 8080, protocol: HTTP, defaultAction: forward([new ApplicationTargetGroup('GatewayTg', { port: 3002, protocol: HTTP, targetType: IP, targets: [service], healthCheck: { path: '/health' } })]) })`. `service.ts`: http 모드에서도 gateway 생성(E의 skip 제거); gateway·web·controller env에 `GATEWAY_MODE: 'path'`, `GATEWAY_PUBLIC_ORIGIN: `http://${alb.loadBalancerDnsName}:8080``, `GATEWAY_BASE_DOMAIN` 없음. https 모드는 `GATEWAY_MODE: 'host'` 명시(기본과 동일; env 추가는 논리 ID 무영향).
- `dashboard-stack.ts`: gateway IAM/access entry 조건은 C에서 이미 `svc.gatewayRole` 존재 여부로 처리됨.

- [ ] **Step 3: 통과·커밋** — infra 테스트 전체.
```bash
git add dashboard/infra
git commit -m "feat(dashboard): HTTP mode exposes the session gateway on ALB :8080 in path mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: e2e·문서

**Files:**
- Create: `dashboard/web/e2e/path-gateway.spec.ts`(path 모드 배포에서만 실행; `requireCondition(process.env.DASHBOARD_GATEWAY_MODE === 'path')`) — Jupyter 세션 생성 → launch → `/s/<id>/lab` 200 + `__gateway` 없음, 터미널 세션 → 페이지에 `__gateway/assets` 상대 링크, 실시간 보기 iframe 로드.
- Modify: `dashboard/README.md`(HTTP 모드 절: 세션 :8080, DCV는 새 창만), `dashboard/web/src/server/gateway/README.md`(모드 설명, 쿠키·바인딩), `dashboard/docs/dashboard-features-and-aws-architecture.md` §9, §25.

- [ ] **Step 1~3**: 스펙 작성(`--list` 확인), 문서 갱신, 커밋:
```bash
git add dashboard/web/e2e/path-gateway.spec.ts dashboard/README.md dashboard/web/src/server/gateway/README.md dashboard/docs/dashboard-features-and-aws-architecture.md
git commit -m "docs(dashboard): path-mode session gateway; e2e for HTTP deployments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
DCV 임베드 실측 결과(동작/불가)는 README의 HTTP 모드 절에 한 줄로 기록한다.
