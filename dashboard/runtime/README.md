# Physical AI workload runtime

`pai-runtime --contract '<JSON>' -- <program> [args...]` runs an actual workload
process on Linux amd64 or arm64. It uses only the Go standard library, with no
shell dependency, AWS SDK, credentials lookup, or direct AWS API calls.

## Compiler / broker integration protocol

The compiler must finish injected-file copies, permissions, output-directory
creation, and other local preparation **before** invoking this executable.
Startup does not copy files or execute shell fragments from the contract.

Required environment:

* `PAI_RUNTIME_ENDPOINT`: absolute HTTP(S) broker base URL, optionally with a
  path prefix. No userinfo, query, or fragment. The compiler supplies the private
  service address; the runtime does not discover it.
* `PAI_RUNTIME_TOKEN`: scoped bearer credential. Sent only to the broker, never
  to upload URLs, logs, argv, or the child environment.
* Replica: first nonempty `OSMO_TASK_REPLICA_INDEX`, then
  `JOB_COMPLETION_INDEX`, then compiler-compatible `PAI_REPLICA_INDEX`, then
  `0`. Values must be nonnegative decimal integers. Optional `replicaIndexEnv`
  accepts these three trusted environment names.

Contract shape matches `web/src/server/workflow/compile.ts` and `ports.ts`:

```json
{
  "workflowId": "run-123",
  "task": "trainer",
  "attempt": 1,
  "group": {
    "name": "training",
    "epoch": "epoch-1",
    "members": ["trainer:0", "worker:0"],
    "barrier": true,
    "ignoreNonleadStatus": true,
    "lead": "trainer"
  },
  "checkpoint": [
    {"path": "/checkpoints", "url": "s3://bucket/prefix", "frequency": "30s", "regex": "\\.pt$"}
  ],
  "exitActions": {"COMPLETE": "0,10-12", "FAIL": 1, "RESCHEDULE": "75"}
}
```

`group`, `checkpoint`, and `exitActions` may be omitted. `lead` is a **task
name**, so all replicas of that task use leader semantics. The current replica
must occur in `members`. Action ranges accept numbers or comma-separated
inclusive ranges from 0 through 65535, matching the compiler. Actual Linux
process exits are 0–255; signals are reported as 128 + signal.
Optional compiler metadata `projectId`, `namespace`, `epoch`, `outputPath`,
`replicaIndexEnv`, and `group.participants` is accepted and validated.
Participant entries are `{id,task,replicaIndex,resource}` and must agree with
the member list. The runtime still takes authorization scope from the bearer.

All broker calls use `Authorization: Bearer <token>`. The token identifies the
workflow, task, attempt and group epoch; the broker must enforce that scope.
State POSTs must be idempotent: network retries can repeat a request.

1. Validate contract, environment, command and checkpoint configuration.
2. `POST /runtime/state` with
   `{"phase":"INITIALIZING","ready":false,"replica":0}` after compiled file setup.
   No user process has started.
3. Check `POST /runtime/heartbeat` (empty JSON object): **204** is valid;
   **410** fences the runtime. Other failures retry within bounded deadlines,
   then fail closed. On retry, restore committed checkpoints under this new
   capability while heartbeats remain active. See `RESTORE.md`.
4. Report `INITIALIZING` with `ready:true` only after restore is complete, then
   poll `GET /runtime/barrier?replica=0` until `{"released":true}`. This call is
   mandatory even for standalone tasks or `group.barrier:false`: the broker
   must keep `released:false` until its preparation is ready, and apply the
   all-member barrier only when configured. The runtime never bypasses broker
   preparation readiness.
5. Report `{"phase":"RUNNING","ready":true,"replica":0}` and start argv directly.
   Continue heartbeats throughout execution and final checkpoint publication.
   Group members also poll the barrier during execution.
6. `{"released":true,"stopped":true}` stops **nonleaders**, including ones still
   waiting at the barrier. A leader ignores `stopped` and finishes according to
   its own process exit. Fencing (410) always stops any member.
7. After cleaning up the process group and publishing final checkpoints, POST
   terminal state with `ready:false`, the **raw observed** `exitCode`, and a
   message containing the selected action. `phase` describes the raw process
   outcome (`SUCCEEDED` for 0, otherwise `FAILED`); an explicit COMPLETE action
   does not erase an observed failure. The controller applies `exitActions`.
   Infrastructure/checkpoint failures report `FAILED` and remain failures even
   when the user process exited 0. A process that never started has no raw exit
   code. A nonleader stopped before process launch reports `FAILED` without
   an exit code. Coordinated nonleader stops use a **`group-stopped:`** message;
   the broker/controller should retain the raw evidence and recognize this as
   a consequence of the group's recorded terminal decision.
   Infrastructure failures begin **`runtime-error: `**; the controller must give
   that prefix precedence over COMPLETE/ignoreNonleadStatus policies so a raw
   successful exit cannot hide failed final publication.

