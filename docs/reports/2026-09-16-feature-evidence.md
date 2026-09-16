# Physical AI dashboard: feature evidence and acceptance gaps

**The implementation covers substantial workflow, project authorization, storage, session, and recipe behavior, but does not yet satisfy the whole approved design.** All F01–F42 requirements are mapped below. Release 3 adds governed topology planning, routed EKS backend registration, enforced ECR image profiles, browser multipart uploads, and durable project webhooks. These implemented subsets do not establish every topology, backend, registry, model, or hardware capability.

This inventory tracks the implementation worktree against the [approved design](../designs/2026-09-16-physical-ai-dashboard.md), updated during the authorized release-3 integration on 2026-09-16. Source/test links describe implemented contracts; the acceptance table separately identifies measured live results, parent-reported earlier results, and remaining checks. No commit/merge has been made. The [release-3 validation report](2026-09-16-release3-validation.md) and [archived evidence](evidence/2026-09-16-release3/README.md) contain measured results. The coordinator ledger remains at `/tmp/physical-ai-release3-coordinator.md`; the final bootstrap rollout, idempotent setup and browser reconnect are complete and recorded there.

## How to read the status

| Status | Meaning |
|---|---|
| **AWS equivalent** | The specified behavior has a concrete AWS-oriented implementation and relevant test assertions. This does not imply OSMO API/protocol compatibility or live acceptance. |
| **Partial** | A useful subset exists, but an identifiable software, integration, or coverage gap remains. |
| **Conditional adapter** | Real workload entry points exist; essential image, model, data, or hardware prerequisites and execution evidence remain outstanding. |
| **Unsupported** | The requested execution capability is absent or explicitly rejected. Metadata, infrastructure permissions, and configuration names do not count as implementation. |

**A source status is not a blanket live pass.** Only explicitly identified acceptance paths below have execution evidence. An unknown driver/model-access condition remains unknown even when image inspection succeeds.

## F01–F09: submission and execution semantics

| ID | Design feature | Status | Current implementation and test evidence | Remaining gap / acceptance condition |
|---|---|---|---|---|
| F01 | Submit, search, inspect, and revisit workflows | **AWS equivalent; acceptance coverage partial** | [Workflow API][workflow-api], [submission][submission], and [repository][repo] persist spec/parameters and idempotent run IDs. Project-index listing scans history for requested filters; revision, clone, retry and pagination regressions cover the current implementation. | Live CPU run identity/publication is verified below. Full browser history/filter and historical revision recovery remain separate acceptance cases. |
| F02 | YAML/JSON, parameterized templates, validation | **AWS equivalent; scoped readiness** | [Parser][template], [schema][schema], and [validation API][validate-api] generate task/JobSet previews using indexed dataset inputs. [Profile binding][profile-binding] inspects/pins approved images; [topology preview tests][topology-preview-tests] cover ephemeral registered placement plans. | Image/capacity inspection is timestamped and does not reserve hardware. Driver/model access remains unknown unless independently evidenced. Unsupported hierarchy levels fail explicitly. |
| F03 | Apps/recipes: create, share, versions, defaults | **AWS equivalent** | [Template API contract][template-api-readme], [revision storage][repo], and [workflow draft UI][draft-ui] support project sharing, immutable revisions, optimistic saves, archive/history, and selected-version submission. [Revision tests][revision-tests], [template API tests][template-api-tests], and [draft tests][draft-tests] cover ownership, concurrent saves, restoration, and `templateVersion`. | Sharing is through project membership, not an OSMO-compatible Apps service or public catalog. Validate historical revision → edited draft → submitted spec/hash → retry across the real store and browser. |
| F04 | Serial, parallel, and composite DAGs | **AWS equivalent** | [Execution controller][execution] evaluates dependencies, branches, joins, skipped descendants, and independent units. [Output finalization][workflow-artifacts] commits publication receipts before downstream success. [Controller tests][controller-tests] and [reliability tests][reliability-tests] exercise DAG progress and failure/recovery. | Demonstrate a real fan-out/fan-in run whose join reads the intended attempt outputs, including one failed branch. A DAG diagram alone is not execution evidence. |
| F05 | Groups, leader, `ignoreNonleadStatus` | **AWS equivalent** | [Group compiler][groups] creates one JobSet admission root; [runtime broker][broker] and [execution][execution] preserve raw outcomes and coordinate leader completion. [Group tests][group-tests] and the native-group cases in [reliability tests][reliability-tests] cover nonleader failure, cleanup, fencing, and group retries. | Independent nonleader rescheduling with `ignoreNonleadStatus: true` is explicitly unsupported. Whole-group retries use the controller. Verify actual JobSet/Kueue behavior rather than assuming CRD installation proves admission semantics. |
| F06 | Initialization/start barrier | **AWS equivalent** | [Compiler init containers][compile] prepare storage, install the runtime, and hydrate dataset inputs before the workload runtime starts. [Broker barrier logic][broker] releases participants; [Go runtime][go-runtime] waits before launching user code. [Broker tests][broker-tests], [runtime tests][go-runtime-tests], and [input tests][go-input-tests] cover readiness, fencing, and hydration. | Exercise a deliberately slow image/input participant on the real cluster and prove no peer starts application work early. Cluster policy, DNS, runtime reachability, and FSx permissions remain prerequisites. |
| F07 | Separate queue/start/exec deadlines per group | **AWS equivalent** | [Execution][execution] tracks transition timestamps and separates admission, initialization, execution, and cleanup. [Reliability tests][reliability-tests] cover start timeout, branch/group budgets, and surviving independent siblings. | Verify observed admission timestamps and delayed cleanup under real Kueue/JobSet events. These are controller semantics, not a claim that native OSMO scheduling clocks are identical. |
| F08 | Exit actions, reschedule, retry | **AWS equivalent** | [Schema][schema], [runtime outcomes][runtime-outcome], and [execution][execution] use raw application exits, bounded backoff, unique attempt paths, and confirmed old-Pod removal. [Integration regressions][integration-tests] distinguish application exit 125 from wrapper failure and application zero from normalized RESCHEDULE; [reliability tests][reliability-tests] cover retry recovery. | Validate an actual eviction/preemption and restart. User exit policy must never normalize infrastructure or publication failure into success. Retry budget defaults are not automatic recovery guarantees. |
| F09 | Periodic/final checkpoints and consistent resume | **Partial** | [Go checkpoint publisher][go-checkpoint], [broker upload service][runtime-uploads], and [restore implementation][restore] bind committed manifests to retry attempts. MuJoCo recipes declare durable checkpoint paths; [live recovery test][recovery-e2e] verifies optimizer and normalization restoration across RESCHEDULE. | Runtime checkpoint publication remains single-PUT: **5 GiB/file and 1,024 files**. Browser multipart does not remove this limit. Actual RESCHEDULE recovery passed: durable attempt1 bundle restored optimizer/normalization in attempt2 and advanced128→192 timesteps. Simulator trajectories/RNG restoration are not universally bit-identical. |

