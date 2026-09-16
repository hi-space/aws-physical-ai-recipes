# Session gateway

The parent dashboard authenticates the Cognito subject, authorizes the project and
target, persists the session, and calls `issueLaunchTicket(record, principal)`.
Only `principal.subject` is accepted as the owner identity. Public exports are in
`index.ts`; the standalone entry is `src/gateway.ts`.

```ts
const launch = await issueLaunchTicket(record, principal);
// Return launch.url to the authenticated browser without logging it.
// Browser navigates to https://<id>.apps.physical-ai.hi-yoo.com/?ticket=...
```

The opaque launch ticket lives for at most 60 seconds. `Repo.kv.transaction`
atomically deletes its hashed record and inserts a hashed cookie grant. The
gateway sends `__Host-pai-session` with Secure, HttpOnly, Path=/, SameSite=Strict,
and no Domain, then redirects to remove the ticket. It rejects duplicate
authentication cookies, ambiguous headers, and noncanonical hosts. Set
`GATEWAY_BASE_DOMAIN` to a DNS suffix without a wildcard or scheme; its default is
`apps.physical-ai.hi-yoo.com`.

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
Domain is removed, Secure is enforced, and applications cannot replace the
gateway cookie. Redirects stay on the isolated session host. Applications should
serve their root URL on this host; the old dashboard `/api/sessions/.../proxy`
path prefix is not added.

Unsafe HTTP and all WebSocket handshakes require Origin to exactly equal
`https://<session-host>`. Any supplied Origin on a normal GET/HEAD must also match.
Only the initial GET ticket exchange accepts `DASHBOARD_ORIGIN` (default
`https://physical-ai.hi-yoo.com`) or an absent Origin for top-level navigation.
Forwarded identity and host headers never authorize a request.

## Terminal protocol

Open `wss://<session-host>/__gateway/terminal` from the isolated session origin.
Browser messages:

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