State and legacy upload-complete POSTs accept any 2xx response. V2 completion
requires matching terminal COMPLETE/READY JSON, including after streamed
keepalives; HTTP 200 alone is not success. Barrier and upload-plan
responses must be 200 and well-formed JSON. A 410 on **any broker route** fences
the runtime. The terminal failure report after fencing is best effort; a fenced
broker is expected to reject it. The broker owns durable retry scheduling.

| Workload action | Container exit |
| --- | --- |
| Default / COMPLETE | Raw exit, or 0 for COMPLETE |
| FAIL | Raw nonzero exit, or 1 when raw exit is 0 |
| RESCHEDULE | Raw nonzero exit, or 75 when raw exit is 0 |
| Ignored nonleader workload failure | 0; raw FAILED event is still posted |
| Nonleader stopped by leader completion | 0; observed signal/exit is preserved |
| Runtime, checkpoint, broker, or fencing failure | 125 |
| Invalid invocation / contract / environment | 125 |

Normalization never hides runtime or final-checkpoint failures. Signals sent
to the runtime initiate process-group SIGTERM, then SIGKILL after a bounded
grace period; externally cancelled execution fails and is not normalized.
Child stdout/stderr stream to the runtime's stdout/stderr; no log buffering
or upload is required. The child does not receive `PAI_RUNTIME_TOKEN`.

## Checkpoint publication

Current large-file protocol, rolling compatibility, pagination and cleanup are
specified in `MULTIPART.md`. The single-PUT example below is the preserved
legacy protocol; new runtimes negotiate v2 per-file and multipart descriptors.

For each entry, select regular files under `path` (or that file's basename when
`path` is a file). `regex`, if present, uses Go/RE2 syntax against slash-separated
relative paths. Skip symlinks and special files. Open directory components and
files with Linux `openat` plus `O_NOFOLLOW`, including the checkpoint root, so
renames and symlink substitutions cannot redirect traversal outside that root.

Snapshot each selected file into a private temporary directory while computing
SHA256; this makes uploaded bytes match the manifest even if the workload later
rewrites its checkpoint. Files changing size or modification time during the
snapshot fail that publication. Workloads should publish checkpoint files using
atomic rename for a consistent application-level snapshot.

```text
POST /runtime/uploads
{
  "purpose": "checkpoint",
  "destination": "s3://bucket/prefix",
  "files": [
    {"path": "weights/model.pt", "size": 123, "checksumSHA256": "<base64 SHA256>"}
  ]
}

200
{"uploads":[{"path":"weights/model.pt","url":"https://presigned-put-url","headers":{"x-amz-checksum-sha256":"..."}}]}

PUT <url>     (exact snapshot bytes; only validated upload headers; no bearer)

POST /runtime/uploads/complete
{
  "purpose": "checkpoint",
  "destination": "s3://bucket/prefix",
  "files": [
    {"path": "weights/model.pt", "size": 123, "checksumSHA256": "<base64 SHA256>"}
  ]
}
```

The plan must contain exactly one upload per requested path with no duplicates,
unexpected paths, unsafe URLs or headers. The broker must validate checksum,
size, destination authorization, and the current epoch at completion; PUT
success alone is **not** publication success. An empty selection is an error,
including a missing path or a regex that matches nothing.

Each entry publishes periodically at its configured positive `Ns`, `Nm`, `Nh`,
or `Nd` frequency. Periodic failures are logged and retried on the next cycle.
Every configured entry is required again at process termination, including
nonleader completion and external termination. Final failure forces exit 125.
Fencing cancels uploads and prohibits further publication.
An initialization/restore failure before user argv starts does not publish an
empty replacement checkpoint.

Second-release F09 recovery is specified in `RESTORE.md`: `checkpoint.url:auto`
is resolved by the server, previous committed versions are restored before the
barrier, and `PAI_RESUME_CHECKPOINTS` contains only new-attempt private paths.
The MuJoCo recipe consumes it when `--resume` is empty. Upload alone is not
reported as successful recovery.

