# Researcher recipe workloads

This catalog implements the recipe portion of approved dashboard design F29–F34/F40. It does not provision infrastructure, push images, register SageMaker pipelines, or operate a physical robot.

The catalog is in `dashboard/web/src/server/workflow/builtin-templates.ts`. Every recipe includes source URLs, image contract, artifact paths, verification level, and explicit prerequisites in YAML `ui.recipe`. The [feature inventory](../../docs/reports/2026-09-16-feature-evidence.md) distinguishes software support from [measured AWS executions](../../docs/reports/2026-09-16-release3-validation.md).

## Execution integration

1. Build from **repository root**, with the Dockerfile paths below. Set image URI environment variables before importing/seeding the built-ins. Unconfigured images deliberately use `required://ENV_NAME`, accompanied by a prerequisite reason; they are not ECR tags.
2. Before submission, call `recipeConfigurationErrors(template, overrides)` for missing image parameters. GPU/model/network/asset prerequisite metadata also requires parent preflight; an image URI alone does not mark those recipes ready.
3. Submit through the workflow API. The schema accepts `{{workflow_id}}` in output dataset names, and submission resolves it after generating the durable run ID. The saved spec contains the resolved names. `materializeBuiltinTemplate` remains a compatibility helper for explicit offline rendering; browser users do not need to create run IDs or edit dataset names manually.
4. Pipelines use `{ task: ... }` inputs, so evaluation and augmentation consume the producing task's output from this run/attempt. Standalone imported datasets explicitly reference version 1; edit YAML to select another immutable version.
5. Every declared output is below `{{output}}`. The compiler owns project paths, input hydration and the separate `TASK_RUNTIME_IMAGE`. Workload images contain no orchestration runtime.
6. Groups use compiler-supported `{{host:discovery}}` / `{{host:policy}}`. One lead controls completion; group barriers/admission, host resolution, termination, and epoch fencing belong to the parent engine.
7. Tasks declaring `checkpoint` with `url: auto` use the runtime broker's project/run/attempt-scoped durable publication. Retry attempts restore only committed checkpoint manifests. The MuJoCo recovery path has actual optimizer/normalization restoration evidence; framework-specific recipes must consume the supplied restore paths, and simulator trajectories are not universally bit-identical.
8. Retire persisted legacy `workshop-setup`, `mujoco-setup`, and `isaaclab-play` records from the previous catalog when migrating existing stores (`RETIRED_BUILTIN_TEMPLATE_IDS` is exported). They are intentionally absent: shared mutable FSx setup is obsolete; node-pinned DCV playback belongs to the parent session integration. `isaaclab-video` retains actual headless checkpoint playback.

## Images and verification boundaries

| Dockerfile under `dashboard/images/` | URI environment | Contract / remaining prerequisites |
|---|---|---|
| `mujoco/Dockerfile` | `MUJOCO_IMAGE_URI` | **Built; actual AWS CPU learning, evaluation and checkpoint recovery passed.** Python 3.11.13, CPU Torch, SB3 PPO, MuJoCo, SO-101 Menagerie assets, workshop environment, video codecs, HF converter. The measured two-episode quality result remains REVIEW, not approval. |
| `isaaclab/Dockerfile` | `ISAACLAB_IMAGE_URI` | Isaac Lab 2.3.0 derivative; workshop robot USD/URDF/source and adapters baked in. **Actual SO-101 GPU PPO and nonblank checkpoint replay video passed.** Other tasks, Replicator and Mimic still require their own compatible driver/RTX GPU, assets and measured outputs. |
| `groot/Dockerfile` | `GROOT_RUNTIME_IMAGE_URI` | Official N1.6.1 release commit and frozen upstream lock; full training interpreter includes MLflow plugin. **Image built; EKS training not live-accepted.** The separate SageMaker attempts failed OOM or were stopped after capacity waits. Model/data access, sufficient VRAM and tracking role remain prerequisites. |
| `openpi/Dockerfile` | `OPENPI_IMAGE_URI` | Pinned official OpenPI and frozen lock. **Image built; actual learning unverified.** JAX CUDA, LIBERO LeRobot input, base weights at `gs://openpi-assets/checkpoints/pi0_base`, and tested LoRA memory profile required. No SO-101 compatibility claim. |
| `cosmos/Dockerfile` | `COSMOS_IMAGE_URI` | Pinned Cosmos-Transfer2.5 and frozen lock. **GPU build/run unverified.** Authorized weights and a compatible 80 GB GPU; upstream documents 65.4 GB for Transfer2-2B inference. Existing A10G resources do not satisfy that profile. |
| `leisaac/Dockerfile` | `LEISAAC_IMAGE_URI` | Build args `ISAACLAB_RECIPE_IMAGE`, `LEISAAC_ASSETS_IMAGE`, `LEISAAC_SCENE_REVISION`. Asset image must contain `/assets/scenes/kitchen_with_orange/scene.usd` plus matching SO-101 robot/material files. **GPU build/run unverified.** Two concurrent GPU allocations, compatible GR00T model, and port 5555 between pods required. |
| `ros2/Dockerfile` | `ROS2_IMAGE_URI` | ROS Humble and Fast DDS tools baked in. **Actual Kubernetes discovery and 20 unique run-scoped messages passed.** This verifies communication, not physical robot motion or HIL. |

