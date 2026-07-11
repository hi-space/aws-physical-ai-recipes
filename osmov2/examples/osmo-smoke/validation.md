# OSMO Smoke Validation

This file records validation for [workflow.yaml](workflow.yaml).

## 2026-04-28 CPU Smoke After UI Extension

Status: Passed

Command:

```bash
scripts/smoke-test.sh
```

Observed result:

- Workflow: `aws-osmo-smoke-1`
- OSMO data access validation passed against the AWS S3-backed workflow storage.
- The backend operator executed the workflow in `osmo-workflows`.
- Workflow log included `hello from AWS OSMO smoke workflow`.
- Workflow completed successfully.

## 2026-04-29 KAI Scheduler Smoke

Status: Passed

Commands:

```bash
scripts/deploy-osmo.sh
scripts/deploy-kai.sh
scripts/validate-platform.sh
scripts/smoke-test.sh
scripts/validate-platform.sh
```

Observed result:

- Workflow: `aws-osmo-smoke-9`
- OSMO data access validation passed.
- Workflow log included `hello from AWS OSMO smoke workflow`.
- KAI scheduler log showed `There are <1> PodGroupInfos`.
- KAI created a bind request for the workflow task.
- The `osmo-workflows` namespace had no remaining pods or PodGroups after completion.

Notes:

- The 2026-04-29 run validates the same smoke workflow with KAI as the Kubernetes scheduler.

## 2026-07-11 OSMO 6.3.1 CPU Smoke

Status: Passed

Deployed OSMO 6.3.1 (chart 1.3.1) via the consolidated `service` chart
(API + router + UI in one release) + `backend-operator`, with the Envoy
gateway disabled (`gateway.envoy.enabled=false`, `gateway.oauth2Proxy.enabled=false`,
`gateway.tls.enabled=false`) so the services stay plain HTTP behind the nginx
internal router and `kubectl port-forward`.

Commands:

```bash
scripts/deploy-osmo.sh
scripts/smoke-test.sh
```

Observed result:

- Helm releases: `osmo-service` (service-1.3.1, 6.3.1) and `osmo-backend`
  (backend-operator-1.3.1, 6.3.1); all 13 pods Running.
- `/api/version` returned `{"major":"6","minor":"3","revision":"1"}`.
- Workflow: `aws-osmo-smoke-2`
- OSMO data access validation passed against the AWS S3-backed workflow storage.
- Workflow log included `hello from AWS OSMO smoke workflow`.
- Workflow completed successfully in 69 s.

Notes:

- 6.3 defaults `gateway.tls.enabled=true`, which makes each core service mint an
  in-process self-signed cert and serve HTTPS. The admin-token login over
  `http://osmo-service:80` fails in that mode, so this baseline sets
  `gateway.tls.enabled=false`.
