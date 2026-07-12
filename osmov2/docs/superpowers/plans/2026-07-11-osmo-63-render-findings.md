# OSMO 6.3 Render Findings: Gateway-Disabled Architecture

**Date:** 2026-07-11  
**Chart:** `osmo/service` version `1.3.1` (appVersion `6.3.1`)  
**Command:** `helm template svc osmo/service --version 1.3.1` with `gateway.envoy.enabled=false` + `gateway.oauth2Proxy.enabled=false`

---

## Q1: Does `service` chart 1.3.1 render with gateway disabled?

**Answer:** YES

**Evidence:**
- `helm template` completed without error
- Output: 1677 lines of valid YAML
- Error stream: empty (`/tmp/osmo-63-nogw.err`)
- Rendered resources: ServiceAccount, 8 Services, 8 Deployments, ConfigMaps, Secrets

**Decision:** Gateway-disabled rendering is supported. Tasks A3/A4 may proceed.

---

## Q2: With gateway OFF, are API/UI reachable via ClusterIP for port-forward?

**Answer:** YES, but on SEPARATE Services (not unified)

**Evidence:**

Rendered ClusterIP Services (no Ingress):
- `osmo-service` (ClusterIP, port 80→8000): API server
- `osmo-ui` (ClusterIP, port 80→8000): Web UI  
- `osmo-logger` (ClusterIP, port 80→8000): Workflow logger websocket
- `osmo-router` (ClusterIP, port 80→8000): Session router
- `osmo-agent` (ClusterIP, port 80→8000): Agent controller

**Port-forward path without gateway:**
```bash
# API (osmo-service):
kubectl port-forward svc/osmo-service 8080:80 -n osmo

# Logger (osmo-logger):
kubectl port-forward svc/osmo-logger 8081:80 -n osmo

# UI (osmo-ui):
kubectl port-forward svc/osmo-ui 8082:80 -n osmo
```

**Critical observation:** The UI is still configured to reach the API via `NEXT_PUBLIC_OSMO_API_HOSTNAME=osmo-gateway:80` in the rendered Deployment, even though the gateway is disabled. This env var is NOT automatically updated when gateway is off, so the deployed UI will fail to reach the API without additional configuration override.

**Decision:** API and UI are reachable for development testing via separate port-forwards, but require manual env override in the UI Deployment to work together in a gateway-off cluster.

**Recommendation for Task A3 (Gateway-Off Mode):**

When deploying with gateway disabled, Task A3 MUST override the UI's API hostname to point at the internal nginx router instead of the missing gateway. 

- **Helm Value:** `services.ui.apiHostname`
- **Rendered Environment Variable:** `NEXT_PUBLIC_OSMO_API_HOSTNAME` (in `osmo-ui` Deployment)
- **Current Value (gateway enabled):** `osmo-gateway:80`
- **Required Value (gateway disabled):** `osmo-internal-router:80` (or `osmo-internal-router.<namespace>.svc.cluster.local` for explicit FQDN)

Set via Helm: `--set services.ui.apiHostname=osmo-internal-router:80`

This aligns with the "Chosen router mode: KEEP" decision — the nginx internal router continues to serve as the single entry point for both API (`/`) and logger (`/api/logger/`) paths.

---

## Q3: Does OSMO 6.3's built-in `router` expose both `/` and `/api/logger/` on one Service?

**Answer:** NO

**Evidence:**

The OSMO 6.3 `router` is a **session router**, not an HTTP path router.

From `osmo/service` chart values (line 1297–1303):
```yaml
## External hostname on which the router is served (e.g. staging.osmo.nvidia.com).
## Used by the router to extract a session key from the `Host` / `X-Forwarded-Host`
## header — requests to `<key>.<hostname>` resolve to session `<key>`. Required for
## subdomain-based session routing (webserver port-forwarding); otherwise the binary
## falls back to its default of "localhost", which only matches `*.localhost`.
```

Rendered behavior:
- Router listens on port 8000 (same as all services)
- Router command: `router` with postgres/mek args (session state management)
- Router Service: `osmo-router` ClusterIP on port 80
- Health check: `GET /api/router/version` (no evidence of path-routing or logger proxying)

Comparison to current nginx router:
- Current osmov2 nginx routes:
  - `location /api/logger/` → proxy to `osmo-logger`
  - `location /` → proxy to `osmo-service`
- OSMO 6.3 router routes:
  - `subdomain-key.<hostname>` → session `key` (not HTTP path based)

**Evidence: No `/api/logger/` path routing in rendered resources**
```bash
grep -iE 'logger|location|/api/logger/' /tmp/osmo-63-nogw.yaml
# Returns only service names and health checks, not path routing
```

**Decision:** The nginx internal router (path-based routing) is still necessary because OSMO 6.3's built-in router is a session router (subdomain-based), not a replacement for path-based HTTP routing. The two routers solve different problems.

---

## Router Mode Decision

**Chosen router mode: KEEP**

**Reasoning:**
1. OSMO 6.3 provides a session router, not a path router
2. osmov2's nginx router serves HTTP paths (`/api/logger/` → logger, `/` → api) that the OSMO router cannot replace
3. In gateway-off deployment mode, an external path router is REQUIRED to reach both API and logger endpoints on a single ingress point
4. Removing the nginx router would break logger websocket connectivity (workflow callbacks)

**Implications for A3/A4:**
- Keep the osmov2 `osmo-internal-router` deployment in the deploy script
- When upgrading to OSMO 6.3, use the nginx router's output Service (e.g., `osmo-internal-router`) as the single entry point for `OSMO_WORKFLOW_CALLBACK_URL` and external ingress
- If a later phase adds public ingress (ALB/NLB), route external traffic to the nginx router, which then routes:
  - `/api/logger/*` → `osmo-logger:80`
  - `/*` → `osmo-service:80` (or `osmo-router:80` for session persistence if needed)

---

## Raw Render Artifacts

- Render output: `/tmp/osmo-63-nogw.yaml` (1677 lines)
- Values reference: `/tmp/osmo-service-1.3.1-values.txt` (61 KB)
- Chart metadata: `/tmp/osmo-service-1.3.1-chart.txt`

Resource summary from rendered manifest:
```
Services:
  osmo-agent (ClusterIP, 80/8000)
  osmo-service (ClusterIP, 80/8000)
  osmo-gateway-authz (ClusterIP, 50052/grpc)
  osmo-logger (ClusterIP, 80/8000)
  osmo-logger-headless (headless, 80/8000)
  osmo-router (ClusterIP, 80/8000)
  osmo-router-headless (headless, 80/8000)
  osmo-ui (ClusterIP, 80/8000)

Deployments (8 total):
  osmo-agent (1 replica)
  osmo-delayed-job-monitor (1 replica)
  osmo-gateway-authz (1 replica)
  osmo-logger (3 replicas)
  osmo-router (3 replicas with HPA scale 3-5)
  osmo-service (3 replicas with topology spread)
  osmo-ui (1 replica)
  osmo-worker (2 replicas)

Ingress: NONE (expected with gateway disabled)
```