## F10–F18: compute, storage, and private access

| ID | Design feature | Status | Current implementation and test evidence | Remaining gap / acceptance condition |
|---|---|---|---|---|
| F10 | CPU/GPU/memory/storage/platform profiles and readiness | **AWS equivalent for approved ECR profiles; conditional hardware** | [Image profiles][image-profiles], [inspection tests][image-profile-tests], and [binding][profile-binding] resolve private current-account/us-east-1 ECR tags to digest/architecture and compare requirements with observed Nodes and EC2 instance types. Source/probe timestamps and per-task findings are retained. | Driver, model/asset access and runtime health are explicitly unknown without proof. Trusted administrator observations are declared input, not automatic discovery. Seven builtin image inspections/approvals passed; this does not validate every recipe on that image. |
| F11 | Node exclusion and topology placement | **AWS equivalent for the registered hierarchy** | [Native planner][topology-planner], [inventory][topology-inventory], [production adapter][production-topology], and [execution][execution] bind plans to admission units, enforce selectors/exclusion, persist plans and verify observed placement. [Planner tests][topology-tests] and [adapter tests][production-topology-tests] cover capacity and registration boundaries. | Actual default registration is zone-id → hostname. Required-zone execution passed on two real CPU Nodes, including actual Pod node names and live zone-label comparison. The unserved API version and HyperPod child Job/Pod queue-label defects were corrected and deployed. Other racks/network hierarchies and other backends remain unvalidated. |
| F12 | Priority, quotas, borrowing, preemption | **AWS equivalent** | [Queue API][queues-api], [Kueue adapter][kueue], [HyperPod API adapter][hyperpod], and [compiler][compile] use existing queues and AWS quota/scheduler APIs. Project submissions force the server queue. [Boundary tests][boundary-tests] verify queue/CQ/flavor visibility; [reliability tests][reliability-tests] cover waiting and retry states. | HyperPod/Kueue policies are the supported equivalent; NVIDIA LOW/HIGH/NORMAL borrowing decisions and KAI scheduling are not replicated. Verify actual quota denial, borrowing, priority admission, and preemption recovery with the installed policy. |
| F13 | Multiple execution backends/pools | **Conditional AWS equivalent for allowlisted EKS targets** | [Backend registry/routing][backends], [routing tests][backend-tests], and request/worker contexts select backend-specific Kubernetes, runtime, session and storage configuration; project bindings and immutable workflow backend identity are enforced. Backend UI retains the default and all allowlist entries. | Supported scope is current account, us-east-1 and the home VPC with validated EKS/FSx/runtime capabilities. Only the default backend is currently configured/live-tested; no extra target was provisioned or validated. Slurm execution, cross-account/region and arbitrary schedulers remain unsupported. |
| F14 | Data inputs/outputs, filtering, transfer progress | **Partial** | [Dataset service][datasets], [S3 snapshot publication][snapshots], [FSx output adapter][artifact-adapter], and [runtime inputs][runtime-inputs] connect versioned S3 evidence to FSx workspaces. [Dataset tests][dataset-tests], [snapshot tests][snapshot-tests], and [input tests][go-input-tests] cover missing uploads, immutable snapshots, and hydration. | No general EFS workspace adapter, arbitrary storage connector, or native dataset include/exclude filter translation was located. Runtime hydration currently limits a manifest to 1,024 objects. Large-prefix acceptance must be reconciled with consumer limits. Transfer progress is not resumable multipart support. |
| F15 | Dataset versions, tags, browsing, lineage | **Partial** | [Dataset service][datasets], [repository][repo], and [snapshot code][snapshots] reserve versions, pin VersionId/checksum manifests, set tags, and prevent post-commit upload mutation. [Dataset tests][dataset-tests], [store reliability tests][store-tests], and [integration regressions][integration-tests] cover concurrent versions, finalization, and distinct v1/v2 bindings. | Full-history deletion protection is not established: `lineage()` searches a bounded workflow list. Browsing/current-object APIs are not all version-pinned download APIs. Demonstrate that old runs remain reproducible after later versions and that referenced data cannot be removed through every supported management path. |
| F16 | Local/inline file injection and browser uploads | **AWS equivalent for bounded uploads** | [Compiler][compile] validates inline paths; [multipart service][multipart], [multipart tests][multipart-tests], and [browser test][multipart-e2e] implement initiate/part/complete/abort/resume with project ownership, checksums and immutable-version fences. | Parent-reported actual 16 MiB + 17 B three-part upload, resume, CORS and full SHA verification passed. ConfigMap size limits, runtime checkpoint multipart and ranged CLI sync remain separate limits. |
| F17 | Private credentials and private image registries | **AWS equivalent for SSM secrets and private ECR; other registries unsupported** | [Credentials][credentials] store values in SSM SecureString and inject authorized Kubernetes Secret references. [Image inspection/profile service][image-profiles] supports current-account/us-east-1 private ECR and never returns registry auth tokens. Actual CPU/GPU pulls use approved digest references. | Non-ECR/unapproved images require an approved mirror; no arbitrary credential-host fetch or general imagePullSecrets configuration is promised. HF/NGC model access is separate from private container pull authentication. |
| F18 | Administrator-approved host mounts/network/privilege | **Partial: researcher rejection exists** | [Strict schema][schema], [submission][submission], and [storage layout][storage-layout] reject project host volumes and enforce non-root workloads. Trusted storage preparation is a fixed initializer. [Schema tests][schema-tests] and [reliability tests][reliability-tests] cover mount/privilege boundary rejection. | There is no versioned administrator profile for arbitrary privileged/hostNetwork/host-mount workloads. Legacy projectless X11 mount handling is not that feature and must not be advertised as a researcher capability. A separate trusted execution boundary is still needed for such recipes. |

## F19–F28: observability, sessions, and operational interfaces

