# Release 3 validation and stable handoff — 2026-09-16

**The bounded core integration paths passed. The complete F01–F42 design remains partially supported.** See the [feature inventory](2026-09-16-feature-evidence.md) for the remaining software and external conditions. This is the historical coordinator handoff; the subsequent parent commit, original-branch integration and deployment are recorded in the [integration report](2026-09-16-release3-integration.md).

## Accepted deployment

Account `913524902871`, region `us-east-1`, default EKS backend, project `workshop`. CloudFormation stack `PhysicalAiDashboard-913524902871` is **UPDATE_COMPLETE**; the [resource audit](evidence/2026-09-16-release3/resource-audit.json) was taken at `2026-09-16T16:20:38.679358+00:00`. Final frozen assembly: `/tmp/physical-ai-release3-bootstrap-cdk`; deploy log: `/tmp/physical-ai-release3-bootstrap-deploy.log`; outputs: `/tmp/physical-ai-dashboard-outputs-release3.json`.

Final web/controller/gateway image digest: `sha256:44e63a642fba437f20bf5f9e23f400fb9904531e6b009e631c24e97c3fc71189`. Assets were built from the uncommitted implementation worktree; a base Git HEAD alone is not the deployed-source identity. [Source hashes](evidence/2026-09-16-release3/source-freeze.json) record the handoff files.

| Service | CloudFormation-managed task definition | Observed state |
|---|---|---|
| web | `PhysicalAiDashboardWebTaskDefD0130F4C:17` | 1 running / 0 pending; COMPLETED |
| controller | `PhysicalAiDashboardWebControllerTaskE9024EAA:7` | 1 running / 0 pending; COMPLETED |
| gateway | `PhysicalAiDashboardWebGatewayTask10DBE637:7` | 1 running / 0 pending; COMPLETED |

The final bootstrap correction changed only the three task definitions. Earlier release-3 changes added the documented session-scoped gateway OpenDataChannel grant. No VPC/VM/cluster/storage replacement or capacity scaling occurred.

## Actual acceptance results

| Path | Run / result | Evidence |
|---|---|---|
| CPU exit policy and publication | `839dd756b2c1c0dc`; raw exit7 → wrapper0; exact READY bytes and publication receipt | [Producer log](evidence/2026-09-16-release3/cpu-producer.log) |
| Upload → READY → hydration | `5b740b38400aab04`; pinned manifest and exact input/output bytes | [Hydration log](evidence/2026-09-16-release3/cpu-hydration.log) |
| MuJoCo model/evaluation | `5485ff71b84843ee`; real training, registered model `mdl-0af861652331e0c454117246`, verified evaluation `eval-db22b906429d89b8c29d2fb9` | [Complete proof](evidence/2026-09-16-release3/model-pipeline-proof.json) |
| Quality decision | Two episodes; **REVIEW, approved=false** | Same proof. No automatic model approval or20-episode quality claim |
| Checkpoint restore | `b67546d015a31556`; RESCHEDULE attempt1→2, optimizer/normalization restored,128→192 timesteps | [Log](evidence/2026-09-16-release3/checkpoint-recovery.log), [receipt](evidence/2026-09-16-release3/checkpoint-task.json) |
| Native topology / distributed | `9177abf23b152804`; two real CPU Pod node names, required use1-az4 label match, Torch/Gloo collective/training outputs and identical READY weights | [Log](evidence/2026-09-16-release3/distributed.log), [plan/receipt](evidence/2026-09-16-release3/distributed-task.json) |
| Isaac GPU training/replay | Train `5084f1435140580b`, replay `b8c30447d3efcd03`; real CUDA and optimizer/weight changes, verified checkpoints, pinned replay and nonblank decoded video | [Proof](evidence/2026-09-16-release3/isaaclab-proof.json):1.92s,1280×720,398 sampled colors |
| ROS2 communication | `05839fe0398ce352`; discovery and20 unique run-tagged messages, committed subscriber output | [Log](evidence/2026-09-16-release3/ros2.log), [receipt](evidence/2026-09-16-release3/ros2-task.json) |
| DCV setup idempotency | Actual deployed bootstrap ready=true, initialActivation=false; identical service PID/start timestamp | [Proof](evidence/2026-09-16-release3/dcv-idempotent-setup-proof.json), [log](evidence/2026-09-16-release3/dcv-idempotent-setup.log) |
| DCV final reconnect | Valid HTTPS, actual console connection increase and visible canvas; owned grant closed | [Proof](evidence/2026-09-16-release3/dcv-reconnect-proof.json), [log](evidence/2026-09-16-release3/dcv-final-reconnect.log) |
| Seven image profiles | Actual ECR digest/AMD64 inspection and CAS approval refresh to final workload tags | [Log](evidence/2026-09-16-release3/image-profiles.log) |

Parent-reported release2 token authorization/revocation, browser multipart16MiB+17B resume/CORS/SHA, and terminal/files acceptance remain separately identified in the feature inventory. They were not presented as fresh coordinator reruns.

