# Checkpoint upload protocol v2

The Go runtime and broker support files through **1 TiB**, with bounded-memory
multipart transfers and independently verified full-file SHA256. This is
filesystem-byte recovery, not a guarantee about a model's trajectory, sampler,
optimizer completeness, or RNG state.

## Negotiation and rolling deployment

Old requests without `protocolVersion` retain the exact
`{"uploads":[{"path","url","headers"}]}` response and single-PUT limit of 5 GiB.
Their completion request/receipt is unchanged. A legacy request above 5 GiB is
rejected before uploads start.

New runtimes register with `protocolVersion:2`. If an old broker rejects those
fields with HTTP 400/404, only files within the legacy 5-GiB limit may fall back
to the exact old request shape. Large files never downgrade. Existing legacy
input/restore GETs remain unpaged; pagination is explicitly requested.

All URLs are broker-issued, expire after 300 seconds, and receive no runtime
bearer. The scoped bearer goes only to `/runtime/*`.

## Wire contract

Registration:

```json
{
  "protocolVersion": 2,
  "snapshotId": "<32 lowercase hex characters>",
  "purpose": "checkpoint",
  "destination": "s3://artifact-bucket/projects/project/checkpoints/",
  "files": [{"path":"model.bin","size":5369757696,"checksumSHA256":"<base64 full SHA256>"}]
}
```

`POST /runtime/uploads` returns
`{publicationId,state:"PENDING"|"READY",uploads:[]}`. The Go runtime creates one
random snapshot ID per immutable local snapshot, retaining it through retries.
A new snapshot is a new publication. The publication hash binds its manifest,
project, workflow, task, attempt, and epoch.

| POST endpoint | JSON request | Result |
| --- | --- | --- |
| `/runtime/uploads/file` | `{publicationId,path}` | `{path,mode:"SINGLE"|"MULTIPART",state,partSize,partCount,url?,headers?}` |
| `/runtime/uploads/part` | `{publicationId,path,number,checksumSHA256}` | `{state:"UPLOAD",number,url,headers}` or `{state:"UPLOADED",number}` |
| `/runtime/uploads/file/complete` | `{publicationId,path}` | terminal `{path,mode,state:"COMPLETE",partSize,partCount}` |
| `/runtime/uploads/complete` | same registration manifest | immutable READY receipt |
| `/runtime/uploads/abort` | `{publicationId}` | `{state:"ABORTED"|"READY",clean:true}` after reconciliation |

Files through 64 MiB use immutable single PUTs; larger files use multipart.
Part size is `max(64 MiB, ceil(size / 10000 / MiB) * MiB)`, keeping at most
10,000 parts. For **5 GiB + 1 MiB**, this is **81 parts**: 80 full 64-MiB parts
and a 1-MiB final part.

The broker stores each part's checksum/length once. A repeated part request
checks S3's actual part before returning UPLOADED; mismatched identities fail.
A missing part gets a freshly signed, checksum/length-bound URL. The runtime
rechecks this status after expired URLs or ambiguous PUT responses, using
128-KiB hash/copy buffers and streaming `SectionReader` bodies.

File states are CREATING → OPEN → COMPLETING → COMPLETE. A durable lease and
revision checks serialize initialization/completion/abort across broker
instances. Lost initiation replies reconcile the exact object's multipart IDs;
ambiguous multiple initiations fail and can be aborted. Lost completion replies
reconcile the actual object version, metadata, size and composite checksum.
Completion uses S3-listed ETags, not caller-supplied ETags.

S3's multipart SHA256 is **COMPOSITE**. It is not used as the full-file digest.
Before a file becomes COMPLETE, the broker streams its pinned S3 VersionId
through native SHA256, checks exact length and compares the full digest with
the immutable snapshot manifest. Lease/auth/fence checks continue during the
stream. A disconnect restarts verification on retry; it does not retransmit
already completed parts/object bytes. No full object is buffered in the broker.

Both v2 completion endpoints send HTTP 200 and periodic JSON whitespace while
working, preventing proxy idle expiration. The **terminal JSON** determines
success. Errors after headers are `{state:"ERROR",status,error}`; status 410
still fences the runtime. The client requires COMPLETE per file and a matching
READY receipt (publication ID, immutable manifest version/hash, count, size and
verification timestamp). Headers or a successful PUT are never publication.
Completion contention/dependency failures poll with bounded backoff and an
overall deadline.