All build contexts are the repository root. No workload requires `/fsx/scratch` checkouts or `/fsx/envs`. GPU Dockerfiles are source-verified build definitions, **not** proof that those images have been provisioned or executed.

Example local build (no push):

```bash
docker build -f dashboard/images/mujoco/Dockerfile \
  --build-arg RECIPE_SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t physical-ai-mujoco:recipe-test .
```

## Workloads

| Template ID | Actual operation / outputs |
|---|---|
| `custom` | Minimal editable CPU workflow using the baked image; a run-scoped JSON artifact, with no training/evaluation claim. |
| `mujoco-train` | Workshop SO-101 reach, SB3 PPO, seeded physics, periodic paired checkpoints, TensorBoard, final and best policy. |
| `mujoco-render` | Deterministic real closed-loop rollout; `evaluation.json` and `videos/*.mp4`. |
| `mujoco-pipeline` | Train → evaluate exact run's `final/` bundle. Independent default evaluation seed, distinct from training checkpoint selection seeds. |
| `isaaclab-train` | Workshop Reach/Lift RSL-RL PPO with seed, iteration/save interval, resume, actual MLflow scalars. |
| `isaaclab-h1` | Upstream `Isaac-Velocity-Flat-H1-v0` / `Isaac-Velocity-Rough-H1-v0`; no fabricated H1 task. |
| `isaaclab-video` | Existing workshop playback with explicit output video path. It does not report a quality success rate. |
| `hf-dataset-import` | Resolve HF commit, snapshot download, one-argument in-place v3→v2.1 conversion on an isolated copy, verify all episode Parquet lengths and videos. Publish dataset plus conversion manifest. |
| `gr00t-finetune` | Pinned official launch_finetune. Quick defaults: steps 100 / batch 4 / checkpoint 50. Full Trainer-state resume and real loss scalars sent to MLflow. |
| `openpi-train` | Official normalization computation + JAX `scripts/train.py`, real LIBERO data and LoRA fine-tuning. Checkpoint/assets paths under output; input/model cache outside published output. |
| `replicator-sdg` | Real USD scene, seeded camera randomization, RGB / metric-depth / semantic frames, strict frame manifest. |
| `mimic-pipeline` | Official auto-annotation → Mimic generation → HDF5 action validation, requiring real Franka stack input demonstrations. Upstream task config fixes the generation seed; no unsupported `--seed` flag is passed. |
| `cosmos-pipeline` | SDG → control-video encoding → official Cosmos inference. Manifest declares fixed 0–5 m depth visualization; generated videos are not labeled as robot trajectories or successful actions. |
| `ros2-transfer` | Discovery server, publisher, subscriber lead in one group. Output contains distinct payloads with the actual run ID. |
| `leisaac-evaluate` | Real GR00T policy server + LeIsaac simulator group; explicit `success` termination, bounded rounds, per-round durable JSON, videos, latency quantiles and actual checkpoint digest. |

