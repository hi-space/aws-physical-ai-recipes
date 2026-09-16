# Workflow execution contract

`controller.ts` retains the existing public entry points. Production bootstrap registers adapters with `configureController`, or passes a complete `ControllerDeps` to each call. The canonical adapter types are in `ports.ts`.

## Submission and identity

`SubmitInput` adds optional `projectId`, `ownerSubject`, `backendId`, `queue`, `idempotencyKey`, and `deferLaunch`. A project submission requires an explicit server-selected namespace and queue; `none` and `auto` are rejected. These values replace client spec namespace/queue. The parent must authorize project/credential/resource access before calling the controller.

An idempotency key is scoped to project (legacy namespace), subject (legacy owner), and submission operation. A changed semantic spec returns HTTP 409. The workflow, tasks, key receipt, and dispatch/queue outbox are saved in one transaction. Dataset inputs record numeric versions, URI, FSx path, and available manifest hashes before work is launched. Retries reuse those snapshots. S3-to-FSx inference is restricted to the configured DRA bucket; other inputs need an explicit FSx mapping.

`deferLaunch: true` makes no Kubernetes calls. `dispatchWorkflow` and `enqueueWorkflow` adapters get a stable idempotency key and AbortSignal. The dispatcher must implement deterministic SFN execution naming/adoption. Workload launch waits for dispatch acknowledgement. Outbox retries use exponential delays capped at five minutes. Terminal callbacks are committed with terminal workflow state and can be redelivered after restart. Adapter operations must tolerate duplicate delivery.

`retryWorkflow(id, actor, deps?, { ownerSubject }?)` allows routes to snapshot the retrying Cognito subject. When no explicit subject is supplied, an old subject is reused only for the same owner.

## Reconciliation and cancellation

Each invocation takes a unique renewable run lease. Durable controller writes condition-check the live lease; the same holder is never used for two invocations. Primary-key reads are strongly consistent. The timer loop does not overlap itself, and direct/SQS reconciles use the same per-run lease.

Launch intent includes deterministic workload name, attempt, epoch (groups), and output path before external creation. Ambiguous create responses are followed by adoption. Ownership labels, attempts and stored Kubernetes UID prevent adopting another workload or a replacement object. A crash between creation and ledger acknowledgement leaves a recoverable `LAUNCHING` task.

Cancellation first records a durable intent. Task cleanup stays `CANCELLING` when deletion fails, the root still exists, matching pods survive, or the session adapter has not confirmed termination. No error is swallowed into terminal success. Retries use separate attempt names/paths, controller-owned bounded exponential backoff, and confirmed removal of the old workload/pods/sessions. Kubernetes Job backoff and JobSet restarts are disabled to prevent overlapping retry owners.

Task states add `LAUNCHING`, `INITIALIZING`, `CANCELLING`, `RETRY_WAIT`, and `FINALIZING`; workflow states add `CANCELLING` and `FINALIZING`. Existing terminal sets retain their meaning. Queue, initialization, and execution deadlines use their own transition times. Native group timeouts fail descendants while independent siblings retain their execution budgets.

## Outputs and datasets

An output task stays `FINALIZING` until `artifactPublisher.publish` returns a verified S3 manifest receipt. A receipt includes durable URI, manifest URI, SHA-256 manifest hash, verification timestamp, object count and byte count. Merely mapping an FSx path to an S3 string is never considered publication. The publisher must export/verify the objects, use `publicationId` for idempotent adoption, honor cancellation, and reject stale attempt writes.

`Repo.publishDatasetVersion(dataset, versionWithoutNumber, publicationId, lease?)` atomically creates a version, advances the latest pointer, and saves a publication receipt. Controller publications also condition-check the source task attempt and `FINALIZING` state. Dataset services should migrate from separate `putVersion`/`putDataset` calls to this method after their own upload verification. Legacy low-level metadata methods remain available.

Project output paths are `/fsx/checkpoints/projects/<project>/runs/<run>/attempts/<attempt>/<task>`. Legacy first attempts retain their old paths; retries get separate directories. For project runs, the main container mounts only the project's checkpoint subtree and read-only dataset subtree. Every input gets a narrow read-only subPath; paths outside the project are rejected. It runs as UID/GID 1000, without privilege escalation or capabilities, with service-account token automount disabled. The default `pai-workload` service account must be provisioned by the parent without an ambient AWS role. User host volumes are rejected. Legacy projectless runs retain their old mounts.

The trusted `runtimeImage` also supplies the storage initializer. Only this init container mounts the full PVC, checks path components for symlinks, creates project directories and sets UID/GID 1000 ownership. It receives no user commands, environment, or files. The image needs `/bin/sh`, `/bin/cp`, `mkdir`, `chown`, and `chmod`. A server-only `sharedReadOnlyPaths(workflow, task)` hook can grant vetted recipes read-only `envs` and/or `workshop` mounts. No shared mounts are enabled by default.

## Native OSMO groups and runtime boundary

The schema accepts `workflow.groups`, lead designation, barriers, `ignoreNonleadStatus`, exitActions ranges, checkpoints, excluded nodes, and native resource topology entries. Groups normalize into the flat task list with explicit group membership while retaining group metadata. Validation catches group-contracted dependency cycles, missing/multiple leaders, overlapping exit ranges, unsupported intra-group completion dependencies, path escaping, reserved compiler environment names, and file-key collisions.

`compileGroup` produces one `jobset.x-k8s.io/v1alpha2` JobSet admission root. Queue labels belong to the root, members have fenced attempt labels, generated child names fit DNS limits, and operator retries are disabled. It uses leader completion policy and a trusted workload runtime contract. Group status ignores nonleader failures only when requested; `observedPhase` and `ignoredByGroupPolicy` preserve that evidence.

