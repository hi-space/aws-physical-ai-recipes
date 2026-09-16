# Project devices, pinned deployments, benchmarks and HIL

This implements dashboard F36/F37 without changing model/store/engine/infra code. It does **not** provision IoT devices, send motion/control messages, or certify physical hardware. Development validation uses fake AWS clients, MemoryKV, temporary files and isolated local containers.

## Registration and authorization

- Every service operation rechecks project access through the existing project authorization helpers.
- Project administrators register named IoT Things, Greengrass Cores, groups, or local virtual devices. The server resolves AWS ARNs within the configured account/region; the browser never chooses an arbitrary ARN.
- A canonical target ownership record prevents registering the same Thing/Core under another project or alias.
- Core architecture is checked against AWS metadata. ARM64 maps to the Greengrass `aarch64` recipe platform; AMD64 also accepts reported `x86_64`.
- Physical registration requires an explicit acknowledgement. `hardwareValidation` remains `not_tested`, even if Greengrass reports `HEALTHY`.
- Local virtual devices have no cloud deployment profiles. The communication component is rejected for physical targets.
- Groups contain 1–8 individually registered, compatible project cores. Registration captures the member IDs. Normal deployment preparation/submission rejects membership drift; administrators can explicitly refresh the registered member snapshot after registering new members.
- Group deployment expands to **individual core deployments**. It never creates a continuous ThingGroup deployment that might automatically reach devices added later.
- Administrators can register new component versions, preserve older versions for rollback, and confirm that an existing Thing registration has since become a Greengrass Core. Targets/ARNs cannot be changed through this update.

## HTTP API

All endpoints use `route()`, the existing Origin/identity checks, and `requestProject`. Services also authorize direct calls.

| Endpoint | Behavior |
|---|---|
| `GET /api/edge` | Registered project devices, public lease metadata, operations, accessible model choices and active workflow choices. No global core-device enumeration. |
| `POST /api/edge/devices` | Project-admin registration: `label`, `kind`, `targetName`, `architecture`, `physical`, `acknowledgePhysicalRegistration`, and `profiles: [{name, version}]`. |
| `GET /api/edge/devices/:id` | Registration, current core status/error, lease and benchmark history. |
| `PATCH /api/edge/devices/:id` | Project-admin `label`/`profiles` changes, `refreshMembers`, or `promoteToCore`. It cannot change the target ARN. Active leases/operations prevent changes. |
| `POST /api/edge/deployments` | Prepare `{deviceId, profileId, modelId?, name, allowUnapprovedBenchmark?, iterations?, warmup?}`. Writes a reviewable plan; sends no AWS deployment. |
| `GET /api/edge/operations/:id?refresh=1` | Read actual AWS execution/installed component state and versioned runtime readiness evidence; persist observations. |
| `POST /api/edge/operations/:id/submit` | Explicit submit with an empty JSON body. Uses only the stored plan, registered targets, exact versions and stable client tokens. |
| `POST /api/edge/operations/:id/rollback` | Prepare a rollback to the prior owned desired configuration. Optional `allowUnapprovedBenchmark` applies only to restored benchmark workloads. Submission remains a separate explicit action. |
| `POST /api/edge/devices/:id/lease` | Claim `{runId, ttlSeconds}` for an accessible active run; return owner, run, epoch, expiry and a secret token. |
| `POST /api/edge/devices/:id/lease/{validate,renew,release}` | Require matching owner session, run, epoch and token. Renewal optionally takes `ttlSeconds`. |
| `POST /api/edge/devices/:id/benchmarks` | Either an explicit imported payload or a server-selected operation artifact; see below. |

Edge model query parameters are `model_id` or `modelId`, containing an actual registered `mdl-<24 hex>` ID. The page retrieves that project-scoped model. Legacy `modelPath` is displayed as unsupported and never authorizes deployment.

## Deployment contract and state

Inference requires the selected registered model's explicit application quality approval, rechecked using its verified evaluation and the existing `evaluatePromotion` policy. SageMaker smoke approval does not substitute for this. An unapproved model may be benchmarked only with `allowUnapprovedBenchmark: true`.

The plan contains the model's exact object key, VersionId, full SHA-256/checksum, matched VecNormalize object where applicable, immutable component version/recipe hash, architecture, runtime image digest, targets and prior configuration. Before submit, the service checks the current model, source object metadata, component recipe, device registration, target set, existing desired deployment and lease state again.