Limits: 256 KiB contract, 1024 files/300,000 metadata bytes per publication,
2 MiB broker response, and **1 TiB per checkpoint file** with protocol v2.
Legacy single PUTs remain bounded to 5 GiB. Snapshots require
temporary disk space equal to the selected data. Control requests have 10-second
attempt deadlines and three attempts (409/429/5xx and transport failures retry);
each PUT has a 5-minute attempt deadline and three attempts. Redirects and HTTP
proxy environment variables are disabled.
Errors never print broker bodies, presigned URLs, or bearer credentials.

Defaults: 1-second barrier polling, 5-second heartbeats, 5-second process
termination grace, and a 30-minute publication deadline for periodic checkpoints
and ordinary process exits (including exit 75). External-stop final checkpoints
default to 30 seconds, plus a bounded failure report. Trusted
`PAI_RUNTIME_CHECKPOINT_TIMEOUT_SECONDS` and
`PAI_RUNTIME_FINAL_CHECKPOINT_TIMEOUT_SECONDS` accept 1–21600 seconds.
The compiler must provision termination grace for the chosen external-stop
deadline plus cleanup/reporting; the default needs at least 60 seconds. Large
checkpoints must fit their configured time and scratch-disk budgets.

## Build and test

From this directory with Go 1.25:

```sh
go test -race ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o pai-runtime .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o pai-runtime-arm64 .
docker build --build-arg TARGETARCH=amd64 -t pai-runtime:local .
docker build --build-arg TARGETARCH=arm64 -t pai-runtime:arm64 .
```

The multi-stage Dockerfile places a static executable at `/opt/pai/runtime`
and includes `/bin/sh` and `cp` in its initContainer image:

```yaml
command: ["/bin/cp", "/opt/pai/runtime", "/pai-runtime/runtime"]
```

Mount an emptyDir at `/pai-runtime` in the install initContainer and mount the
same volume read-only at `/opt/pai` in the workload container.
Use the image matching the workload node architecture; the copied executable
needs no Go installation, libc, shell, or image-specific package in the workload.
The runtime image includes a public CA bundle for HTTPS input hydration.
The copied executable uses the workload image's system CA trust (or Go's
`SSL_CERT_FILE` / `SSL_CERT_DIR` settings); the binary does not embed a CA bundle.
Images without system trust must mount a CA bundle as well.

The runtime performs no image build, push, deployment, AWS SDK operation, or
controller change. Process-group cleanup covers ordinary descendants;
workloads must not daemonize into another session/process group.

## Connectivity isolation init gate

`pai-runtime --verify-isolation` is a standalone initContainer mode. It requires
no contract, broker endpoint, or bearer token, and rejects additional arguments
(including child commands). The parent places it after storage preparation and
before input hydration, with the network policy already installed.

Each round attempts IPv4 TCP connections to **both**
`169.254.169.254:80` and `169.254.170.23:80`, with a **500 ms deadline per
connection**. Any established connection is immediately closed; the runtime
never sends HTTP, reads a response, or fetches credentials or metadata.
It exits 0 only after **three consecutive rounds** where both connections are
denied, unreachable, or time out. A reachable endpoint resets the count.
Rounds have a one-second pause; the **120-second overall deadline** includes
all probes and pauses. Deadline, cancellation, or unexpected local dial
failures (such as exhausted file descriptors) exit 125. A local resource error
is not treated as proof of isolation.

This checks connectivity from that pod at startup; continued enforcement
belongs to the installed network policy. It changes no policy and performs no
AWS API operation. Unit tests inject the dialer/checker and never contact these
link-local endpoints.

## Dataset hydration initContainer

`pai-runtime --prepare-inputs --contract '<JSON>'` validates and downloads pinned
dataset inputs before the workload container starts. It uses the same contract,
endpoint and bearer environment. It does not run a workload or report group
readiness: the normal runtime reports readiness only after this initContainer
and compiler file setup have succeeded. The initContainer must mount the
authorized FSx dataset cache writable.

```text
GET /runtime/inputs
{
  "inputs": [{
    "destination": "/fsx/datasets/projects/project-1/cache/dataset-v1",
    "manifestHash": "<64-character hex or base64 SHA256>",
    "files": [{
      "path": "images/frame.png",
      "url": "https://version-specific-presigned-get-url",
      "size": 123,
      "checksumSHA256": "<base64 SHA256>",
      "checksumType": "FULL_OBJECT"
    }]
  }]
}
```

