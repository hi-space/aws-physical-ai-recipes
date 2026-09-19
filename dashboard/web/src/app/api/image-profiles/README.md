# Image/profile preflight — parent integration contract

This is an isolated second-release module. It does not change workflow schema,
compilation, submission, preview, root workflow POST, navigation, IAM, or CDK.
The page is available at `/image-profiles` once these new files are included in
an application release. Importing the modules performs no AWS requests.

## Parent call

```ts
import { imageProfilesService } from '@/server/services/image-profiles';

const result = await imageProfilesService(session).preflight(spec, project);
// spec is the normalized WorkflowSpec; project comes from requestProject().
// The service does not change spec or save any workflow.
// result.resolvedImageDigests[taskName] is a full repository@sha256:... URI.
```

The caller must enforce `result.status === 'blocked'` as a blocker before
submission. `needs-review` is **not** automatic readiness or permission to launch.
The parent decides how to resolve unknown findings, pin each image into its
immutable workflow snapshot, retain profile ID/version and inspection evidence,
and enforce the policy again when appropriate. Core wiring is intentionally
left to the parent/Parfit.
Approval heads and membership are reread after probes; a concurrent withdrawal
or new approval revision removes the affected pin and blocks the result. This
read-only result is still a timestamped observation, not an authorization lease
covering a later submission.

Each task returns `profileId`, `profileVersion`, `image` evidence,
`hardwareCompatibility`, `compatibleNodes`, `driver`, `modelAccess`, and findings
with `code`, `severity`, `message`, and task name. The top-level response includes
`projectId`, `checkedAt`, `resolvedImageDigests`, `tasks`, `findings`, and the
hardware probe evidence when available. Unknown driver/model conditions remain
unknown; there is intentionally no `passed`/`cpu-validated` result.

Only a single matching **latest active approved profile** in the selected project
may authorize an image. Match uses the registered tag URI or its pinned digest
URI. Every preflight re-inspects that reference. Tag drift is blocked until a
new administrator approval. Historical versions remain readable but do not
implicitly authorize new submissions after the approval pointer changes.
Disabling a profile blocks its future use without deleting history.

## HTTP API

All routes use the existing browser session, Origin checks, selected-project
resolution, and fresh membership reads. Services independently authorize direct
calls, and recheck access after slow probes. Profile approval/seed/disable require
a browser platform administrator; project membership alone cannot approve.
Existing `/api/v1` token allowlists are unchanged: these new routes are not
implicitly exposed to API tokens.

| Route | Behavior |
|---|---|
| `GET /api/image-profiles` | Current project, latest profiles, capabilities. No ECR/EC2 probe. |
| `POST /api/image-profiles` | Inspect and approve an immutable revision. Existing profiles require `expectedVersion` for changed content. |
| `GET /api/image-profiles/:id?version=N` | Exact historical revision, or current revision when omitted. |
| `DELETE /api/image-profiles/:id` | Disable future use; keep immutable revisions. |
| `POST /api/image-profiles/seed` with `{}` | Inspect configured builtin image URIs and create **unapproved candidates** only when inspection succeeds. Existing profiles are untouched. |
| `POST /api/image-profiles/preflight` | `{yaml: string}` → read-only compatibility result. YAML/JSON is parsed with the existing parser; no workflow is submitted. Standard request audit records may still be written by the shared route wrapper. |

Approval body:

```json
{
  "id": "training",
  "name": "Approved training image",
  "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/recipes/train:release",
  "expectedVersion": 1,
  "requirements": {
    "minCpu": 4,
    "minMemoryMiB": 32768,
    "minGpu": 1,
    "minGpuMemoryMiB": 16384,
    "platforms": ["g5.8xlarge"]
  }
}
```

Omit `expectedVersion` for a new profile. Requirements are administrator-declared
policy, not measurements. Minimum GPU memory is **per GPU**, not an aggregate
divided by the requested count. `ml.*` HyperPod labels are normalized to EC2
instance type names for catalog lookup. No GFD labels are required.

## Inspection and network boundaries