### MuJoCo checkpoint/evaluation contract

Entry points:

```text
python /opt/recipes/mujoco/train.py --output-dir <run-output> --seed 42 \
  --total-steps 200000 --num-envs 4 --checkpoint-every 10000
python /opt/recipes/mujoco/train.py --output-dir <new-run-output> \
  --resume <previous-output>/final --total-steps 200000
python /opt/recipes/mujoco/evaluate.py --checkpoint <run-output>/final \
  --output-dir <evaluation-output> --seed 2042 --episodes 5
```

`initial/`, `checkpoints/step-*/`, and `final/` each contain `model.zip`, **matching** `vecnormalize.pkl`, and `manifest.json` with SHA-256 hashes, seed, timestep/update count, scene revision, source hashes and package versions. Bundles become visible by directory rename only after both model and statistics are written. The fixed-seed best-return selection is recorded in `best_checkpoint.json`; legacy `model_best.zip` / `model_final.zip` have explicitly paired `vecnormalize_best.pkl` / `vecnormalize_final.pkl`.

Resume requires the trusted bundle, verifies both digests and scene identity, and restores PPO optimizer/normalization state. It starts new simulator trajectories from the requested seed; it does **not** promise bit-for-bit continuation of in-flight environments/RNG state. Additional steps round to the saved PPO rollout length. Resume rollout/batch size must match the checkpoint. SIGTERM/SIGINT request a final bundle and exit 75 for the template's RESCHEDULE action.

Evaluation freezes normalization, uses deterministic policy actions and fixed episode seeds, and records the environment's real terminal distance/success. A 10-second horizon can be both truncated and successful; timeout and success are reported independently. JSON includes `type`, task, seed, episode/success/timeout counts, per-episode return and distance, p50/p95/p99 policy latency, checkpoint/normalization digests, simulator/scene version, and relative video URIs. Relative video URIs are resolved against the published evaluation artifact root. Small integration runs establish functioning learning/artifact contracts, not a trained quality threshold.

MLflow is enabled only where adapters actually implement it. Isaac Lab mirrors real TensorBoard reward/loss scalars after training; GR00T logs real Trainer scalars during training. Tracking/plugin failures propagate when a tracking URI is configured. OpenPI does not claim MLflow integration.

## Tests

From repository root:

```bash
# Catalog → actual parser/schema → compiler and JobSet groups; no web dependency changes.
cd dashboard/web
npm test -- src/server/workflow/builtin-templates.test.ts
npx tsc --noEmit --incremental false
```

From repository root, after the local MuJoCo build:

```bash
docker run --rm --network none --user 1000:1000 physical-ai-mujoco:recipe-test \
  python /opt/recipes/mujoco/test_integration.py
docker run --rm --network none --user 1000:1000 physical-ai-mujoco:recipe-test \
  python /opt/recipes/data/test_import.py
docker build -f dashboard/images/ros2/Dockerfile -t physical-ai-ros2:recipe-test .
python dashboard/recipes/ros2/test_integration.py
```

The CPU test executes genuine SO-101 physics and PPO updates (512 steps), resumes for 256 additional steps, verifies every checkpoint hash/statistics pair and changed weights, renders/decode-checks MP4, repeats deterministic evaluation, and rejects mismatched statistics. The import test invokes the actual workshop converter on Parquet data and rejects a missing episode file despite the converter's warning-only behavior. The ROS test creates an internal Docker network and three distinct containers, validates ten distinct run-scoped messages, then removes only its own resources.

GPU training, H1, Replicator/Mimic/Cosmos, LeIsaac closed loop, managed MLflow, Kubernetes networking/admission, and S3 durable publication still need provisioned integration tests. No AWS mutation, deployment, push, physical-device operation, agent delegation, or commit was performed.

Exact files: `dashboard/recipes/FILES.txt`. Pinned source evidence: `dashboard/recipes/provenance.json`.