| ID | Design feature | Status | Current implementation and test evidence | Remaining gap / acceptance condition |
|---|---|---|---|---|
| F19 | Logs/errors/events, streaming and reconnect | **Partial** | [Task log API][logs-api] selects JobSet attempt/member Pods and initialization logs; [events][events-api], [resources][k8s-resources], and [LogViewer][log-viewer] provide diagnostics, SSE reconnect and CloudWatch fallback. | Durable cursor-based lossless replay and full watch/410 recovery remain absent. Event polling and tail overlap do not prove no-loss replay; quiet-stream and reconnect acceptance remains separate. |
| F20 | Task status, failures, pending reasons, retry history | **AWS equivalent** | [Status derivation][status], [execution][execution], [runtime outcomes][runtime-outcome], and [dispatch reconciliation][dispatch] preserve actual failure/cleanup/finalization states. [Controller tests][controller-tests], [reliability tests][reliability-tests], and [dispatch tests][dispatch-tests] exercise transport failures, stale state, and unsuccessful outer executions. | Verify user-visible diagnostics against actual unschedulable/image/hydration failures. A live upstream outage must remain distinguishable from an empty result or real task failure across all views. |
| F21 | Cancel and bulk cancel | **AWS equivalent** | [Cancel API][cancel-api], [bulk cancel API][bulk-cancel], [execution][execution], and [worker][worker] persist intent and reconcile workload/session cleanup. [Pipeline service][pipelines] separately stops the configured SageMaker pipeline. [Reliability tests][reliability-tests] cover surviving Pods/delete errors; [dispatch tests][dispatch-tests] cover timeout reconciliation; [pipeline tests][pipeline-tests] cover stop authorization. | Demonstrate external SFN timeout/abort with no surviving owned GPU work or sessions. SageMaker cancellation is a separate service path, not a generic DAG backend. Confirm actual asynchronous child termination, not only an accepted stop response. |
| F22 | Browser terminal/exec | **AWS equivalent** | [Gateway terminal][terminal], [Kubernetes transport][gateway-k8s], and [session service][sessions] bind a terminal to the owner, project, Pod UID, and current attempt. [Terminal tests][terminal-tests] cover input/resize/stdout/status/disconnect; [gateway auth tests][gateway-auth-tests] cover target/identity checks. | Requires installed browser assets, actual EKS exec protocol/RBAC, and an accessible current Pod. Reconnect after rescheduling and session revocation need live evidence. |
| F23 | Port-forward and isolated remote apps | **AWS equivalent** | [Gateway server][gateway-server], [session service][sessions], and [workspace image][workspace-readme] provide isolated-host HTTP/WebSocket forwarding, Jupyter, code-server, TensorBoard, and declared task ports. [Gateway server tests][gateway-server-tests], [session lifecycle tests][session-tests], and [workspace tests][workspace-tests] cover boundaries and lifecycle. | This is registered-port HTTP/WebSocket access, not a general network tunnel or Ray cluster manager. Validate real app cookies/assets/WebSockets, ALB routing, session expiration, and FSx permissions. Persistent workspace storage uses FSx, not an EFS Access Point implementation. |
| F24 | File upload/download and synchronization | **Partial AWS-oriented equivalent** | [Go file service][go-files], its [runtime browser UI][files-ui], and [CLI][cli] offer streamed reads/writes, staged commit, checksums for watch comparison, and session-bound access. [File tests][go-files-tests] and [CLI tests][cli-tests] cover unsafe paths, interrupted writes, byte counts, and no remote deletion. | This is not an rsync wire protocol or block-delta algorithm. No ranged/resumable transfer or remote-delete API is implemented. Interrupted transfers retry the file. File access exists while the task runtime is active; archives use separate APIs. |
| F25 | Resources, pool usage, graphs, honest empty states | **Partial** | [Scoped metric builders][metrics], [metrics API][metrics-api], [queue API][queues-api], and [workflow metrics API][workflow-metrics] derive project selectors and include JobSet attempt names. [Boundary tests][boundary-tests] cover namespace/queue restrictions; [overview UI tests][overview-tests] cover presentation states. | Real AMP/DCGM label compatibility and measurements remain unverified here. Shared-cluster [overview aggregates][overview] are not project accounting. Workflow metrics error visibility and naming changes are source evidence; dedicated real-series/zero-GPU checks still belong in acceptance. |
| F26 | Roles, project policy, service/API tokens | **AWS equivalent** | [Proxy][proxy], [ALB JWT validation][alb-jwt], [projects][projects], and [API tokens][api-tokens] bind verified subjects, current membership, scope, expiry, and revocation. [Token tests][token-tests], [JWT tests][jwt-tests], [boundary tests][boundary-tests], and [token lifetime tests][token-lifetime-tests] cover scope and live-connection revocation using fixtures. | Tokens intentionally expose a finite endpoint allowlist and never delegate platform-admin authority. Verify real Cognito login/logout, disabled users, role changes, ALB headers, IAM, and existing gateway connections after revocation. Do not generalize this to every API or an external identity-provider integration. |
| F27 | Versioned admin profiles, pod/group templates, validation | **Partial AWS equivalent** | [Immutable image-profile revisions][image-profiles], [profile API contract][image-profile-api], [schema][schema], [preview][validate-api], and [recipe revisions][template-api-readme] enforce approved image requirements, CAS administration and per-task digest pins. | Image profiles are not arbitrary privileged Pod/hostNetwork/host-mount templates. Native topology requires actual backend registration; readiness warnings are not proof of driver/model compatibility. |
| F28 | Distributed torchrun/DeepSpeed/Ray/EFA | **Partial: real Torch/Gloo recipe on JobSet** | [Group compiler][groups], runtime barrier/DNS, and [two-node Torch/Gloo E2E][distributed-e2e] support indexed CPU replicas with actual collectives, optimizer updates and READY checkpoint verification. EFA requests can be compiled. | Actual two-node CPU Torch/Gloo collectives and trained-weight publication passed, including the native required-zone placement check. No dedicated Ray/PyTorchJob/MPIJob/DeepSpeed operator adapter, measured EFA/NCCL path or general distributed worker-loss recovery is established. Generic command support is narrower than those adapters. |

## F29–F39: workloads, experiments, models, and hardware