Canonical field names above match the parent request. For compatibility with
the broker's initial proposal, `fsxPath` is accepted as an alias for
`destination` (both must agree if supplied), plus optional `index` and per-file
`versionId`. No other shape adjustment is required. The broker must derive
destinations and URLs from immutable authorized manifest snapshots.
If a pinned snapshot points at a producer's `/fsx/checkpoints/...` output,
the broker/compiler must choose a dedicated `/fsx/datasets/...` hydration cache
and mount that cache as the input. Hydration does not write into producer outputs.

Destinations must be clean absolute paths under `/fsx/datasets/`. When a
`projectId` is present, they must be strictly under
`/fsx/datasets/projects/<projectId>/`. All filesystem access is anchored to
directory descriptors and refuses symlink ancestors. Manifest paths must be
clean relative paths with no duplicates or file/directory conflicts.
Downloads have four workers, bounded retries/deadlines, exact byte counts,
no redirects, and no forwarded bearer. No AWS credentials or SDK are used.
Files are written as exclusive temporary regular files and renamed atomically
only after validation. Given SHA256 values must be base64-encoded 32-byte
digests. `FULL_OBJECT` (also the default when a checksum has no type) is
verified. `COMPOSITE` permits the digest's optional `-<part-count>` suffix and
is not a whole-file checksum, so it is not compared; size
and pinned manifest identity are still enforced.

The runtime reserves `.pai-input-receipt.json` and `.pai-input-lock` inside each
destination. A receipt has `{"version":1,"manifestHash":"..."}` and is atomically
written only after all files pass validation and a final valid heartbeat.
Cache skipping requires an exact receipt hash match **and** revalidation of
every file's type, size and available whole-file checksum. A missing, malformed
or mismatched receipt triggers hydration. File locking serializes concurrent
initializers for a destination; paths with conflicting manifests are replaced
only after invalidating the prior receipt. Cache directories must be dedicated
to one pinned dataset version.

Hydration limits: 64 inputs, 1024 total files in a negotiated paged plan, 2 MiB response, 30-minute
overall deadline, 5-minute download attempts, three attempts per download.
Dataset GETs stream with the common 1-TiB file cap. Failure,
checksum mismatch, cancellation or fencing exits 125. No new receipt is written
for incomplete data or after a failed lease check. An existing receipt certifies
cached manifest contents, not the continued validity of a task capability.
InitContainer success exits 0; subsequent workload startup
remains gated by `/runtime/barrier`.

### Refreshing expired signed input URLs

On a download HTTP **403**, the runtime requests `GET /runtime/inputs` again
using its scoped broker bearer, then retries using the refreshed signed URL.
The refreshed input must have the **same destination, manifest hash, index
when supplied, complete file set, paths, version IDs, sizes, SHA256 values,
and checksum types**. Only URLs may change. The entire replacement input
is validated before its URLs are used; changed/missing manifests or files
fail preparation and do not publish a receipt. There is no lookup of `latest`
and no fallback to an unpinned object.

Refreshing requires nonempty pinned `versionId` values (not `"null"`) for every
file in that input. Plans without version IDs can still download using their
original URLs, but expiry fails visibly because version identity cannot be
proven. The four workers share validated URL generations, so one worker's
refresh also updates queued downloads and concurrent failures reuse it.
The existing **three attempts per file** and **30-minute preparation deadline**
still apply; repeated 403s cannot create an unbounded refresh loop. Broker
authentication failures and fencing fail preparation, and broker credentials
are never forwarded to download URLs or logged.

## F24 loopback file browser and transfers

Normal workload execution starts a file service on **127.0.0.1:8077** when the
contract supplies `outputPath`. Both read and write root are **exactly that
existing directory**; requests cannot select another root. The compiler has
already prepared it before runtime startup. Missing/unsafe roots and bind
failures produce a `runtime-error:` failure before user argv starts.
Legacy contracts without `outputPath` have no file service.

The parent adds named container port `pai-files` (8077) and accesses it through
its authenticated, workflow/task-scoped gateway port-forward. The service has
no runtime-bearer authentication and no Pod-IP/public listener. Gateway session
authorization and browser CSRF policy remain gateway responsibilities.
Serve the HTML page at a prefix ending in `/`; all UI URLs preserve that prefix.

| Method and path | Behavior |
| --- | --- |
| `GET /` | Self-contained browser with folder navigation, upload and download |
| `GET /api/files?path=<relative>` | JSON listing; missing/empty path means root |
| `GET /files/<relative>` | Stream a regular file as an attachment |
| `PUT /files/<relative>` | Stream raw bytes; create safe parents and atomically replace a file; 204 on success |