A single managed model workload runs on each core. Switching between managed inference and benchmark components removes the prior managed model component in the visible before/after plan. Unrelated components are retained. No fixed Nucleus/CLI/component version is injected.

States are:

```text
PREPARED -> SUBMITTING -> SUBMITTED / SUBMISSION_UNKNOWN
          -> RUNNING -> SUCCEEDED / FAILED
```

An AWS deployment ID means **submitted**, not successful. Completion requires:

1. The actual per-core execution reports completion/success.
2. Desired component versions are installed in `RUNNING`/`FINISHED` state and the core reports healthy.
3. Removed managed components are no longer running.
4. Every retained/new managed execution has a versioned, checksum-verified runtime `readiness.json` matching device, operation, component version/recipe hash, architecture and model/normalization digest.

For inference, the receipt is written only after the model loads and its software inference endpoint becomes available. For benchmarks, report publication precedes the readiness receipt. A later component failure appears in current device observations; a previously confirmed deployment remains historical evidence, not a continuing hardware-health guarantee.

Submission intent and device locks are committed before AWS calls. Each core uses a stable client token derived from operation ID and device ID. Ambiguous replies retain locks and can be reconciled from the AWS deployment's operation/device tags. Retries are bounded to seven hours; the SDK documents successful CreateDeployment idempotency caching for up to eight hours. Unknown outcomes are never silently unlocked or retried with a fresh token.

Rollback uses prior **desired configuration**, not an invented snapshot of arbitrary device runtime state. An existing unmanaged configuration for the selected component blocks preparation because its full rollback state is not known. Owned model/runtime configuration is restored with a new operation ID and report destination. A newer external deployment blocks rollback. Rollback targets are the original registered cores, even if their group membership has since changed.

## Component scripts and provisioning prerequisites

The original workshop recipes take mutable `modelPath` values and do not implement this contract. They are intentionally not deployed by the new service.

- `build_bundle.py` vendors the pinned boto3 dependency and creates a content-addressed ZIP.
- `build_recipe.py` renders a concrete recipe using an explicit component name/version, architecture, bundle URI and runtime image digest. It does not upload, publish or deploy.
- `edge_agent.py` downloads exact S3 object versions, verifies their full SHA-256/byte count, stages them in a private temporary directory, and runs only a newly created container. Cleanup is restricted to its own Docker `--cidfile`; it never stops a pre-existing named workshop container.
- `runtime.py` implements real SB3 PPO prediction/performance probes and calls the official GR00T PyTorch policy/server entry points. It verifies checkpoint and normalization bytes, rejects unsafe archive members, and writes durable JSON evidence. No actuator SDK or robot motion endpoint is included.
- `virtual_device.py` performs an actual loopback TCP echo test with lease epoch/token/expiry checks and rejects all motion/control/unknown operations.

Runtime prerequisites remain external:

- A provisioned Core, token-exchange role, Python, Docker access and an ECR credential helper.
- Published component ZIP/recipe versions. The runtime image must already exist and be pinned by digest.
- Registered model objects with full-file SHA-256. Composite-only checksums and unverified directory digests remain gated; no equality between a directory digest and an archive/file digest is assumed.
- GR00T archives must be self-contained directories with required model/processor files at archive root. GPU/Jetson GR00T execution has **not** been validated in this development run.
- TRT performance logs can be imported, including real failed/skipped modes. No unverified TensorRT deployment adapter or acceleration result is invented.

Recipe rendering commands are in [recipes/README.md](recipes/README.md).

## Benchmarks

The parser uses the existing workshop schema:

```json
{"mode":"pytorch","avg_ms":20,"p50_ms":18,"p95_ms":30,"p99_ms":40,"std_ms":3,"hz":50,"iterations":50}
```

The numbers above illustrate the schema, not measured product results. Finite values, quantile order, positive iterations/frequency, and rounded reciprocal consistency are checked. Failed/skipped modes retain their status and reason with no invented latency values.

- `source: "imported"` accepts a workshop result array or final JSON embedded in a log, plus declared engine/platform and optional model ID. The result is always labeled **Imported** with `identityVerified: false`.
- `source: "operation-artifact"` accepts only `operationId`. The server selects `projects/<project>/edge/<device>/operations/<operation>/benchmark.json`, pins VersionId/checksum, and verifies operation/device/model digest, engine/runtime image, architecture/system and measured mode/iteration count.
- Verified records retain the source object pin and model/engine/platform identity. These are performance/communication records, never model quality approvals.
- Synthetic observation inputs are explicitly identified as performance probes, following the workshop pattern. They do not measure robot task success.