| ID | Design feature | Status | Current implementation and test evidence | Remaining gap / acceptance condition |
|---|---|---|---|---|
| F29 | MuJoCo and Isaac Lab RL | **Measured CPU and SO-101 GPU paths; other tasks conditional** | [MuJoCo training][mujoco-train] and [evaluation][mujoco-eval] use real workshop physics/SB3 PPO with paired checkpoint statistics. [MuJoCo test code][mujoco-tests] trains, resumes, compares bundles, and renders video. [Isaac Lab adapter][isaac-train] uses RSL-RL; [catalog tests][catalog-tests] validate Reach/Lift/H1 recipe structure. | Actual MuJoCo CPU learning/evaluation and Isaac SO-101 GPU PPO/checkpoint/replay passed. Isaac evidence includes changed weights, optimizer steps and decoded nonblank1280×720 video. This is functional learning/rendering evidence, not a task-quality threshold, H1/Lift acceptance, or universal GPU/asset compatibility. Resume does not promise bit-identical simulator trajectories. |
| F30 | GR00T fine-tuning and SageMaker pipeline | **Partial** | [Project pipeline service][pipelines] records idempotent intents, scopes executions/training jobs, and stops executions; [pipeline tests][pipeline-tests] cover recovery and authorization. The [existing pipeline definition][sm-pipeline] contains transform/train/smoke/register steps. A separate [GR00T EKS adapter][groot-train] invokes the pinned official training module. | A configured/upserted pipeline, model/data access, training image, IAM, quota/capacity, and actual quick-run outputs remain prerequisites. Pipeline invocation/indexing does not itself ingest SageMaker artifacts into the new project model/evaluation registry. Smoke gate success is not robot task-quality approval. |
| F31 | π0/OpenPI training | **Conditional adapter** | [OpenPI adapter][openpi-train] calls actual normalization/training scripts and handles output/resume paths; [Dockerfile][openpi-image] and [catalog][catalog] define the image/LoRA workflow. [Catalog tests][catalog-tests] compile the recipe. | No OpenPI learning/GPU execution test was located. Requires built image, compatible JAX/CUDA stack, LIBERO-format data, base-weight access, and a measured memory profile. SO-101 compatibility is explicitly not established. Do not count the older placeholder example as evidence. |
| F32 | Isaac Sim synthetic data | **Conditional adapter** | [Replicator adapter][sdg] opens a USD scene, seeds camera randomization, writes RGB/depth/semantic outputs, and rejects incomplete modalities. [Isaac image][isaac-image] and [catalog tests][catalog-tests] provide image/manifest structure evidence. | Requires simulator/GPU/driver compatibility, camera-enabled execution, USD assets/license access, and actual generated frames plus manifest verification. Catalog compilation does not establish sensor correctness. |
| F33 | Mimic, Cosmos, LeRobot/data conversion | **Partial / conditional adapters** | [HF import/conversion][hf-import] validates converted episodes; [conversion tests][import-tests] exercise the real converter and missing-data failure. [Mimic][mimic] invokes official annotation/generation; [Cosmos][cosmos] invokes inference and checks videos. [Catalog tests][catalog-tests] cover pipeline structure. | Mimic needs suitable demonstration data and simulator assets. Cosmos requires authorized weights, a declared high-memory GPU profile, and separate image provisioning. GPU paths have no dedicated execution proof here. Visual augmentation produces videos, not inferred robot actions or success labels. |
| F34 | Real closed-loop evaluation | **Partial / conditional GPU path** | [MuJoCo evaluation][mujoco-eval] measures seeded rollouts; [LeIsaac evaluation][leisaac] uses actual observations/policy actions and explicit success termination, writing per-round JSON/video/digests. [MuJoCo tests][mujoco-tests], [report tests][report-tests], and [catalog tests][catalog-tests] cover CPU behavior/report contracts/group wiring. | The measured MuJoCo two-episode evaluation produced verified reports/video and a REVIEW gate. LeIsaac still needs a compatible policy, scene revision, provisioned assets, concurrent GPU allocations, and networking. Its directory checkpoint digest is not automatically equivalent to the file-digest contract in model ingestion. No physical robot performance follows from simulator or smoke results. |
| F35 | DCV visualization tied to actual execution | **Partial** | [DCV service][dcv], [bootstrap][dcv-bootstrap], and [SSM tunnel][dcv-tunnel] implement registered-host authentication and certificate-checked transport. [Verifier tests][dcv-tests], [activation guards][dcv-activation-tests], and [gateway DCV tests][gateway-dcv-tests] cover token/TLS and idle-console activation. Actual browser HTTPS, increased console connection count and visible canvas passed after OS CA trust and service activation fixes. | The implemented browser path is **admin-only access to one imported workstation/console**. It does not map each workload’s actual Pod node to a separately owned DCV session. Headless Isaac video replay is a distinct supported recipe, not proof of node-bound interactive rendering. |
| F36 | ROS 2 and HIL | **Partial** | [ROS transfer recipe][ros-transfer] implements discovery/publisher/subscriber payload transfer; [ROS test code][ros-tests] uses separate local containers. [Device service][devices] implements exclusive, expiring, epoch-bound leases. [Device API tests][device-tests] and [edge tests][edge-tests] cover lease/virtual receiver fencing. | Actual Kubernetes discovery and data traffic passed:20 unique run-tagged messages from the publisher reached the subscriber and were archived as READY bytes. A lease authorizes scheduling, not motion. A physical device receiver that enforces the current lease/epoch and actual Jetson/robot integration remain external work. The virtual harness is communication-only. |
| F37 | Edge deployment, rollback, benchmark/inference | **Partial / conditional hardware path** | [Device service][devices], [Greengrass adapter][greengrass], and [edge runtime][edge-runtime] implement pinned model/component plans, explicit submit, reconciliation/readiness receipts, rollback, real inference entry points, and measured/imported benchmark distinctions. [Edge API tests][edge-api-tests], [benchmark tests][benchmark-tests], and [edge tests][edge-tests] cover fixtures and local contracts. | Requires registered/provisioned cores, token-exchange/IAM setup, published component ZIP/recipes, Docker/ECR access, and compatible images. GPU/Jetson execution and TensorRT acceleration are not established. Imported metrics remain unverified identity evidence; benchmark probes do not prove task success. |
| F38 | Experiment comparison and model lineage | **Partial** | [Tracking proxy][tracking-proxy], [project tracking access][tracking-access], [comparison helpers][compare], and [model service][models] connect task metrics, experiment authorization, and dataset/run/checkpoint evidence. [Tracking tests][tracking-tests], [MLflow access tests][tracking-access-tests], [comparison tests][compare-tests], and [model tests][model-tests] cover these boundaries. | Demonstrate two actual runs on the same axes with missing values preserved. SageMaker pipeline → project model archive and non-MuJoCo bundle lineage are not automatically complete. Release-3 runs retain inspected ECR digests; this does not upgrade historical unpinned runs into observed evidence. |
| F39 | Model promotion and quality gates | **Partial AWS-oriented equivalent** | [Promotion policy][promotion] distinguishes smoke, benchmark, simulation, and hardware evidence; [model service][models] requires verified publications and explicit approval. [Policy tests][promotion-tests], [model tests][model-tests], and [report tests][report-tests] cover corruption, insufficient evidence, concurrent writes, and threshold decisions. | The actual two-episode result correctly remained REVIEW with approved=false. Approval is an application record in DynamoDB; no SageMaker `ModelApprovalStatus` update is implemented. Automatic evaluation-launch compatibility is strongest for verified MuJoCo bundles; composite-only/full-file checksum and GPU directory-digest gaps are explicitly gated. No hardware safety certification is implied. |

## F40–F42: reproducibility, cost, and automation