No deletion endpoint exists. Other methods return 405; unknown routes return
404. Listings have the following shape:

```json
{"path":"models","entries":[{"name":"weights.pt","path":"models/weights.pt","type":"file","size":123,"modifiedAt":"2026-09-16T00:00:00Z"}],"maxUploadBytes":5368709120}
```

Directory entries have type `directory` and size 0. Listings sort directories
first, then names, and fail explicitly above 4096 entries or 2 MiB. Unsafe
entries, symlinks, special files, multiple-hard-link files, and reserved runtime
names are omitted. Direct requests for such paths fail. All path components
are opened relative to directory descriptors with `O_NOFOLLOW`; traversal,
absolute paths, control/format characters, backslashes and reserved `.pai-*` /
`pai-checkpoint-*` components are rejected.

Downloads use `application/octet-stream`, attachment disposition and `nosniff`.
The browser uses text nodes for names and percent-encoded path segments, with
a restrictive CSP and no external assets. It does not render uploaded HTML.
Browser-generated download filenames may be sanitized by the browser itself.

Uploads default to a **5 GiB hard ceiling**. Trusted
`PAI_RUNTIME_FILES_MAX_BYTES` can lower this to any positive integer byte count;
values above 5368709120 are rejected. Known-length and chunked oversized
uploads return 413. Staging files use reserved `.pai-files-upload-*` names,
are excluded from listings and checkpoint traversal, and are atomically renamed
only after the complete stream and file sync. Concurrent writers commit whole
files; the last completed rename wins. Interrupted/pre-commit failed uploads
remove staging and preserve the old target. If directory sync fails after
rename, the server returns 500 and the new file may already be visible.

The service bounds work to 16 requests and four uploads at once (429 when
busy), 10-second headers, 15-minute transfers and 30-second idle connections.
Errors are sanitized JSON `{"error":"..."}`. No scoped tokens, private root
paths or request bodies are logged. Checkpoint scratch is selected outside
`outputPath`, even when `TMPDIR` points into it; scratch allocation fails
visibly if no safe writable location is available.

The listener and active transfers stop on workload exit, termination or fencing,
before final checkpoints. `--prepare-inputs` and `--verify-isolation` never start
this service. After workload exit, durable files remain available through the
parent's artifact/checkpoint APIs rather than this process.

Trusted `PAI_RUNTIME_FILES_DISABLED=1` skips this listener entirely, including
filesystem setup for it. Unset means enabled; every other explicit value is
rejected for ordinary execution. Parent sets this for trusted hostNetwork
profiles and denies their file/port sessions separately. An old runtime binary
does not understand this flag, so hostNetwork use requires the rebuilt runtime.

The early parent handoff is `/tmp/physical-ai-files-protocol.md`. Unit tests use
real HTTP transfers and temporary directories. Browser testing exercised
upload/download, directory navigation, literal HTML-like filenames, gateway
prefix preservation through a real local reverse proxy, and a 375-pixel viewport.

## Source map and verification

* `main.go`, `contract.go`: CLI, compiler schema, action ranges, environment.
* `client.go`: authenticated broker protocol, response bounds, deadlines/retries.
* `process_linux.go`, `runtime.go`: process group, readiness, fencing, signals,
  lifecycle state and checkpoint scheduling.
* `checkpoint_linux.go`: safe traversal, snapshots, upload plan and publication.
* `restore_linux.go`, `RESTORE.md`: committed checkpoint recovery, private
  process-lifetime paths, current-capability URL refresh and model handoff.
* `inputs_linux.go`: signed downloads, cache receipts, locks and atomic files.
* `input_refresh.go`: bounded signed-URL renewal preserving pinned identities.
* `isolation.go`: connectivity-only startup gate with an injectable dialer.
* `files_linux.go`, `files_server.go`, `files_ui.go`: rooted filesystem API,
  loopback lifecycle, transfer limits and the self-contained file browser.
* `*_test.go`: HTTP fixtures, real subprocesses, static CLI/SIGTERM integration,
  malformed contracts/responses, checksum failures, cache reuse and fencing.
* `go.mod`, `Dockerfile`, `README.md`: dependency-free module, multi-architecture
  image and integration protocol.

Verified locally with Go 1.25.14 in the permitted public toolchain container:
`go test -race ./...`, `go vet ./...`, static amd64/arm64 cross-builds, and
both Docker image builds. Tests use localhost `httptest` services; real broker,
FSx and object-storage integration is the parent's remaining validation.
