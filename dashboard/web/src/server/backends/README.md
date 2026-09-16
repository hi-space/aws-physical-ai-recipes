# Registered EKS backends (F13)

Additional targets are deployment-allowlisted, existing EKS/HyperPod pools in the home AWS account, **us-east-1**, and the same explicitly configured VPC. This code provisions no clusters, networking, IAM access entries, RBAC, queues or additional-backend FSx claims. Other accounts/regions/VPCs and unknown configuration are rejected.

## Deployment contract

Set the same `EKS_BACKENDS_JSON` and `BACKEND_HOME_VPC_ID` in the API, worker and gateway deployments. `EKS_BACKENDS_JSON` defaults to `[]`; the current default EKS path works without new environment variables. The new profile schema is exported as `BackendProfile` from `registry.ts`.

Each entry contains:

- `id`, positive `configVersion`, `accountId`, `region`, `vpcId`.
- `eks`: existing EKS cluster name, HyperPod cluster name, data bucket, FSx filesystem ID/DNS/mount name, log group prefix; optional dedicated AMP workspace.
- Explicit preprovisioned `namespaces`, with `${namespace}-localqueue`, `pai-workload` service account and bound `fsx-pvc`.
- `evidence`: records keyed by every `backendCapabilities` value. Each record needs `status:"verified"`, `checkedAt`, `expiresAt` and a deployment validation `reference`. Evidence is valid for at most seven days. Missing, unknown or expired evidence remains UNREADY.

Capability evidence must come from actual deployment validation, separately for the API, worker and gateway IAM principals/network paths. In particular, the API process cannot prove worker/gateway reachability or a Pod's route to the home runtime broker. Do not manufacture these records from resource names or account metadata.

The prerequisites cover all three EKS access identities; worker/gateway to private EKS API; Pods to home runtime/tracking broker; FSx mounting and DRA export to the profile's data bucket; home archive and backend bucket access; and workload credential/metadata isolation. IAM, EKS access entries/RBAC and VPC/security-group routing are integration-owner changes, not part of this patch. No role assumption or cross-account credentials are accepted in the profile.

## Registry and project API

Platform admin browser sessions only:

| Endpoint | Contract |
| --- | --- |
| `GET /api/backends` | Existing default metadata plus each allowlisted registration/status/findings |
| `POST /api/backends` | `{id, expectedVersion, enabled}`; compare-and-swap new immutable revision |
| `GET /api/backends/:id` | Current registration and immutable revision history |
| `POST /api/backends/:id/check` | `{version}`; inspect the current registered configuration without provisioning |

Registry values reside in the **home DDB table**, under `BACKEND#id`: `META`, `REV#0000000001`, `CHECK#version`. Config values come from deployment allowlist only; HTTP bodies cannot set endpoints, roles, CA, filesystem IDs or bucket names.

The explicit probe checks the discovered EKS ARN/account/region, ACTIVE cluster, private endpoint/shared VPC, Kubernetes version and JobSet API, each governed namespace/local queue, bound FSx PVC/PV identity and mount fields, workload service account, and required SelfSubjectAccessReview permissions. Only the current process principal is dynamically probed. Readiness additionally requires the distinct deployment evidence described above. A failed probe remains visible as UNREADY; registration alone never means ready.

Probe receipts expire after 15 minutes. The worker refreshes existing enabled registrations every five minutes; it never registers or enables a target. No automatic retry can fabricate evidence for unknown prerequisite paths.

`POST /api/projects` accepts optional `backendId` (default `"default"`). It resolves the ready allowlisted profile, checks the actual local queue on that cluster, and saves immutable `backendId` + `backendConfigHash`. Membership PATCH is strict and cannot change either binding. Namespace ownership keys include backend ID; default also reserves the historical namespace key to avoid migration races.

`Workflow.backendId` and `backendConfigHash` are server-resolved from the project, included in submission identity and retained by retry. A changed routing/storage allowlist hash never silently retargets an old project or run. Register a new ID/project for a different target; all processes must receive consistent allowlist configuration.

## Execution isolation

`config()` remains the home environment. `backendConfig()` is a separate EKS-only view backed by per-operation AsyncLocalStorage; no process environment mutation occurs. Home DDB, Cognito/SSM, SFN/SQS, archive bucket and native SageMaker pipeline/MLflow configuration remain home.

- Generic K8s/queue/FSx/metrics routes select the authorized project backend. Admins without a selected project may explicitly query `backendId`; a researcher cannot override the project binding.
- Workflow and session routes select the persisted resource backend even if the browser currently selected another project. Generic namespace authorization checks backend + namespace.
- Worker reconcile, Job/JobSet launch/delete, artifact collectors and FSx export execute in the persisted run context. Disabled/unready registrations reject launches, but known unchanged targets remain available for observation/cancellation/cleanup.
- Session create/refresh/cleanup and gateway WebSocket exec/port forwarding use persisted session binding. TLS endpoint/CA cache keys include account/region/cluster/configuration hash and expire after five minutes. The existing EKS token cache already keys by region/cluster; tests prove separate signed cluster headers and bearers.
- Runtime capabilities include backend ID (old missing claim means default only). New explicit bindings also emit `PAI_RUNTIME_BACKEND_ID`. Gateway grant digests include backend ID/hash; changing either invalidates grants. Default legacy bindings remain compatible.

Additional-backend FSx claims are verified, never created automatically. Default legacy namespace/PV behavior is preserved.

## Dataset and artifact boundary

Backend-local FSx is not shared implicitly. Additional-backend inputs require an immutable S3 manifest hash and the isolated `/fsx/datasets/projects/<project>/...` destination. Numeric dataset version and S3 object VersionId/checksums are preserved; the existing trusted runtime input hydrator materializes them on the selected backend. Unpinned or FSx-only additional-backend inputs are rejected.

Project authorization still applies: using another backend does not grant cross-project dataset access. Authorized imports finalize a new project version in the home archive. Dataset request and finalization worker S3 allowlists use that dataset's project binding. Output collection uses the source backend FSx/DRA/data bucket; verified snapshots and lineage remain in the home archive/DDB. Pending collection is never reported as a READY artifact.

## Validation

`registry.test.ts`, `routing.test.ts`, `token-routing.test.ts` cover real application boundaries with fake transport, home MemoryKV and fake object storage: two clusters, same namespace, API submit, worker Job/JobSet, cancellation after disable, FSx collectors, session/gateway, immutable S3 hydration, signed runtime identity, namespace denial, capability expiry/refresh and default/native SageMaker preservation. No live AWS/Kubernetes requests are made by these tests.

This is source implementation and local verification, not evidence that any additional live backend is deployed or reachable.