| ID | Design feature | Status | Current implementation and test evidence | Remaining gap / acceptance condition |
|---|---|---|---|---|
| F40 | Source/image reproducibility and builds | **Partial AWS equivalent** | [CDK workload images][workload-images], [provenance][provenance], immutable recipe revisions, [profile binding][profile-binding] and [submission][submission] pin inspected digest identities into saved workflow specs. [Build service][builds] allowlists CodeBuild operations. | Seven image approvals and real digest-pinned CPU/GPU pulls are evidenced. General researcher source builds, every source dependency resolved/recorded, missing Cosmos/LeIsaac image wiring, and full CodeBuild acceptance remain gaps. Legacy runs do not retroactively acquire observed image proof. |
| F41 | Usage/cost estimates and idle management | **Partial** | [Cost adapter][cost] reads service-level billing data; [session service][sessions] enforces expiry/extension/cleanup; [HyperPod scaling][hyperpod] preserves non-target group fields. [Session tests][session-tests] cover TTL/cleanup; [HyperPod tests][hyperpod-tests] cover scale-spec construction. | No project/run GPU-hour estimator with price timestamp or utilization-based idle shutdown was located. The scale path does not check active workloads, sessions, finalization, or another actor’s baseline changes before reducing capacity. Billing aggregates and session TTL do not satisfy those requirements. |
| F42 | REST, CLI, external automation, webhooks/MCP | **Partial AWS equivalent: REST/CLI plus durable webhooks** | [Token proxy][proxy], [CLI][cli], [webhook service][webhooks], [delivery worker][webhook-worker] and [tests][webhook-tests] implement project-admin subscriptions, safe viewer metadata, SSM SecureString configuration, stable events, HMAC timestamps, durable leases/retries/dead letters and DNS-pinned HTTPS delivery. Parent wired workflow completion and worker reconciliation. | At-least-once delivery requires receiver event-ID deduplication. Only local/fake delivery tests ran; no real recipient or external message was configured/sent. MCP server, complete OSMO API parity and lossless CLI log cursors remain unsupported. |

## Image and hardware readiness must remain explicit

The following distinguish source contracts from measured readiness. Seven deployed builtin image manifests/architectures were inspected and approved; only the identified live runs prove execution. [WorkloadImages][workload-images] stages the default workload assets for Linux AMD64. Go runtime/edge architecture support does not make every workload image multi-architecture.

| Family | Current CDK/image wiring | Required evidence or external condition |
|---|---|---|
| MuJoCo | Default `MUJOCO_IMAGE_URI`; [Dockerfile][mujoco-image], real CPU [integration test][mujoco-tests]. | Built image identity; actual train → paired checkpoint → independent seeded evaluation → published JSON/video. Do not infer a learned success threshold from a short functional test. |
| Isaac Lab / H1 / Replicator / Mimic | Default `ISAACLAB_IMAGE_URI`; [Dockerfile][isaac-image]. | NVIDIA terms and assets, compatible GPU/driver/VRAM, writable caches, task-specific data/scene access, observed training/rendering. The shared `ml.g5.8xlarge` recipe default is not a validated profile for every task. |
| GR00T EKS | `GROOT_RUNTIME_IMAGE_URI` only with extended images; [Dockerfile][groot-image]. SageMaker has its own imported training-image/pipeline path. | Authorized base weights, camera/action/embodiment-compatible dataset, sufficient memory, actual optimizer/loss/checkpoint behavior. Distinguish EKS adapter evidence from SageMaker pipeline evidence. |
| OpenPI | `OPENPI_IMAGE_URI` only with extended images; [Dockerfile][openpi-image]. | JAX/CUDA compatibility, base-weight access, LIBERO/LeRobot data and normalization, measured LoRA memory needs. No established SO-101 adapter. |
| Cosmos | [Dockerfile][cosmos-image] exists; `COSMOS_IMAGE_URI` is **not provisioned by the current image construct**, including its extended switch. | Recipe declares an 80 GB-class GPU profile and authorized model weights. Independently verify that requirement and provision a suitable image/instance; do not assume the default smaller GPU profile suffices. |
| LeIsaac closed loop | [Dockerfile][leisaac-image] exists; `LEISAAC_IMAGE_URI` is **not provisioned by the current image construct**. | Explicit Isaac recipe/asset image inputs, scene revision and matching robot assets; compatible GR00T policy; concurrent GPU allocations and policy-server connectivity. Close the directory-versus-file digest integration gap. |
| ROS 2 | Default `ROS2_IMAGE_URI`; [Dockerfile][ros-image] and [container test][ros-tests]. | Actual discovery and payload delivery through installed cluster networking; host-mount/network privileges are not implicitly enabled. |
| Workspace / edge | Separate [workspace image][workspace-readme] and [edge recipe rendering][edge-recipes]. | Workspace CNI/FSx/RBAC validation; independently published edge components and digest-pinned images for the registered architecture. Device health is not hardware-validation evidence. |

## Important boundaries that must not be collapsed into “supported”

1. **Topology and backends:** real registered planning and backend routing now exist, but their evidence is limited to the configured default EKS target and observed zone/hostname hierarchy. They do not establish arbitrary cross-cloud backends or framework operators.
2. **Private access:** subject-bound private credentials, API tokens, and gateway grants are implemented concepts with tests. General private container-registry pull authentication is a separate unfinished capability. Secrets Manager runtime/DCV secrets do not establish a generic Secrets Manager workload-reference API.
3. **Multipart:** browser multipart is integrated and has parent-reported actual resume/checksum evidence. Server-side snapshot multipart copy, runtime checkpoint upload and CLI synchronization are different contracts; runtime checkpoints over 5 GiB/file and ranged CLI resume remain unsupported.
4. **Large datasets:** snapshot publication and model-manifest readers have different limits from runtime input hydration. A successfully published dataset is not automatically consumable by the runtime’s 1,024-object input-plan contract. Align admission, publication, and consumer limits or implement pagination before promising large datasets.
5. **Checkpoint semantics:** local periodic saves, durable S3 publication, and automatic retry restore are three separate steps. The generic runtime does not infer model-specific restart parameters. A final output snapshot does not prove periodic durability.
6. **Evaluation semantics:** shape/finite-value smoke checks, inference microbenchmarks, simulated task success, and physical task success are different evidence classes. Application quality approval is not SageMaker Registry approval, and neither is robot safety approval.
7. **UI/API parity:** preview now uses indexed dataset bindings and registered native placement plans; logs select JobSet members and init-container diagnostics. These source corrections still need user-path acceptance beyond unit fixtures.

## Acceptance priorities

These are work priorities, not authorization to run deployments or hardware.

