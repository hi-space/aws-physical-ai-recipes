# Session gateway

The parent dashboard authenticates the Cognito subject, authorizes the project and
target, persists the session, and calls `issueLaunchTicket(record, principal)`.
Only `principal.subject` is accepted as the owner identity. Public exports are in
`index.ts`; the standalone entry is `src/gateway.ts`.

## Modes

`GATEWAY_MODE` (`routing.ts:gatewayMode`) is `host` (default) or `path`.

- **`host`** — HTTPS deployments with a wildcard domain. Each session gets its own
  subdomain `https://<id>.apps.<GATEWAY_BASE_DOMAIN>/`; the ALB routes by Host header.
  Set `GATEWAY_BASE_DOMAIN` to a DNS suffix without a wildcard or scheme; its default is
  `apps.physical-ai.hi-yoo.com`.
- **`path`** — HTTP-ingress deployments (`-c ingress=http`) that have no wildcard cert/DNS.
  All sessions share one origin, `GATEWAY_PUBLIC_ORIGIN` (e.g. `http://<alb-dns>:8080`), and
  are distinguished by a `/s/<sessionId>` path prefix. `resolveRoute` (`routing.ts`) requires
  the request's Host to exactly match `GATEWAY_PUBLIC_ORIGIN`'s host and parses
  `/s/<id>(/rest)?`; anything without a matching prefix is rejected (401), except `GET/HEAD
  /health`. A bare `/s/<id>` (no trailing slash) gets a 308 redirect to `/s/<id>/` before
  authorization (`server.ts`).

  경로 모드는 모든 세션이 하나의 브라우저 origin(`GATEWAY_PUBLIC_ORIGIN`)을 공유합니다. 인증
  쿠키는 이름(`pai-session-<id>`)·`Path=/s/<id>/`·`routeBinding` 검사로 세션마다 계속 격리되지만,
  `localStorage`/`sessionStorage`/`IndexedDB`/`BroadcastChannel` 같은 클라이언트 저장소와
  서비스 워커 등록 스코프는 origin 단위로 동작하므로 이 모드에서는 세션 간에 공유됩니다. 이를
  악용해 한 세션의 앱이 다른 세션의 클라이언트 저장소를 읽거나, 서비스 워커를 `/` 스코프로
  등록해 응답을 가로챌 수 있으므로 게이트웨이는 응답의 `Service-Worker-Allowed` 헤더를 제거해
  세션 앱이 자신의 `/s/<id>/` 밖으로 서비스 워커를 등록하지 못하게 막습니다(`downstreamHeaders`,
  `headers.ts`). 그 외 저장소 공유 자체는 막지 않으며, 도메인·와일드카드 인증서가 없는 신뢰
  네트워크 배포를 위한 구조적 트레이드오프로 받아들입니다. 세션마다 별도 origin을 쓰는 호스트
  모드는 이 문제가 없습니다.

```ts
const launch = await issueLaunchTicket(record, principal);
// Return launch.url to the authenticated browser without logging it.
// host mode:  https://<id>.apps.physical-ai.hi-yoo.com/?ticket=...
// path mode:  http://<alb-dns>:8080/s/<id>/?ticket=...
```

The opaque launch ticket lives for at most 60 seconds. `Repo.kv.transaction`
atomically deletes its hashed record and inserts a hashed cookie grant. In host mode
the gateway sends `__Host-pai-session` with Secure, HttpOnly, Path=/, SameSite=Strict,
and no Domain. In path mode the cookie is named `pai-session-<sessionId>` (the `__Host-`
prefix forbids any `Path` other than `/`, and path mode needs `Path=/s/<id>/`) with
HttpOnly, SameSite=Strict, `Path=/s/<id>/`, and `Secure` only when `GATEWAY_PUBLIC_ORIGIN`
is https (`routing.ts:cookieName`/`cookieAttributes`). Either way the gateway redirects to
remove the ticket, rejects duplicate authentication cookies, ambiguous headers, and
noncanonical hosts.

