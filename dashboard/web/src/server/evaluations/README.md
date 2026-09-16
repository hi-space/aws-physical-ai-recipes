# Project model registry and published evaluation evidence

Models are registered from completed, published task outputs. Registration pins the source and does **not** approve quality. Evaluation metrics come from the bytes of a versioned `evaluation.json`, never from a client-supplied metrics object.

This implementation adds no store types, engine behavior, infrastructure, web dependencies, or SageMaker Registry mutations. `promotion-policy.ts` and its tests are reused unchanged.

## API

All endpoints use the existing `route()` wrapper. The project comes from the existing project header/cookie selection; the service independently calls `resolveProject` on every public operation. Writes require both platform `researcher` and project `researcher` permission, or platform admin. Cross-project record IDs return no data.

| Endpoint | Request / result |
|---|---|
| `GET /api/models?cursor=...` | Project model page, eligible published output versions, write capability, default policy. No unscoped AWS models. |
| `POST /api/models` | `{name, dataset, version, checkpointPath}` → registered model. |
| `GET /api/models/:id` | Model lineage, recent evaluations and gate decisions, project write capability. |
| `GET /api/models/outputs/:dataset/:version` | Hash-verified manifest checkpoint/report choices and their version/checksum pins. |
| `POST /api/evaluations` | `{modelId, dataset, version, reportPath?}` → verified evaluation record. `reportPath` defaults to `evaluation.json`. Other fields, including manual numbers, are rejected. |
| `GET /api/evaluations?modelId=...` | Model evaluation history. |
| `GET /api/evaluations/:id` | A project-scoped evaluation and its provenance. |
| `GET /api/evaluations/:id/artifact?kind=report\|video` | Authorized redirect to the pinned report or first video object, with exact VersionId and a five-minute signed URL. |
| `POST /api/models/:id/promotion` | `{evaluationId, policy?, approve?}` → model and recorded gate. `approve: false` records a check; `approve: true` requires a passing verified result and records explicit application approval. |
| `GET /api/models/legacy` | **Admin only.** Existing SageMaker artifact folders, EKS checkpoints, SageMaker packages, and MLflow models. Each source has `ok`, `not_configured`, or `error`; failures never become empty successful lists. |

The default policy is `{minimumEpisodes: 20, minimumSuccessRate: 0.8, maximumLatencyP95Ms: 100}`. The UI exposes all three thresholds. Policy checks and approvals reuse `evaluatePromotion(metrics, policy)`.

No endpoint updates SageMaker `ModelApprovalStatus`. The legacy browser labels existing approval information as smoke/registry-only, separate from application quality approval.

## Publication and lineage checks

Registration requires all of:

- Dataset and version belong to the selected project; the version is `READY`.
- `producedBy` names a workflow in that project and an accessible, `SUCCEEDED` task.
- `producedAttempt` matches the task attempt; the task has matching `publishedVersions` and `artifactReceipts`. A failure ignored by group policy is not accepted.
- The manifest URI is exactly the selected version's `manifest.json`, under `DASHBOARD_ARTIFACT_BUCKET/projects/<project>/`.
- The observed manifest VersionId is pinned before reading; its full content hash matches the dataset's committed `manifestHash`.
- Manifest identity is the declared runtime publication, and every file key equals the snapshot prefix plus its safe relative path.
- The selected checkpoint's versioned HEAD metadata matches its manifest VersionId, byte count, checksum and checksum type.
- Conditional DynamoDB writes verify source dataset, task attempt/phase, and workflow project/spec identity again at commit time.

The model preserves source workflow, task, attempt, task image URI, workflow spec hash, input dataset snapshots and upstream task IDs. The image value is the URI recorded by the submitted workflow; no observed Pod image digest is invented.

For the known SO-101 PPO `.../model.zip` format, registration also loads the versioned adjacent `manifest.json`, verifies its model and VecNormalize SHA-256 values, pins `vecnormalize.pkl`, and records task/seed/simulator/scene. A compatible automatic MuJoCo evaluation link is provided only when this bundle is verified.

Evaluation ingestion checks the same publication requirements and additionally requires:

1. An evaluation task input pinned to the model's dataset name/version/URI/manifest hash, or that exact producer-task output and attempt in the same pipeline run.
2. Report `checkpointDigest` equals the model's full-file SHA-256.
3. For MuJoCo, normalization digest and task/simulator/scene agree with the registered bundle.
4. Finite/count-consistent results, completed rounds, ordered latency quantiles, consistent per-episode success/timeout totals and sequential seeds.
5. Video references remain in the report's published snapshot; the primary video is version/checksum verified before linking it.

