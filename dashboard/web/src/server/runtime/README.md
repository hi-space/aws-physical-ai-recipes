# Runtime broker

The parent worker imports `runtimeEnvironment`, `groupRuntime`, and `handleRuntimeRequest` from `./index`. The tracking proxy imports `mintMetricsCapability` and `validateMetricsCapability` from the same module. The HTTP handler returns false for paths outside `/runtime/*`. It is designed for the private worker HTTP server; no routes or worker bootstrap are changed here.

Configuration:

- `RUNTIME_SIGNING_KEY`: shared web/controller secret, at least 32 bytes. Only the broker/controller receives it.
- `RUNTIME_API_URL`: private HTTP(S) origin, including port when needed; no path prefix/query/userinfo.
- `DASHBOARD_ARTIFACT_BUCKET`: versioned durable bucket used for checkpoints and input manifests.
- Existing main DynamoDB configuration via `getRepo()`.

`runtimeEnvironment(workflow, task, epoch, attempt)` returns `PAI_RUNTIME_ENDPOINT` and a scoped `PAI_RUNTIME_TOKEN`. HMAC-SHA256 capabilities bind workflow/task/group/project/namespace/attempt/epoch and expiration. Lifetime covers configured queue/start/exec time plus an hour, capped at eight days. The token is not an AWS credential. Runtime-control tokens have audience `pai-runtime`; metrics tokens have audience `pai-mlflow`. Metrics minting returns a string, and validation returns the same `AuthContext` used for current workflow/task/epoch checks. The two audiences are rejected by each other’s validators, and every `/runtime/*` route requires `pai-runtime`. Parent code owns MLflow opt-in and proxy policy. `runtimeEnvironment` still returns only the runtime endpoint/control token. Each broker request verifies the signature, expiration, current workflow/task state, cancellation intent and epoch fence. The runtime must remove the token from the workload child environment and avoid logging it.

Participant writes live under `WF#<id>`, using `RUNTIME#<epoch>#MEMBER#<task>#<replica>`. The barrier's revision/counts live at `RUNTIME#<epoch>#META`. Conditional DynamoDB transactions check current workflow/task identity, the member/meta revisions and absent `FENCE#<epoch>` / `CANCEL` rows. Duplicate readiness cannot inflate participant count; stale initialization cannot overwrite a terminal outcome. A successful terminal report requires a prior RUNNING state and zero raw exit code. Replica indices are constrained by the authoritative task spec.

The capability is task-scoped, as required by the shared pod-template protocol. Replica numbers are validated and deduplicated; this is not independent per-Pod identity attestation. A stronger per-Pod claim would need a Pod UID/attestation exchange in the runtime protocol.

`groupRuntime.observe` reads current ledger/epoch state and aggregates all replicas. It applies exit-code policy only after enough replica evidence exists, retaining raw outcomes in participant rows. A blocking replica failure is never hidden by another replica's COMPLETE policy. A `runtime-error:` report remains a group failure even under ignoreNonleadStatus or a COMPLETE exit policy. `barrierReleased` reflects the configured barrier: all members for a synchronized group; individual preparation for barrier-disabled groups. A missing record remains INITIALIZING rather than fabricating progress. Leader completion and policy-relevant failures stop nonleaders. A `group-stopped:` report is recognized only after a recorded leader-completion decision; it preserves raw exit evidence while avoiding a false peer failure during coordinated shutdown. Engine-owned deletion/retry fencing remains authoritative.

`groupRuntime.fence` durably writes the exact epoch fence. It never invalidates a newer epoch. Session/data adapters can call `validateRuntimeCapability` and include `runtimeGuardChecks(context)` in their own transactions. Checking only a capability signature is insufficient for revocation.

HTTP protocol:

| Endpoint | Request | Success |
| --- | --- | --- |
| POST `/runtime/state` | phase, ready, replica, optional exitCode/message | 204 |
| GET `/runtime/barrier?replica=N` | task capability | `{ released, stopped }` |
| POST `/runtime/heartbeat` | empty JSON object | 204 |
| POST `/runtime/uploads` | purpose=checkpoint, destination, files; optional protocolVersion:2 + snapshotId | legacy: exact `{ uploads: [{ path, url, headers }] }`; v2: `{publicationId,state,uploads:[]}` |
| POST `/runtime/uploads/file` | v2 publicationId, path | bounded SINGLE or MULTIPART descriptor |
| POST `/runtime/uploads/part` | publicationId, path, number, checksumSHA256 | checksum-bound URL or verified UPLOADED part |
| POST `/runtime/uploads/file/complete` | publicationId, path | independently verified COMPLETE file |
| POST `/runtime/uploads/abort` | publicationId | reconciled scoped uncommitted cleanup; READY preserved |
| POST `/runtime/uploads/complete` | same canonical file manifest | verified immutable READY receipt |
| GET `/runtime/inputs` | task capability; optional pageSize=64 and cursor | pinned dataset input manifests, checksums and version-specific download URLs |
| GET `/runtime/checkpoints?replica=N` | current task capability; optional pageSize=64 and cursor | committed prior-attempt checkpoint descriptors and fresh version-pinned GET URLs |