Grant records (`GATEWAY#TICKET#…` / `GATEWAY#COOKIE#…`) persist the route binding under
`routeBinding` — a host string in host mode, `${origin}/s/<id>` in path mode
(`auth.ts:issueLaunchTicket`/`consumeTicket`/`authorizeCookie`). Host mode also mirrors
`routeBinding` into the legacy `host` field so old grants and rollback deploys keep
working. `binding` is unrelated: it is (and remains) the session-integrity digest
(`sessionBinding`) that invalidates a grant whenever the underlying session's owner,
target, or expiry changes — never a routing value.

Upstream request headers in path mode carry `Host`/`X-Forwarded-Host` set to the public
origin's host (with port), `X-Forwarded-Proto` the public scheme, and
`X-Forwarded-Prefix: /s/<id>` so the app can render links under its prefix (host mode omits
`X-Forwarded-Prefix` entirely). App `Set-Cookie` responses are re-scoped by
`headers.ts:isolatedCookies`: any `Domain` is stripped, `Path` becomes
`/s/<id><original path>`, a `__Host-`-prefixed name is renamed to `pai-app-<name>` (that
prefix bans a non-`/` Path), and `Secure` is added only when the public origin is https —
which means an app cookie that instead uses the `__Secure-` prefix (which *requires*
`Secure`, independent of Path) cannot round-trip over an http `GATEWAY_PUBLIC_ORIGIN`; this
is a browser limitation, not something the gateway can work around. `headers.ts:upstreamCookie`
reverses the `pai-app-` rename and strips only the gateway's own session cookie on the way
back upstream, never the app's other cookies. Same-origin app redirects get their `Location`
rewritten under the session prefix (`headers.ts:downstreamHeaders`); host mode instead pins
every redirect back onto the isolated session host.

`GatewaySession` is this module's strict view of the parent-owned session record.
`expiresAt` is an ISO timestamp; `ownerSubject` is required. Non-DCV targets need
the registered namespace/pod and port; terminals need the registered container.
DCV needs nodeName, ssmTarget, and dcvSessionId.

Every authorization reads the current session. Changes to owner, expiry, target,
project, workflow, or attempt invalidate old grants. A project-bound session also
requires the owner's current researcher/project-admin membership and matching
project namespace. Workflow-bound sessions reject terminal/cancelling workflows
and durable cancellation intents. Supply `taskName` with `attempt` and/or
`attemptEpoch` for direct verification against the task's current RUNNING attempt.
The parent must revoke sessions on retry, cancellation, logout, and access removal
as appropriate; deletion or `revokedAt` invalidates all grants.

Active HTTP streams, app WebSockets, and terminals revalidate at most every five
seconds. An exact expiry timer closes them at the original deadline. Authorization
reads that stall for five seconds also close the connection. Grants rely on live
expiry checks, not delayed DynamoDB TTL deletion.

## Upstreams

HTTP and WebSocket destinations come only from the registered session. The
Kubernetes transport uses the configured EKS cluster's private-enabled endpoint,
its CA, and `k8s/token.ts` AWS authentication. The existing `k8s/client.ts`
clusterInfo helper is private, so this module performs its own cached
DescribeCluster using the same configured cluster. It does not use local
kubeconfig or run kubectl. The gateway process must run in the EKS VPC, where that
endpoint resolves privately.

The transport uses existing `ws` with Kubernetes `v4.channel.k8s.io`: Exec streams
0/1/2/3/4 are stdin/stdout/stderr/status/resize; port-forward streams 0/1 carry
data/errors with initial little-endian port bytes. Protocol reference: official
`kubernetes-client/javascript` source files `exec.ts`, `portforward.ts`,
`web-socket-handler.ts`, and `terminal-size-queue.ts`. The server transport needs no additional dependency; the browser terminal
uses the xterm dependencies described below.

App paths, queries, bodies, WebSocket frames/subprotocols, and app cookies are
preserved. Dashboard/ALB credentials and identity headers are stripped. Set-Cookie
Domain is removed, Secure is enforced in host mode (path mode enforces it only when
`GATEWAY_PUBLIC_ORIGIN` is https — see Modes above), and applications cannot replace
the gateway cookie. In host mode redirects stay on the isolated session host;
applications should serve their root URL on that host. In path mode same-origin app
redirects are rewritten under `/s/<id>` instead. The old dashboard
`/api/sessions/.../proxy` path prefix is not added in either mode.