`type: closed_loop` maps to promotion `kind: simulation`, `episodeCount` to `episodes`, `successCount` to `successes`, and `latencyMs.p95` to `latencyP95Ms`. Missing latency remains absent, allowing the existing policy to return review. Successful time-limit episodes may be both `success=true` and `timeout=true`; these are independent counts in the actual MuJoCo report.

Verification means publication bytes, object identity and source lineage were checked. It does not attest arbitrary user-authored workload code or independently establish physical robot safety. The source image and evaluation evidence remain visible for review.

## Data records

Everything uses `Repo.kv` in the existing main DynamoDB table:

| Record | Keys |
|---|---|
| Model | `pk=MODEL#<project>#<modelId>`, `sk=META`; `gsi1pk=PROJECT#<project>#MODELS`, `gsi1sk=<createdAt>#<modelId>` |
| Evaluation | `pk=EVALUATION#<project>#<evaluationId>`, `sk=META`; immutable copy in the model partition under `EVALUATION#<createdAt>#<evaluationId>` |
| Gate | Model partition, `sk=GATE#<createdAt>#<gateId>`; model `lastGate` and optional `qualityApproval` updated with a revision condition |

Records include `projectId` and `ownerSubject`. Model/evaluation IDs derive from immutable evidence references so retrying the same registration or ingestion does not multiply records or episode counts. Gate decisions retain the evaluation, exact policy, reasons, actor and timestamp. `qualityApproval` is tied to that exact checkpoint/evaluation/policy; a later threshold preview does not silently rewrite its meaning.

Model pages contain 50 models with a cursor. The output picker considers at most 100 datasets, 10 READY versions per dataset and 100 source versions; truncation is reported. Source checks run in batches of eight. Model detail returns the most recent 100 evaluations and 100 gate entries. Exact older dataset versions/evaluation IDs remain addressable through their APIs.

## Parent integration and remaining boundaries

- Keep `DASHBOARD_ARTIFACT_BUCKET` set. The runtime role needs versioned reads (`s3:GetObjectVersion`) within archive project prefixes and applicable KMS access for encrypted objects. IAM changes remain parent-owned.
- Launch links use:

  ```text
  /workflows/new?template=mujoco-render
    &model_id=<modelId>
    &dataset_name=<pinned-dataset>
    &dataset_version=<pinned-version>
    &checkpoint_bundle=<relative-bundle-directory>
    &episodes=20
    &eval_seed=2042
  ```

  The parent must apply `dataset_version` to the task's actual input version, alongside the template parameter overrides. `model_id` is for navigation/context; ingestion never trusts it as proof that the evaluation used that model. Return navigation can use `/models?model_id=<modelId>`.

- Full-file and multipart composite S3 checksums are distinct. Composite objects retain their actual checksum/type but cannot be used for verified `checkpointDigest` matching without a trusted full-file digest. They are registerable with an explicit unavailable-evaluation reason, not advertised as ready.
- A LeIsaac directory digest is not a single checkpoint file digest. No automatic GPU/LeIsaac launch profile or file/directory equivalence is invented. A verified bundle-digest adapter is needed before those profiles can be quality approved through this service.
- Manifest reads are limited to 8 MiB / 25,000 objects; report JSON to 4 MiB / 10,000 rounds; bundle metadata to 256 KiB. Oversized or malformed evidence fails explicitly.
- No cloud integration test, production S3/IAM access, managed MLflow, Registry mutation, or deployment was performed. Existing AWS legacy browsing only makes read calls when an authorized admin requests it in a configured runtime.

Relevant checksum documentation:
`https://docs.aws.amazon.com/AmazonS3/latest/userguide/tutorial-s3-mpu-additional-checksums.html`
(the documented composite SHA-256 carries the part-count suffix and is not the full-file digest).

## Validation

From `dashboard/web`:

```bash
npm test -- src/server/evaluations
npx tsc --noEmit --incremental false
```

The suite includes real service/API behavior with MemoryKV and a fake versioned object store: project and Origin boundaries, ready publication receipts, manifest/object corruption, snapshot/digest mismatches, same-run task lineage, registration and approval races, duplicate ingestion, multipart checksum behavior, policy review/failure, and admin source isolation. UI render tests cover honest empty/read-only states, actual ingested numbers, default thresholds, and disabled approval before a passing check.

A local browser harness exercised the real page and service with fake data: output registration, evaluation link/query, report ingestion, passing/failing thresholds, explicit approval, mobile width and legacy source errors. Its fixture evidence is clearly labeled and is not seeded into the application.

A fresh offline CPU PPO run also produced actual checkpoint/normalization files and an `evaluation.json`. Those bytes were registered and ingested through fake publication storage/MemoryKV: **2 episodes, 0 successes → review**, with approval correctly refused. This validates the real workload schema without making a cloud or model-quality claim.

Handoff and local test evidence: `/tmp/physical-ai-models-interfaces.md`.