| Priority | Work to complete or explicitly de-scope | Feature impact |
|---|---|---|
| **1 — coherent first researcher path** | Retain the completed bounded CPU/model/distributed/checkpoint/DCV/GPU replay/ROS proofs and align publication/consumer limits. Browser multipart is integrated; large runtime checkpoints remain a distinct gap. | F01–F02, F09, F14–F16, F19 |
| **1 — truthful execution prerequisites** | Retain enforced ECR profile/digest inspection and unknown driver/model findings; supply missing Cosmos/LeIsaac wiring or keep those recipes unavailable. Do not generalize one image approval into all workload/hardware readiness. | F10, F17, F27, F29–F34, F40 |
| **1 — safe operational acceptance** | Add active-work/session/finalization and external-baseline protection before claiming safe scale-down/idle management. Validate real cancellation and source-token/session revocation with owned resources. | F21, F26, F41 |
| **2 — remaining software equivalence** | Validate configured routing/topology and owned webhook delivery separately; explicitly retain gaps for additional backends, framework operators, privileged profiles, EFS/connectors, durable replay, MCP and Registry promotion. | F11, F13–F14, F18–F19, F27–F28, F39, F42 |
| **2 — reproducibility and quality integration** | Preserve enforced image digest pins and recipe revisions; connect SageMaker outputs to project lineage, complete non-MuJoCo bundle/digest adapters, and retain exact evaluation/promotion evidence. | F03, F30, F34, F38–F40 |
| **3 — external workloads/hardware** | Provision permitted model/asset access and task-specific GPU profiles; measure GPU training, closed-loop simulation, distributed recovery, ROS networking, and separately registered Jetson/physical receivers. Hardware availability alone does not close missing software adapters. | F28–F37 |

## Live acceptance evidence — release 3

Account `913524902871`, region `us-east-1`, project `workshop`, default EKS backend. Core corrected release deployment reached CloudFormation `UPDATE_COMPLETE`; the final bootstrap correction is UPDATE_COMPLETE, and actual idempotent setup plus reconnect passed as recorded in the [release report](2026-09-16-release3-validation.md). Source verification: **843 web tests passed /1 existing skip**, all web/infra/E2E typechecks and web/service builds passed; later bootstrap/session checks passed115 tests plus5 Python activation/verifier tests. These results cover the stated paths, not every F01–F42 condition.

| Path | Measured result | Evidence / limit |
|---|---|---|
| Seven builtin image profiles | Actual PASS: CAS update to deployed tags, ECR digest and AMD64 inspection. | [Log](evidence/2026-09-16-release3/image-profiles.log). Driver/model/asset readiness remains separate. |
| CPU exit policy + S3 publication | Actual PASS `839dd756b2c1c0dc`: raw exit7/wrapper0, READY artifact bytes/receipt/hash. | [Log](evidence/2026-09-16-release3/cpu-producer.log). Initial combined-suite login failure created no producer run; standalone retry passed. |
| Uploaded data + hydration | Actual PASS `5b740b38400aab04`: PENDING→READY input, pinned manifest and exact hydrated/published bytes. | [Log](evidence/2026-09-16-release3/cpu-hydration.log). Large object/manifest limits remain. |
| Model/evaluation/quality decision | Actual PASS `5485ff71b84843ee`; model `mdl-0af861652331e0c454117246`, evaluation `eval-db22b906429d89b8c29d2fb9`. | [Proof](evidence/2026-09-16-release3/model-pipeline-proof.json). **Two episodes, REVIEW, approved=false**.20-episode rendering exceeded the12-minute budget; no20-episode quality acceptance. |
| Checkpoint recovery | Actual PASS `b67546d015a31556`: RESCHEDULE1→2, restored optimizer/normalization,128→192 timesteps and READY proof. | [Log](evidence/2026-09-16-release3/checkpoint-recovery.log), [receipt](evidence/2026-09-16-release3/checkpoint-task.json). Not an actual infrastructure eviction test; files>5GiB remain unsupported. |
| Native topology + distributed training | Actual PASS `9177abf23b152804`: two CPU Pod node names, required use1-az4 label match, real Gloo collectives/updates and matching READY weights. | [Log](evidence/2026-09-16-release3/distributed.log), [persisted plan/receipt](evidence/2026-09-16-release3/distributed-task.json). Only the default registered zone/hostname hierarchy. |
| Isaac GPU training + video | Actual PASS train `5084f1435140580b`, replay `b8c30447d3efcd03`: real CUDA, optimizer/weight changes, verified checkpoints and pinned replay. | [Proof](evidence/2026-09-16-release3/isaaclab-proof.json):1.92s,1280×720,398 sampled colors. Existing single A10G node; no capacity change. |
| ROS2 communication | Actual PASS `05839fe0398ce352`: discovery,20 distinct run-scoped messages and READY subscriber artifact. | [Log](evidence/2026-09-16-release3/ros2.log), [receipt](evidence/2026-09-16-release3/ros2-task.json). Communication only; no robot motion/HIL hardware claim. |
| DCV browser | Actual PASS: verified HTTPS, console connection-count increase and visible canvas after one authorized idle-console service activation. | [Log](evidence/2026-09-16-release3/dcv-browser.log), [host audit](evidence/2026-09-16-release3/dcv-host-audit.json). No VM restart/stop; current desktop/Python processes predate activation. Full before/after PID equality was not emitted by the initial probe. |
| Tokens, multipart, terminal/files | Parent-reported release2 actual PASS: token project/role/scope/revocation,16MiB+17B multipart CORS/resume/SHA, own terminal/file sessions and cleanup. | Supplied parent evidence and current test sources; not represented as fresh coordinator reruns. |
| SageMaker GR00T | Parent-reported actual small-G5 optimizer OOM; two later capacity waits were stopped at their bounded budgets. | No successful GR00T training or approval. Final terminal-state audit is in the release report. |
| Other backends/models/devices/webhooks | Source/local-test evidence only unless listed above. | No extra backend, OpenPI/LeIsaac/Cosmos/Mimic/SDG/physical-device acceptance or real outbound webhook message claimed. |

## Evidence links

Paths below are relative to this report. References point to the current worktree; the parent should pin a commit when accepting a final evidence set.