Execution requires the JobSet adapter **and** a real `groupRuntime.observe/fence` adapter plus `runtimeImage` (or an explicitly preinstalled `runtimeCommand`). When `runtimeImage` is configured, a trusted init container copies `/opt/pai/runtime` from that image into an emptyDir. The workload mounts the binary read-only at `/opt/pai/runtime`, so its image needs no Python or preinstalled agent. `runtimeEnvironment(workflow, task, epoch, attempt)` supplies scoped `PAI_RUNTIME_*` variables after launch intent is persisted and before manifests are created. User overrides remain forbidden. The executable runs in the workload container as `runtimeCommand --contract <JSON> -- <user argv>`. The contract carries workflowId, projectId, namespace, task, attempt, epoch, outputPath, replicaIndexEnv, group membership, leader, barrier setting, exit policies and checkpoints. Groups include both member IDs and structured `{ id, task, replicaIndex, resource }` participants. Every group child is an Indexed Job, including one-replica members, and `PAI_REPLICA_INDEX` uses the completion-index Downward API. The runtime must report actual user exits, implement initialization/barrier handshakes, normalize ignored nonleader exits for JobSet, upload periodic/final checkpoints, and durably reject invalidated epochs. No worker process executes user shell code.

The parent provides the actual static runtime and participant API; these compiler and controller hooks use them directly. Submission fails explicitly when they are absent. Independent nonleader rescheduling with `ignoreNonleadStatus: true` is unsupported; use whole-group retry with false. Native hierarchical topology metadata parses, but execution explicitly rejects it because a verified Kueue co-location translation is not supplied. Task/group `{key, mode}` topology hints are a separate compiler extension, not native hierarchy equivalence. Checkpoint execution requires an installed trusted runtime. Native exitActions use the configured bounded `retry` budget (default zero retries).

## Artifact collector cleanup

The optional controller dependency is:

```ts
cancelArtifacts?: (workflow: Workflow, context: {
  signal: AbortSignal;
  taskNames?: string[];
  attempt?: number;
}) => Promise<boolean>;
```

The parent maps it to `cancelArtifactCollectors`. Cleanup passes the exact
unit task names, the current attempt and the run-lease signal, before the
no-workload-Job early return. Cancellation, failure and retry remain pending
while the hook returns false; it returns true only after matching inventory Jobs
and Pods (including possible in-flight creates) are gone. Exceptions remain
visible cleanup errors rather than fabricated terminal success.

`cleanupTarget === 'SUCCEEDED'` bypasses this hook. Legitimate COMPLETE results,
including nonzero application exits mapped to COMPLETE, can therefore enter
FINALIZING without fencing their publication. Successful publication itself
waits for collector cleanup before returning READY.

## Trusted image-profile bindings

The parent API supplies these server-only fields to `SubmitInput`; they are not
part of the workflow YAML or client metadata parser:

```ts
imagePins?: Record<string, {
  image: string;       // repository@sha256:<64 lowercase hex digits>
  profileId: string;
  profileVersion: number;
  checkedAt: string;
}>;
preflightReviewedBy?: string;
preflightReviewedAt?: string;
```

The fields persist on `Workflow` (`TaskImagePin` / `TaskImagePins` are exported
from `store/types.ts`). Submission copies the trusted bindings, replaces the
matching flat and grouped task images **before hashing**, and keeps the original
submitted YAML for history. Retry reapplies the saved immutable images and
preserves profile IDs, versions and review metadata. Missing pins retain legacy
image behavior.

Digest/profile-version bindings and reviewer identity affect idempotency.
Inspection/review timestamps remain audit metadata: repeating an otherwise
identical preflight does not invalidate the original idempotency key.

The optional `ControllerDeps.validateTaskPolicy(wf, taskSpec): Promise<void>`
hook runs for every member immediately before a new Job/JobSet creation, after
compilation/resource preparation. It receives effective pinned images and the
persisted workflow bindings; it must **throw** to veto creation and must not
rewrite images. All JobSet members must pass. Lease/cancellation checks still
run after the hook. Policy errors are outside create/adoption error handling,
so rejection cannot be mistaken for a lost Kubernetes creation reply.
Existing workload adoption does not create a new workload or rerun this hook.

The parent owns API preflight/acknowledgement, project profile approval and
production DDB approval-head validation. This module makes no ECR/IAM/AWS calls.

## Checkpoint recovery (second release)

Second-release checkpoint recovery accepts `checkpoint.url: auto` and resolves
`{{output}}` to the new attempt directory. The artifact bucket comes from trusted
`ControllerDeps.artifactBucket` or `DASHBOARD_ARTIFACT_BUCKET`, never user YAML.
Automatic retries preserve server-owned `checkpointRestoreSources` identities;
manual retries record `retryOf` and copy that lineage without reusing a source
capability. The compiler emits `checkpointRestore:true` for recovery startup.
The runtime restores only committed, version/checksum-pinned data before ready
or barrier release. See `dashboard/runtime/RESTORE.md` for the protocol and
MuJoCo declaration. A nonzero retry budget is still required for RESCHEDULE.

## Pagination and checks

`Repo.listWorkflows` retains its array return and adds optional `projectId`/`cursor`. `Repo.listWorkflowsPage` returns `{ items, cursor? }`. Project queries use a separate projection on the existing GSI, maintained atomically with the workflow; they never filter a globally truncated page. `reconcileAll` follows every cursor, including terminal runs with undelivered outbox entries.

Run scoped unit tests with `npx vitest run src/server/workflow src/server/store` from `dashboard/web`. Tests use MemoryKV and external adapter fakes, plus a DynamoDB SDK request contract test. They do not contact AWS. Real JobSet admission, runtime barriers, FSx exports and SFN callbacks still require the parent's integration tests.