Manifest objects retain `checksumSHA256` as the independently verified full
digest and separately store `storageChecksumSHA256`/`storageChecksumType`.
Restore verifies the pinned storage identity and sends FULL_OBJECT SHA256 to
the hydrator, which recomputes it from downloaded bytes.

## Plan limits and pagination

`GET /runtime/inputs?pageSize=64` and
`GET /runtime/checkpoints?replica=0&pageSize=64` return their normal group
envelopes plus optional `nextCursor`. Continue with the same pageSize and
`cursor=<nextCursor>`; a group may span pages. Cursors bind the entire immutable
plan and current task/attempt/epoch. Changed manifests, versions or scope reject
the cursor. Go assembles and validates the whole plan before hydration/readiness.
Expired-download URL refresh uses the same paged protocol and preserves all
pinned identities.

- At most 64 groups and **1024 total files** in a negotiated input/restore plan.
- At most 1024 files and **300,000 encoded metadata bytes** per checkpoint
  registration; 1 TiB per file.
- Relative paths at most 1024 UTF-8 bytes; the full generated S3 key must also
  fit 1024 bytes. Traversal, percent escapes and control characters are rejected.
- A JSON request/response is bounded to 2 MiB. URL pages hold at most 64 files.
- Legacy unpaged plans retain their existing per-manifest/wire limits; no
  response is silently truncated.

`web/src/server/runtime/limits.ts` is the admission contract for parent
dataset/snapshot/submission code. Unsupported negotiated aggregates must be
rejected before scheduling by those callers; the broker/runtime also fail
closed before child execution.

## Deadlines, disk, cleanup and parent wiring

Normal-exit and periodic checkpoints share a 30-minute publication deadline.
`PAI_RUNTIME_CHECKPOINT_TIMEOUT_SECONDS` can set 1–21600 seconds for publication,
restore and input preparation. External-stop final checkpoints default to
30 seconds; `PAI_RUNTIME_FINAL_CHECKPOINT_TIMEOUT_SECONDS` can set 1–21600.
Invalid settings reject startup. Parent termination grace must cover the chosen
stop deadline plus process cleanup/reporting. Each part transfer is bounded to
five minutes. A file's full verification is bounded to six hours and the
client's earlier deadline.

Snapshots use private disk outside outputPath, proportional to selected bytes.
Budget at least the checkpoint size in scratch space (`TMPDIR` may select an
approved private filesystem), plus FSx space for restored bytes. RAM does not
scale with file size. These limits do not promise that every 1-TiB transfer will
finish on every network within a configured deadline.

Abort uses a valid signed task capability even after task/epoch fencing, but
cannot publish or delete READY data. Expired capabilities still fail. Active
publication IDs are held in a bounded per-task/epoch registry (128 pending);
part/session metadata has a nine-day TTL. Cleanup can reconstruct ownership
after metadata expiry. Retrying abort reconciles late visible uncommitted
versions. Pre-issued presigned requests can briefly outlive a fence; fencing
always prevents READY publication.

Parent controller integration:

```ts
import { cleanupCheckpointUploads } from './runtime/upload-cleanup';
await cleanupCheckpointUploads(brokerDeps, workflow, {
  signal, taskNames, attempt,
}); // false: reconciliation/lease is pending; retry cleanup
```

Call before replacing an attempt's epoch, on cancellation/failure/retry, and
after a wrapper has finished if cleaning leftover uncommitted periodic work.
READY checkpoints are always retained. The runtime requests abort on failed
publications; the controller hook covers process death, expired capabilities
and interrupted cleanup. Keep bucket AbortIncompleteMultipartUpload lifecycle
cleanup as an orphan fallback. Object-version cleanup is scoped to registered
uncommitted keys, not unrelated or committed data.

Verify broker-role permissions: `s3:PutObject`, `s3:ListMultipartUploadParts`,
`s3:ListBucketMultipartUploads`, `s3:AbortMultipartUpload`,
`s3:GetObjectVersion`, and `s3:DeleteObjectVersion`, plus existing manifest/HEAD
permissions. This code makes no IAM or deployment changes.

AWS checksum reference:
`https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html`