[workflow-api]: ../../dashboard/web/src/app/api/workflows/route.ts
[submission]: ../../dashboard/web/src/server/workflow/submission.ts
[repo]: ../../dashboard/web/src/server/store/repo.ts
[clone]: ../../dashboard/web/src/components/workflows/clone.ts
[clone-tests]: ../../dashboard/web/src/components/workflows/clone.test.ts
[template]: ../../dashboard/web/src/server/workflow/template.ts
[schema]: ../../dashboard/web/src/server/workflow/schema.ts
[validate-api]: ../../dashboard/web/src/app/api/workflows/validate/route.ts
[schema-tests]: ../../dashboard/web/src/server/workflow/schema-reliability.test.ts
[draft-ui]: ../../dashboard/web/src/components/pages/NewWorkflowPage.tsx
[draft-tests]: ../../dashboard/web/src/components/pages/NewWorkflowPage.test.ts
[template-api-readme]: ../../dashboard/web/src/app/api/templates/README.md
[revision-tests]: ../../dashboard/web/src/server/store/template-revisions.test.ts
[template-api-tests]: ../../dashboard/web/src/app/api/templates/templates.test.ts
[execution]: ../../dashboard/web/src/server/workflow/execution.ts
[workflow-artifacts]: ../../dashboard/web/src/server/workflow/artifacts.ts
[controller-tests]: ../../dashboard/web/src/server/workflow/controller.test.ts
[reliability-tests]: ../../dashboard/web/src/server/workflow/reliability.test.ts
[groups]: ../../dashboard/web/src/server/workflow/groups.ts
[group-tests]: ../../dashboard/web/src/server/workflow/groups.test.ts
[broker]: ../../dashboard/web/src/server/runtime/broker.ts
[broker-tests]: ../../dashboard/web/src/server/runtime/broker.test.ts
[compile]: ../../dashboard/web/src/server/workflow/compile.ts
[compile-tests]: ../../dashboard/web/src/server/workflow/compile.test.ts
[go-runtime]: ../../dashboard/runtime/runtime.go
[go-runtime-tests]: ../../dashboard/runtime/runtime_test.go
[go-input-tests]: ../../dashboard/runtime/inputs_test.go
[runtime-outcome]: ../../dashboard/web/src/server/workflow/runtime-outcome.ts
[integration-tests]: ../../dashboard/web/src/server/workflow/integration-review.test.ts
[go-checkpoint]: ../../dashboard/runtime/checkpoint_linux.go
[go-checkpoint-tests]: ../../dashboard/runtime/checkpoint_test.go
[runtime-uploads]: ../../dashboard/web/src/server/runtime/uploads.ts
[runtime-upload-tests]: ../../dashboard/web/src/server/runtime/uploads.test.ts
[catalog]: ../../dashboard/web/src/server/workflow/builtin-templates.ts
[catalog-tests]: ../../dashboard/web/src/server/workflow/builtin-templates.test.ts
[config]: ../../dashboard/web/src/server/config.ts
[config-tests]: ../../dashboard/web/src/server/config.test.ts
[compute]: ../../dashboard/web/src/server/services/compute.ts
[queues-api]: ../../dashboard/web/src/app/api/queues/route.ts
[kueue]: ../../dashboard/web/src/server/k8s/kueue.ts
[hyperpod]: ../../dashboard/web/src/server/aws/hyperpod.ts
[hyperpod-tests]: ../../dashboard/web/src/server/aws/hyperpod.test.ts
[boundary-tests]: ../../dashboard/web/src/app/api/project-boundaries.test.ts
[datasets]: ../../dashboard/web/src/server/services/datasets.ts
[dataset-tests]: ../../dashboard/web/src/server/services/datasets.test.ts
[snapshots]: ../../dashboard/web/src/server/storage/snapshots.ts
[snapshot-tests]: ../../dashboard/web/src/server/storage/snapshots.test.ts
[artifact-adapter]: ../../dashboard/web/src/server/workflow-adapters/artifacts.ts
[runtime-inputs]: ../../dashboard/web/src/server/runtime/inputs.ts
[store-tests]: ../../dashboard/web/src/server/store/reliability.test.ts
[validation]: ../../dashboard/web/src/server/workflow/validation.ts
[upload-api]: ../../dashboard/web/src/app/api/datasets/[name]/upload-url/route.ts
[credentials]: ../../dashboard/web/src/server/services/credentials.ts
[credential-tests]: ../../dashboard/web/src/server/services/credentials.test.ts
[stack]: ../../dashboard/infra/lib/dashboard-stack.ts
[storage-layout]: ../../dashboard/web/src/server/workflow/storage-layout.ts
[logs-api]: ../../dashboard/web/src/app/api/workflows/[id]/tasks/[task]/logs/route.ts
[k8s-resources]: ../../dashboard/web/src/server/k8s/resources.ts
[log-viewer]: ../../dashboard/web/src/components/workflows/LogViewer.tsx
[events-api]: ../../dashboard/web/src/app/api/workflows/[id]/events/route.ts
[cli]: ../../dashboard/cli/pai.py
[cli-tests]: ../../dashboard/cli/tests/test_pai.py
[live-tests]: ../../dashboard/web/e2e/researcher.spec.ts
[live-readme]: ../../dashboard/web/e2e/README.researcher.md
[status]: ../../dashboard/web/src/server/workflow/status.ts
[dispatch]: ../../dashboard/web/src/server/workflow-adapters/dispatch.ts
[dispatch-tests]: ../../dashboard/web/src/server/workflow-adapters/dispatch.test.ts
[cancel-api]: ../../dashboard/web/src/app/api/workflows/[id]/cancel/route.ts
[bulk-cancel]: ../../dashboard/web/src/app/api/workflows/bulk-cancel/route.ts
[worker]: ../../dashboard/web/src/worker.ts
[pipelines]: ../../dashboard/web/src/server/services/pipelines.ts
[pipeline-tests]: ../../dashboard/web/src/server/services/pipelines.test.ts
[terminal]: ../../dashboard/web/src/server/gateway/terminal.ts
[terminal-tests]: ../../dashboard/web/src/server/gateway/terminal.test.ts
[gateway-k8s]: ../../dashboard/web/src/server/gateway/kubernetes.ts
[sessions]: ../../dashboard/web/src/server/services/sessions.ts
[gateway-auth-tests]: ../../dashboard/web/src/server/gateway/auth.test.ts
[gateway-server]: ../../dashboard/web/src/server/gateway/server.ts
[gateway-server-tests]: ../../dashboard/web/src/server/gateway/server.test.ts
[workspace-readme]: ../../dashboard/session-image/README.md
[workspace-tests]: ../../dashboard/session-image/test_session_image.py
[session-tests]: ../../dashboard/web/src/app/api/sessions/lifecycle.test.ts
[go-files]: ../../dashboard/runtime/files_server.go
[go-files-tests]: ../../dashboard/runtime/files_test.go
[files-ui]: ../../dashboard/runtime/files_ui.go
[metrics]: ../../dashboard/web/src/server/services/metrics.ts
[metrics-api]: ../../dashboard/web/src/app/api/metrics/query/route.ts
[workflow-metrics]: ../../dashboard/web/src/app/api/workflows/[id]/metrics/route.ts
[overview]: ../../dashboard/web/src/server/services/overview.ts
[overview-tests]: ../../dashboard/web/src/components/pages/OverviewPage.test.ts
[proxy]: ../../dashboard/web/src/proxy.ts
[alb-jwt]: ../../dashboard/web/src/server/auth/alb-jwt.ts
[jwt-tests]: ../../dashboard/web/src/server/auth/alb-jwt.test.ts
[projects]: ../../dashboard/web/src/server/auth/projects.ts
[api-tokens]: ../../dashboard/web/src/server/auth/api-tokens.ts
[token-tests]: ../../dashboard/web/src/server/auth/api-tokens.test.ts
[token-lifetime-tests]: ../../dashboard/web/src/server/gateway/token-lifetime.test.ts
[mujoco-train]: ../../dashboard/recipes/mujoco/train.py
[mujoco-eval]: ../../dashboard/recipes/mujoco/evaluate.py
[mujoco-tests]: ../../dashboard/recipes/mujoco/test_integration.py
[isaac-train]: ../../dashboard/recipes/isaaclab/train.py
[sm-pipeline]: ../../e2e-workshop/groot/pipeline/build_pipeline.py
[groot-train]: ../../dashboard/recipes/groot/train.py
[openpi-train]: ../../dashboard/recipes/openpi/train.py
[sdg]: ../../dashboard/recipes/sdg/generate.py
[hf-import]: ../../dashboard/recipes/data/hf_import.py
[import-tests]: ../../dashboard/recipes/data/test_import.py
[mimic]: ../../dashboard/recipes/mimic/generate.py
[cosmos]: ../../dashboard/recipes/cosmos/transfer.py
[leisaac]: ../../dashboard/recipes/leisaac/evaluate.py
[report-tests]: ../../dashboard/web/src/server/evaluations/report.test.ts
[dcv]: ../../dashboard/web/src/server/dcv/sessions.ts
[dcv-bootstrap]: ../../dashboard/dcv-agent/bootstrap.py
[dcv-tunnel]: ../../dashboard/web/src/server/dcv/tunnel.ts
[dcv-tests]: ../../dashboard/dcv-agent/test_verifier.py
[gateway-dcv-tests]: ../../dashboard/web/src/server/gateway/dcv.test.ts
[ros-transfer]: ../../dashboard/recipes/ros2/transfer.py
[ros-tests]: ../../dashboard/recipes/ros2/test_integration.py
[devices]: ../../dashboard/web/src/server/services/devices.ts
[device-tests]: ../../dashboard/web/src/app/api/edge/devices.test.ts
[edge-tests]: ../../dashboard/edge/tests/test_edge.py
[greengrass]: ../../dashboard/web/src/server/aws/greengrass.ts
[edge-runtime]: ../../dashboard/edge/runtime.py
[edge-api-tests]: ../../dashboard/web/src/app/api/edge/api.test.ts
[benchmark-tests]: ../../dashboard/web/src/app/api/edge/benchmark.test.ts
[tracking-proxy]: ../../dashboard/web/src/server/tracking-proxy.ts
[tracking-access]: ../../dashboard/web/src/server/services/tracking-access.ts
[tracking-tests]: ../../dashboard/web/src/server/tracking-proxy.test.ts
[tracking-access-tests]: ../../dashboard/web/src/server/services/tracking-access.test.ts
[compare]: ../../dashboard/web/src/components/pages/experiment-compare.ts
[compare-tests]: ../../dashboard/web/src/components/pages/experiment-compare.test.ts
[models]: ../../dashboard/web/src/server/services/models.ts
[model-tests]: ../../dashboard/web/src/server/evaluations/models.test.ts
[promotion]: ../../dashboard/web/src/server/evaluations/promotion-policy.ts
[promotion-tests]: ../../dashboard/web/src/server/evaluations/promotion-policy.test.ts
[workload-images]: ../../dashboard/infra/lib/constructs/workload-images.ts
[provenance]: ../../dashboard/recipes/provenance.json
[builds]: ../../dashboard/web/src/server/services/builds.ts
[cost]: ../../dashboard/web/src/server/aws/cost.ts
[mujoco-image]: ../../dashboard/images/mujoco/Dockerfile
[isaac-image]: ../../dashboard/images/isaaclab/Dockerfile
[groot-image]: ../../dashboard/images/groot/Dockerfile
[openpi-image]: ../../dashboard/images/openpi/Dockerfile
[cosmos-image]: ../../dashboard/images/cosmos/Dockerfile
[leisaac-image]: ../../dashboard/images/leisaac/Dockerfile
[ros-image]: ../../dashboard/images/ros2/Dockerfile
[recipes-readme]: ../../dashboard/recipes/README.md
[edge-readme]: ../../dashboard/edge/README.md
[edge-recipes]: ../../dashboard/edge/recipes/README.md

