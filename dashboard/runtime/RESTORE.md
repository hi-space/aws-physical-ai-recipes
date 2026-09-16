# F09: committed checkpoint recovery (second-release protocol)

This is recovery, not just checkpoint export. Current-attempt credentials
authorize restoring immutable data from a server-recorded previous attempt.
No expired/fenced capability is reused. No IAM, deployment or image push is
part of this source change.

For Halley's MuJoCo builtin:

```yaml
checkpoint:
  - path: "{{output}}"
    url: auto
    frequency: 30s
    regex: '^(final|checkpoints/step-[0-9]+)/(model\.zip|vecnormalize\.pkl|manifest\.json)$'
exitActions: { COMPLETE: 0, RESCHEDULE: 75 }
retry: { max_retries: 1 }
```

The server resolves `auto` to
`s3://<artifact-bucket>/projects/<project>/runs/<run>/checkpoints/<task>/<index>/`.
Actual immutable publications retain their existing per-attempt prefixes.
Explicit S3 destinations retain their declared value and existing scope checks.
`{{output}}` in a checkpoint path resolves to the current attempt's output.

Automatic retry records prior workflow/task/attempt/epoch identities on the
next Task. Manual retry copies that server-owned lineage and records `retryOf`;
only a same-project, same-namespace lineage can restore data. Public request
bodies and YAML cannot supply lineage. The current compiler emits
`checkpointRestore:true` when prior sources exist.

Before ready=true or any barrier/process launch, the runtime calls:

```text
GET /runtime/checkpoints?replica=0
{
  "checkpoints": [{
    "index": 0,
    "path": "/fsx/.../attempts/2/train",
    "destination": "/fsx/.../attempts/2/train/.pai-resume/replica-0/checkpoint-0/<hash>",
    "publicationId": "<committed publication id>",
    "manifestHash": "<committed manifest hash>",
    "source": {"workflowId":"run","task":"train","attempt":1,"epoch":"previous"},
    "files": [{
      "path":"final/model.zip","url":"<fresh version-specific HTTPS GET>",
      "size":123,"checksumSHA256":"<base64 SHA256>",
      "checksumType":"FULL_OBJECT","versionId":"<immutable object version>"
    }]
  }]
}
```

Selection only uses READY publications, validates the exact manifest version
and digest, and rechecks every object's pinned version, size and storage
checksum. For multipart objects the storage checksum is COMPOSITE; a separate
full SHA256 was independently streamed/verified before commitment and is
recomputed by the Go downloader. See `MULTIPART.md` for this distinction.
Source lineage is checked against the current project/namespace. Missing READY
history permits an explicitly reported cold start; a corrupt committed
publication fails instead of silently falling back. A newly committed pointer
allows bounded direct lookup; older publication metadata can be adopted only
after the same complete verification.
New publications atomically update a small per-epoch/task/checkpoint index with
the READY plan. Legacy fallback is limited to 1000 plans from a recorded source
epoch and fails rather than truncating larger history. Retry lineage is bounded
to 32 source attempts. Each object verification batch has at most eight HEADs.

New clients request `pageSize=64` and follow the signed `nextCursor`; metadata
and source identity must remain identical across all pages. Negotiated plans
support 1024 total files and 1 TiB per file. Legacy unpaged response shapes are
preserved. The runtime assembles and validates the full plan before readiness.

Downloads use bounded concurrency and checksum verification, private paths
under the **new** output directory, and atomic files/receipts. A 403 refresh
reissues URLs only for the same selected source/publication/manifest/file set.
Fencing cancels restore. Failure reports a runtime error and never launches argv.

The child receives `PAI_RESUME_CHECKPOINTS`, a JSON map:

```json
{"/fsx/.../attempts/2/train":"/fsx/.../attempts/2/train/.pai-resume/replica-0/checkpoint-0/<hash>"}
```

The runtime replaces any inherited value. Restored roots have a private
`.pai-restore-receipt.json` identifying source/target and manifest. They are
hidden from the file browser and excluded from future checkpoint traversal.
After the user process exits and final checkpoints finish, private restored
contents are removed before the terminal report. This keeps a whole-output
artifact export from accidentally republishing old checkpoint copies. Cleanup
is confined to this replica's verified private directory; new training output
and other replicas are preserved. Mapping paths are valid for process lifetime.
First attempts receive `{}`. Restored-count or cold-start status is reported
without credentials or signed URLs.

MuJoCo keeps explicit `--resume` precedence. When it is empty, it verifies the
runtime mapping/receipt and chooses the compatible complete bundle with the
highest timesteps, then optimizer updates (final wins a remaining tie).
It loads PPO optimizer state and VecNormalize state, while writing all new
training output under the new run/attempt directory. Simulator/RNG state still
starts from the requested seed; it is not bit-for-bit simulator continuation.

## Verification and rollout

Local verification includes Go HTTP/subprocess restore and fencing tests,
TypeScript publication/restore/lineage tests with in-memory storage ports, and
real CPU MuJoCo recovery with the updated static binary and mounted recipes.
The CPU test deleted the first output directory after upload, restored via HTTP,
compared weights/optimizer tensors/normalization exactly, and advanced from 128
to 192 timesteps. Existing explicit resume and evaluation also passed.

Deploy the updated runtime, broker/compiler and recipe image together in the
**second release**. Existing first-release image tags were not replaced.
The separate live `e2e/checkpoint-recovery.spec.ts` requires explicit
`DASHBOARD_CHECKPOINT_RECOVERY_LIVE=1` plus the updated MuJoCo image and existing
researcher auth environment. It has not been executed against AWS.