Second-release F09 accepts `checkpoint.url: auto`, resolved by trusted server
context to the artifact bucket's project/run/task/checkpoint-index prefix.
READY publication and its per-epoch/task/checkpoint lookup index commit together.
Restore follows only server-recorded previous attempts or same-project manual
`retryOf` lineage. It reads the exact committed manifest VersionId, verifies its
digest and every pinned object's size/full SHA256, and issues fresh URLs under
the current capability. Source capabilities are never reused. A corrupt
committed checkpoint fails; missing committed history is an explicit cold start.
The full wire/runtime/model contract is in `dashboard/runtime/RESTORE.md`.

Invalid signatures return 401. Expired/cancelled/fenced/superseded capabilities return 410. Invalid input, scope violations and state conflicts return 400/403/409. Dependency failures return 503 without exposing raw SDK errors. JSON requests/responses are capped at 2 MiB. No request headers, tokens, signed URLs or raw bodies are logged.

Checkpoint destinations must exactly match a declared task checkpoint URL, use the configured artifact bucket, and be under `projects/<project>/`. The destination is a logical selector; actual writes always go under `projects/<project>/runs/<run>/attempts/<attempt>/checkpoints/<task>/<publicationHash>/objects/`. Publication identity includes epoch and a canonical sorted file manifest. No caller-specified arbitrary object key is accepted. Paths, duplicate files, checksums and sizes are validated before signing. V2 supports 1024 files, 1 TiB per file, and 300,000 bytes of durable registration metadata. Legacy clients retain single PUTs through 5 GiB and their exact response shape. See `dashboard/runtime/MULTIPART.md` for the complete protocol, limits and parent wiring.

Multipart SHA256 returned by S3 is COMPOSITE. Before committing READY, the broker
independently streams the pinned object version through native SHA256 and
records the full digest separately from its S3 transport checksum. It never
buffers a full file. V2 file/publication completion sends periodic JSON
whitespace, then terminal COMPLETE/READY JSON or `{state:"ERROR",status,error}`.
Initial HTTP 200 is not success. Contexts, durable leases, and epoch checks bound
verification; an interrupted hash restarts without reuploading completed parts.
Paged input/restore plans cap a negotiated aggregate at 1024 files and bind
cursors to the complete immutable plan. Unpaged legacy responses are preserved.

Abort is the sole authorization exception: a valid signed runtime capability
may clean its own uncommitted publication after fencing, but expired tokens
still fail and READY data cannot be deleted. `upload-cleanup.ts` exports
`cleanupCheckpointUploads(deps,workflow,{signal,taskNames?,attempt?})` for parent
controller cleanup before an attempt epoch is replaced. A bounded active
registry supports crash recovery; part/session rows have a nine-day TTL.
Repeated reconciliation handles late visible staging writes. Parent must retain
incomplete-multipart lifecycle cleanup and the scoped S3 permissions documented
in `MULTIPART.md`. No IAM, controller wiring or deployment is changed here.

PUT URLs expire after five minutes and sign exact checksums/lengths. Completion checks every immutable object VersionId, size and SHA256, conditionally writes the manifest, re-verifies its referenced versions, then conditionally commits the READY receipt under the live epoch. Lost manifest-write replies are recovered by adoption and verification. Existing READY receipts deduplicate completion. A fence during verification prevents the READY commit. URLs issued before a fence can still finish uploading to private attempt staging until expiry; they cannot publish a guarded READY receipt. Unpublished staging objects need lifecycle cleanup configured by the parent.

Input plans use the workflow's pinned numeric dataset versions, URI and manifest hash. Both the legacy verified manifest and parent `schemaVersion: 1` manifest (`identity`, `source`, `objects`) are supported. Object `bytes` becomes download `size`, and the schema-1 logical `path` must match its pinned object key. SHA256 checksum type and the composite part-count suffix are preserved and checked against the immutable S3 HEAD response. COMPOSITE is never labeled as whole-file proof; the Go hydrator verifies whole-file hashes only for FULL_OBJECT, while retaining composite identity and exact sizes. Checkpoint publication still requires FULL_OBJECT verification. The immutable registry version and manifest/object hashes must match before version-specific download URLs are returned. Paths must stay inside the same project. Missing snapshots/manifests fail explicitly; there is no latest-version lookup or unverified S3 listing fallback. The endpoint covers dataset snapshots, not task-dependency artifact discovery.

A download plan is not proof that FSx hydration has happened. The parent’s trusted `--prepare-inputs` init container consumes the plan before the regular runtime reports ready. Destinations must be dedicated dataset-cache paths under `/fsx/datasets/projects/<project>/`; producer checkpoint paths are rejected rather than written to. Parent snapshot mapping chooses the cache. The response includes matching `destination` and backward-compatible `fsxPath` fields. Input manifests must use the configured artifact bucket and supported verified manifest format. The actual MLflow proxy lives in the parent’s tracking-proxy module. Checkpoint restore selection uses the committed protocol described above.

The new Kubernetes methods in `k8s/resources.ts` are get/create/delete/listJobSets. Deletion uses foreground propagation and only ignores real 404s. JobSet listing and existing Pod listing follow every continuation token while preserving exact namespace/label filters. No Kubernetes/AWS mutations are made by unit tests.

Tests use MemoryKV, fake object storage, mocked Kubernetes transport, and a loopback Node HTTP server. AWS/EKS/S3 live integration, image deployment and worker routing remain the parent's work.