Source workshop:
`e2e-workshop/edge/workshop-components/N1.6/com.workshop.benchmark/recipe.yaml`.

## HIL exclusivity

Claims bind a registered individual device to `ownerSubject`, an accessible active workflow `runId`, a TTL of 30–3600 seconds, a monotonically increasing epoch and a random secret token. Only the hash is stored; list/detail responses omit the token/hash. The owner token is returned on claim and kept in the browser tab's session storage for renew/release/copy.

The lease ledger is not deleted by DynamoDB TTL: expiration is checked against the server clock and epoch history survives. Conditional transactions fence concurrent claims, deployments, renewals and releases. Groups lock every selected core; an individual core's lease blocks any overlapping group deployment. A stale proof cannot release a newer lease.

A lease is scheduling authorization, **not** robot motion authorization. A physical receiver must enforce the current epoch and validate current lease state through the owner-authenticated API or a parent-owned broker. No physical receiver/control integration is claimed here.

## Existing DynamoDB and IAM integration

Records use the existing main `Repo.kv` table and index:

- Device: `DEVICE#<project>#<id> / META`, project device GSI; a global `DEVICE_TARGET#<hash> / OWNER` prevents duplicate target ownership.
- Operation: `EDGE_OP#<project>#<id> / META`, project operation GSI.
- Lease: device partition `/ LEASE`, with permanent epoch history.
- Benchmark: device partition `BENCHMARK#<createdAt>#<id>` plus a deterministic ID record for idempotent artifact ingestion.

Parent-owned runtime IAM:

- `iot:DescribeThing`, `iot:DescribeThingGroup`, `iot:ListThingsInThingGroup`.
- Greengrass `GetCoreDevice`, `GetComponent`, `ListDeployments`, `GetDeployment`, `ListEffectiveDeployments`, `ListInstalledComponents`; `CreateDeployment` only for explicit submits to registered core targets.
- Existing DynamoDB Get/Put/Query/TransactWrite.
- Backend and token-exchange role versioned model/report reads: `s3:GetObjectVersion`/`s3:GetObject` and applicable KMS access.
- Device `s3:PutObject` limited to its project edge operation report prefix; bucket versioning enabled.
- Docker/ECR credential helper's necessary ECR read permissions.

No IoT Publish, SSM RunCommand, device provisioning, robot-command or motion-control permissions are required.

## Validation

From repository root:

```bash
npm --prefix dashboard/web test -- src/app/api/edge
cd dashboard/web && npx tsc --noEmit --incremental false
```

From repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s dashboard/edge/tests -p 'test_*.py'
docker build -f dashboard/edge/Dockerfile -t physical-ai-edge-virtual:test .
docker run --rm --network none physical-ai-edge-virtual:test \
  python /opt/edge/virtual_device.py --self-test
node dashboard/edge/tests/check_virtual_lease.cjs
```

For a short communication-only check using a trusted current API lease proof copied to a private file:

```bash
docker run --rm --network none \
  -v /absolute/private/lease.json:/lease.json:ro \
  physical-ai-edge-virtual:test \
  python /opt/edge/virtual_device.py --self-test --lease-file /lease.json
```

The integration command uses the real backend lease implementation with MemoryKV/fake AWS, passes its current proof to the isolated receiver, exchanges ten packets, releases the lease and checks that the old proof is rejected. It uses the existing web esbuild dependency and creates no AWS resources.

This remains a local communication test, not cloud networking or physical actuation validation. To validate Greengrass later, the parent must use a **NEW owned test Thing/Core**, explicitly register it as nonphysical, and publish the communication recipe. No development command here deploys to an existing or physical device.

The tests use fake AWS clients, MemoryKV and temporary files. They cover project/Origin boundaries, named target ownership, version/architecture checks, inference quality gating, explicit unapproved benchmarks, readiness evidence, ambiguous submission adoption, prior-config rollback, group member drift/fanout, lease fencing, artifact corruption, imported metrics and UI truthfulness.

A local browser harness exercises registration → lease-blocked submit → release → confirmed rollout → reviewed rollback and Imported benchmark labels with fake AWS only. Separate local container checks produce real communication timings and real SB3 policy-inference timings; neither is a cloud or physical-hardware validation.

Handoff: `/tmp/physical-ai-edge-interfaces.md`.