## Corrections validated

- Trusted collector mount normalization now allows actual FSx inventory publication while preserving strict path/readonly requirements. Real downstream hydration and model ingestion completed.
- Production topology inventory derives from actual namespace, LocalQueue, ClusterQueue, flavors, Topology and Nodes. The served API version is used. Both JobSet child Job and Pod metadata carry the governed queue label; Kueue still admits one ancestor JobSet.
- The Isaac image permits UID1000 traversal; playback now uses private writable portable Kit cache/data directories before AppLauncher and keeps them until environment/app shutdown. The attempted overscan-default workaround was withdrawn before any video image build.
- The gateway image includes OS CA certificates needed by the Go SSM plugin. DCV initial external-auth activation is explicit and guarded to the single idle registered console, with no virtual sessions or active clients. Existing configured setup is idempotent. Bootstrap checks an existing running console; `server-ready` is used only as console-creation capacity, not existing-session health.
- The model E2E compares shared pin fields and both SHA representations (`sha256` / manifest `fullSHA256`), preserving all checksum checks.

Verification: **843 web tests passed /1 existing skip**,110 files; final bootstrap/session regression checks **115 passed**, plus **5 Python activation/verifier tests** and **3 portable-root lifecycle tests**. Web, infrastructure and all E2E specs typechecked; final Docker Next/service builds passed. The distributed and other E2E specs are now included in the aggregate E2E typecheck.

## Failures retained as evidence and limits

- The first CPU producer attempt failed hosted login before creating a run; its standalone retry passed. The combined hydration log retains that distinction.
- The20-episode CPU evaluation exceeded its12-minute work budget while software rendering progressed and was cancelled. The accepted two-episode path correctly requires review; it is not a learned-performance or20-episode quality pass.
- Earlier Isaac traversal/cache/RTX failures and JobSet governance failures were real software defects, then corrected and retested. They are not recategorized as unavailable hardware.
- SageMaker `n4r1xdb896rc` failed with optimizer OOM on the small G5 configuration. `w9r84qbsl8xn` and `r4ib9i57o09e` exceeded their earlier capacity-wait budgets and are Stopped. Final states are in the resource audit. No successful GR00T SageMaker training/approval is claimed.
- Runtime checkpoint files over5GiB and the1024-object runtime input/checkpoint limits remain. Browser multipart does not remove those limits.
- Only the default backend and observed zone/hostname hierarchy were exercised. Additional EKS targets remain conditional on current-account/us-east-1/home-VPC capability evidence. No cross-cloud/Slurm execution, dedicated Ray/DeepSpeed operator, EFA/NCCL, OpenPI/LeIsaac/Cosmos/Mimic/SDG or physical-device acceptance was fabricated.
- DCV supports admin access to one imported workstation/console; this does not prove per-workload-node interactive rendering. ROS proof is communication-only, not robot motion or HIL.
- Webhooks have local/fake delivery evidence only. No real recipient or outbound webhook/email message was configured by the coordinator. MCP, arbitrary privileged profiles/registry connectors and other explicitly listed F01–F42 gaps remain.

## DCV service action and preservation

One conditionally authorized `dcvserver` service restart activated the external verifier at15:55:58 UTC, after an exact Ubuntu console/typeconsole/zero-connection guard and config backup. The configuration parser, signing-key equality, local verifier and HTTP/WebSocket transport were already verified; the documented configuration writer did not activate the running daemon and `CanReload=no`.

No VM reboot/stop or Isaac/application kill was issued. The initial post-restart probe incorrectly omitted the required session type and stopped before emitting its complete PID comparison. This is **not** represented as a full before/after PID proof. The [host audit](evidence/2026-09-16-release3/dcv-host-audit.json) confirms the running idle console and current Xorg/desktop/Python processes predating activation. Two failed header-only observers were cleaned by exact process identity; their missing result was not treated as zero request arrivals. The subsequent real DCV browser and idempotent setup tests passed.

## Cleanup and handoff

[Resource audit](evidence/2026-09-16-release3/resource-audit.json): three steady services, zero active workshop workflows/dashboard Pods/DCV tunnels, both coordinator temporary Fargate probes STOPPED, SageMaker attempts terminal, and three Ready Nodes with GPU capacity still1. Completed datasets, models, evaluations and versioned artifacts are retained as evidence; no unrelated resources were removed.

[Original preservation audit](evidence/2026-09-16-release3/original-preservation.json): original repository HEAD remains `c40b27f5d74e540d5841d27881e3faeacef88bc8`, with every captured dirty workshop/document/backup file hash unchanged. Original Git operations used optional locks disabled. No commit, merge, reset, or original-file edit was performed.

Production source is frozen for parent commit/merge integration. Final report/link/hash checks passed. The coordinator has finished production edits and deployment/test processes; `/tmp/physical-ai-release3-coordinator.md` records the stable handoff. Parent owns the subsequent local commit and merge into the original worktree while preserving its dirty files.