- Scope is configured `ACCOUNT_ID` and **us-east-1** private ECR only; explicit
  tag or digest required. Other accounts/regions/registries fail with
  `image_mirror_required`; mirror and obtain project approval first.
- `DescribeImages` resolves a tag to its current digest. Registry HTTP manifest
  requests use that digest, not the moving tag.
- Manifest and config bytes are size-bounded and SHA-256 verified. OCI indexes
  and Docker manifest lists inspect supported Linux amd64/arm64 children and
  verify platform/config agreement. Unsupported descriptor platforms are not
  advertised. Index resolution returns the immutable index URI; it does not
  force one child architecture.
- ECR authorization is private to the inspector. It is never returned, stored
  in profiles, logged, or forwarded to S3. Registry requests do not follow
  redirects automatically. Config blobs may follow one credential-free redirect
  to ECR's regional `prod-us-east-1-starport-layer-bucket` on the explicitly
  supported S3 hosts. Other hosts and redirect chains fail closed.
- No container layers are pulled, no image code executes, and no arbitrary
  image-config URL/credential host is fetched. Config contents/environment are
  omitted from returned evidence. Upstream error bodies and signed URLs are
  replaced with sanitized errors.

## IAM/environment requirements — not applied here

The browser/API task role needs:

- Existing DynamoDB get/query/conditional transaction/write access to the
  dashboard table. All registry keys are inside `PROJECT#<projectId>`.
- `ecr:DescribeImages`, `ecr:BatchGetImage`, and `ecr:GetDownloadUrlForLayer` on
  the intended current-account repositories. The latter two support Registry
  HTTP manifest/blob retrieval.
- `ecr:GetAuthorizationToken` on `*`.
- `ec2:DescribeInstanceTypes` on `*`.
- Existing EKS DescribeCluster/authentication plus Kubernetes `get/list nodes`.

Network access must reach the configured private ECR registry/API, the documented
ECR S3 layer bucket, and EKS/EC2 endpoints. Endpoint policies can additionally
restrict those reads. No IAM or network policy is changed by this module.
The controller only needs these permissions if the parent also calls preflight
there; current code adds no controller hook.

`ACCOUNT_ID`, `AWS_REGION=us-east-1`, the existing EKS/table configuration, and
optional builtin image environment URIs are used. Seed recognizes MuJoCo,
Isaac Lab, ROS2, GR00T, OpenPI, Cosmos, Cosmos 3, LeIsaac, workspace and task-runtime image
URIs. Environment presence alone produces no candidate or validation claim.

## Explicit limits

EKS allocatable resources and EC2 type specifications describe compatible
capacity, **not remaining free capacity**. Current workload occupancy, taints,
queue quotas/admission, multi-replica/group placement, runtime-init-image
architecture, CPU instruction-set variants, and EFA compatibility are outside
this focused check. A parent must not infer those properties from a compatible
node name.

EC2 per-device GPU memory is catalog evidence; no operator-supplied measurement
or installed driver version is invented. A missing catalog, absent node
architecture, missing GPU plugin allocation, and unknown memory stay explicit.
There is no operator-hardware-observation fallback in this release. Such a future
contract must record who observed what, where/when, and its non-automatic source.

Tests use injected AWS/HTTP probes and MemoryKV. No AWS account calls, IAM
changes, image publication, workflow execution, or deployment are performed by
the implementation/validation process.

## Authoring validation

The focused suite passed **41 tests across six files**, including two real local
Chromium UI/service tests. Scoped TypeScript checked all 15 new source/test roots
and their dependencies with zero diagnostics. The browser fixture blocks
requests outside its loopback origin and uses memory storage plus fake probes;
this is not live ECR/EKS/EC2 validation. Browser tests explicitly skip when the
local Chromium executable is unavailable.

```sh
npx --no-install vitest run \
  src/server/aws/ecr-inspection.test.ts \
  src/server/aws/hardware-inspection.test.ts \
  src/server/services/image-profiles.test.ts \
  src/app/api/image-profiles/routes.test.ts \
  src/components/pages/ImageProfilesPage.test.ts \
  src/components/pages/ImageProfilesPage.browser.test.ts
```