Unsafe HTTP and all WebSocket handshakes require Origin to exactly equal the route's
public origin (`route.publicOrigin`): `https://<session-host>` in host mode, or
`GATEWAY_PUBLIC_ORIGIN` in path mode. Any supplied Origin on a normal GET/HEAD must
also match. Only the initial GET ticket exchange additionally accepts `DASHBOARD_ORIGIN`
(default `https://physical-ai.hi-yoo.com`; an http value is accepted too, since HTTP-ingress
deployments have no https dashboard origin at all) or an absent Origin for top-level
navigation. Forwarded identity and host headers never authorize a request.

## Terminal protocol

Open `wss://<session-host>/__gateway/terminal` from the isolated session origin
(`ws://…/s/<id>/__gateway/terminal` in path mode over http). The bundled browser
client resolves this relative to `location.href` and picks `ws:`/`wss:` from
`location.protocol` (`browser/terminal-client.js`), so it needs no gateway-mode
awareness of its own. Browser messages:

```json
{"type":"input","data":"pwd\n"}
{"type":"resize","cols":120,"rows":40}
```

Gateway messages are `{type:"stdout"|"stderr",data:string}`,
`{type:"exit",code:number}`, or a generic `{type:"error",message:string}`.
Only the registered container's fixed `/bin/sh` is executed, with a TTY.
TTY mode may merge stderr into stdout. Unknown fields, commands, target
overrides, invalid resize values, and oversized messages are rejected.

The root page uses a locally bundled xterm terminal with ANSI rendering, cursor
movement, interactive stdin and FitAddon resizing. It never fetches a CDN asset.
The parent installs `@xterm/xterm` and `@xterm/addon-fit` (locally verified with
6.0.0 and 0.11.0) and bundles the browser entry:

```sh
npx esbuild src/server/gateway/browser/terminal-client.js --bundle --platform=browser --format=iife --outfile=dist/gateway-assets/terminal.js
cp node_modules/@xterm/xterm/css/xterm.css dist/gateway-assets/terminal.css
```

Copy both files into the gateway image and set `GATEWAY_ASSET_DIR` to that absolute
directory. The default is `dist/gateway-assets` relative to the process cwd.
`GET /__gateway/assets/terminal.js` and `terminal.css` require the same session
cookie as the terminal. Only these fixed asset names are served. Missing bundles
produce 503; the gateway does not silently fall back to a non-ANSI terminal.

## DCV integration

```ts
createGatewayServer({
  getDcvUpstream: async (session, { signal }) => {
    // Parent creates/acquires an actual allowlisted SSM tunnel for this session.
    return {
      url: new URL("https://127.0.0.1:12345"),
      ca: registeredCertificateAuthority,
      servername: registeredDcvCertificateName,
      close: releaseTunnelLease,
    };
  },
});
```

The hook is acquired per upstream connection and its close method releases that
connection's lease. It must honor AbortSignal and clean up failed acquisition.
Only HTTPS literal loopback URLs with a root path are accepted. Certificate
chain and hostname checks remain enabled. Without a hook, DCV returns 501.
The parent owns SSM creation, session/replica ownership, DCV authentication,
allowlisting, and reconnect/lifecycle management. The default entry has no hook.

## Run and verify

From `dashboard/web`:

```sh
npx vitest run src/server/gateway
npx tsc --noEmit --incremental false
npx esbuild src/gateway.ts --bundle --platform=node --target=node22 --format=cjs --outfile=/tmp/physical-ai-gateway.cjs
node /tmp/physical-ai-gateway.cjs
```

The entry listens on `0.0.0.0:3002`; `GET /health` is process liveness only.
SIGTERM/SIGINT close active connections. The parent owns service build scripts,
container entrypoints, ALB/TLS routing and Host preservation, restricted target
network access, and IAM/RBAC for table access plus EKS pods/portforward and
pods/exec. Gateway access logging must omit credentials and ticket query strings;
ALB/proxy access logs are part of the parent's configuration.

Tests use MemoryKV, actual local HTTP/WS servers, and temporary local TLS
certificates generated with OpenSSL. They do not contact AWS, create SSM tunnels,
or certify live EKS/DCV operation.