[profile-binding]: ../../dashboard/web/src/server/services/profile-binding.ts
[image-profiles]: ../../dashboard/web/src/server/services/image-profiles.ts
[image-profile-tests]: ../../dashboard/web/src/server/services/image-profiles.test.ts
[image-profile-api]: ../../dashboard/web/src/app/api/image-profiles/README.md
[topology-planner]: ../../dashboard/web/src/server/workflow/topology/planner.ts
[topology-inventory]: ../../dashboard/web/src/server/workflow/topology/inventory.ts
[production-topology]: ../../dashboard/web/src/server/workflow-adapters/topology.ts
[topology-tests]: ../../dashboard/web/src/server/workflow/topology/planner.test.ts
[production-topology-tests]: ../../dashboard/web/src/server/workflow-adapters/topology.test.ts
[topology-preview-tests]: ../../dashboard/web/src/app/api/workflows/topology-preview.test.ts
[backends]: ../../dashboard/web/src/server/backends/README.md
[backend-tests]: ../../dashboard/web/src/server/backends/routing.test.ts
[multipart]: ../../dashboard/web/src/server/services/multipart-uploads.ts
[multipart-tests]: ../../dashboard/web/src/server/services/multipart-uploads.test.ts
[multipart-e2e]: ../../dashboard/web/e2e/multipart.spec.ts
[webhooks]: ../../dashboard/web/src/server/services/webhooks.ts
[webhook-worker]: ../../dashboard/web/src/server/services/webhook-worker.ts
[webhook-tests]: ../../dashboard/web/src/server/services/webhooks.test.ts
[restore]: ../../dashboard/runtime/RESTORE.md
[recovery-e2e]: ../../dashboard/web/e2e/checkpoint-recovery.spec.ts
[distributed-e2e]: ../../dashboard/web/e2e/distributed.spec.ts
[model-e2e]: ../../dashboard/web/e2e/model-pipeline.spec.ts
[isaac-e2e]: ../../dashboard/web/e2e/isaaclab.spec.ts

[dcv-activation-tests]: ../../dashboard/dcv-agent/test_activation.py
