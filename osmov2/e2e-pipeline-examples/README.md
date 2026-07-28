# E2E Pipeline Examples

The full physical-AI pipeline from the [e2e-workshop](../../e2e-workshop/),
repackaged as OSMO workflows that run on the AWS reference architecture
(`g6e-l40s` platform by default, Karpenter, OSMO datasets). GPU stages default to
the `g6e-l40s` (NVIDIA L40S, 48GB) platform because it has the broadest capacity
across the four target regions; override any stage with
`--set platform=g7e-rtx-pro-6000` for the 96GB `g7e.8xlarge` card. See
[docs/gpu-capacity.md](../docs/gpu-capacity.md) for the region/AZ availability
behind this default and how to enable the g6e NodePool.

Where `examples/` holds standalone single-purpose workflows, this directory is
an ordered pipeline: each stage's OSMO **output dataset** feeds the next stage's
**input dataset**, so you can run data prep → training → closed-loop eval as a
chain, or run any stage on its own.

```
01-data-prep ─▶ (lerobot dataset) ─▶ 03-training ─▶ (checkpoint) ─▶ 04-closeloop
      │              ▲                     │
      │  06-cosmos-augment (optional)     └──────▶ 05-edge (Greengrass)
      └──────────────┘
02-sim  (standalone RL track)
```

## Stages

| Stage | What it does | OSMO in → out |
| --- | --- | --- |
| [01-data-prep](01-data-prep/README.md) | Download a LeRobot dataset from HF, auto-convert v3→v2.1, validate. | — → `e2e-pipeline-lerobot-dataset` |
| [02-sim](02-sim/README.md) | Isaac Lab RL: train H1 humanoid to walk (PPO), replay + record video. | — → `e2e-pipeline-sim-rl-artifacts` |
| [03-training](03-training/README.md) | GR00T VLA fine-tune on the SO-101 dataset with the workshop SO-101 modality config. Default N1.6; [workflow-n1.7.yaml](03-training/workflow-n1.7.yaml) is the optional N1.7 path. | `e2e-pipeline-lerobot-dataset` → `e2e-pipeline-groot-checkpoint` |
| [04-closeloop](04-closeloop/README.md) | LeIsaac + SO-101 + kitchen scene closed-loop eval against the ZMQ policy server. | `e2e-pipeline-groot-checkpoint` → `e2e-pipeline-closeloop-artifacts` |
| [05-edge](05-edge/README.md) | Greengrass components that run the GR00T policy server on a robot. | S3 model → on-device server |
| [06-cosmos-augment](06-cosmos-augment/README.md) | *(optional)* Cosmos Transfer 2.5 photorealistic augmentation (edge control, RGB-only) of the Stage 1 LeRobot videos; re-feeds Stage 3. | `e2e-pipeline-lerobot-dataset` → `e2e-pipeline-lerobot-dataset-cosmos` |

## Recommended GPU per stage

All GPU stages run on a single L40S (48GB) — the `g6e-l40s` default. Karpenter
picks the instance size from each stage's `cpu`/`memory` request, so "recommended
size" is just the size to prewarm. The `g6e-l40s` NodePool offers
`g6e.{2,4,8,12}xlarge`, which covers every stage below.

| Stage | Workload | cpu / memory | Recommended g6e | 96GB g7e override |
| --- | --- | --- | --- | --- |
| 01-data-prep | data prep (CPU only) | — | — (no GPU) | — |
| 02-sim | RL (Isaac Lab PPO) | 8 / 90Gi | `g6e.4xlarge` | `g7e.4xlarge` |
| 03-training | VLA fine-tune (N1.6/N1.7) | 16 / 96Gi | `g6e.8xlarge` | `g7e.8xlarge` |
| 04-closeloop | closed-loop eval | 8 / 90Gi | `g6e.4xlarge` | `g7e.4xlarge` |
| 06-cosmos-augment | Cosmos augmentation | 30 / 128Gi | `g6e.12xlarge` | `g7e.12xlarge` |

The 96GB `g7e` override (`--set platform=g7e-rtx-pro-6000`) is only needed when a
single 48GB card is too small — a larger training `global_batch_size`, N1.7's
gated backbone, or Cosmos OOM at higher resolutions. The g7e NodePool is always
deployed, so it needs no redeploy.

## Mapping to the e2e-workshop

| This stage | e2e-workshop source | Key adaptations |
| --- | --- | --- |
| 01-data-prep | `groot/training/data/{upload_dataset,convert_v3_to_v2}.py` | Writes to an OSMO dataset instead of S3; conversion logic embedded inline. |
| 02-sim | Modules 2–4, `scripts/reinforcement_learning/skrl/{train,play}.py` | Runs headless in an OSMO pod; exports checkpoint + TensorBoard + video as a dataset. |
| 03-training | `infra/groot/assets/{run_finetune_workflow.sh,finetune_gr00t.py,launch_finetune.py}`, `groot/training/data/configs/so101_modality_config.py` | Single-pod OSMO task; consumes Stage 1 dataset; SO-101 modality config. Default N1.6 (`launch_finetune.py`); N1.7 variant inlines the `finetune_gr00t.py` `experiment.run()` path. |
| 04-closeloop | `groot/inference/run-isaaclab.sh` | Same LeIsaac install + N1.6 language-key patch + headless-keyboard patch + kitchen_with_orange/so101_follower assets, orchestrated by OSMO instead of Docker-on-DCV. |
| 05-edge | `edge/workshop-components/N1.6/com.workshop.{setup,inference}` | Model from S3 (not CloudFront tarball); parameterized ECR image; TRT optional. |
| 06-cosmos-augment | `examples/nut-pouring-pipeline/workflows/03_cosmos_augmentation.yaml` | Same pinned Cosmos Transfer 2.5 ref + tokenizer patch, adapted to the LeRobot per-episode mp4 layout; edge control (RGB-only) instead of depth. |

## Running the chain

GPU stages need visible g6e capacity before OSMO validation (enable the g6e
NodePool at deploy with `DEPLOY_G6E_NODEPOOL=true OSMO_CONFIGURE_G6E_PLATFORM=true`).
The prewarm below uses `g6e.8xlarge`, which covers Stages 2/3/4; if you run the
optional Stage 6 (Cosmos, `cpu: 30`), prewarm `g6e.12xlarge` instead — see the
per-stage table above.

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.8xlarge scripts/prewarm-gpu-node.sh

# Stage 1 — data prep (CPU)
osmo workflow submit e2e-pipeline-examples/01-data-prep/workflow.yaml \
  --set hf_dataset_id=LightwheelAI/leisaac-pick-orange

# Stage 6 (optional) — Cosmos Transfer 2.5 photorealistic augmentation (GPU).
# Insert only for domain-randomized training frames; then point Stage 3 at
# e2e-pipeline-lerobot-dataset-cosmos instead of the Stage 1 dataset.
osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos

# Stage 3 — fine-tune (consumes Stage 1 output). Default is N1.6.
osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000

# Stage 3 (N1.7 variant) — needs HF_TOKEN for the gated Cosmos-Reason2-2B backbone;
# writes to e2e-pipeline-groot-checkpoint-n17 (Stage 4 must be overridden for N1.7).
osmo workflow submit e2e-pipeline-examples/03-training/workflow-n1.7.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=6000 --set save_steps=2000

# Stage 4 — closed-loop eval (consumes Stage 3 output)
osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set input_dataset=e2e-pipeline-groot-checkpoint

scripts/wait-gpu-node-cleanup.sh
```

Any GPU stage can be moved to the 96GB g7e (RTX PRO 6000, `g7e.8xlarge`) card by
prewarming a g7e node and adding `--set platform=g7e-rtx-pro-6000` to its submit
command (the g7e NodePool is always deployed, so no redeploy is needed) — useful
for a larger training `global_batch_size`, N1.7's gated backbone, or Cosmos OOM
at higher resolutions:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set platform=g7e-rtx-pro-6000 \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000
```

Stage 2 (RL) is independent and can run anytime:

```bash
osmo workflow submit e2e-pipeline-examples/02-sim/workflow.yaml
```

Stage 5 (edge) is a Greengrass deployment — see [05-edge/README.md](05-edge/README.md).

## Isaac Sim version coverage

Defaults follow the repo's stable pins:

- Stage 2 / Stage 4: Isaac Lab `2.2.0` (Isaac Sim 4.5.0 era). Override
  `--set isaac_lab_image=nvcr.io/nvidia/isaac-lab:2.3.0` for the 5.1 latest
  stack (allow more memory).
- Stage 1 / Stage 3: PyTorch `25.03-py3`.

## Status of these recipes

These OSMO recipes are derived from the e2e-workshop code. A source-level audit
against the pinned upstream refs (`Isaac-GR00T@ead52833`, `leisaac@24d3bcd3`,
tyro `0.9.17`) was done on 2026-07-12 — cloning the refs and reproducing the CLI
parsing. The CLI defects that audit found have since been corrected in the
workflow YAML (see "Fixed" below). Full end-to-end runtime validation of this
ordered pipeline on GPU is still pending; artifacts should land under
`e2e-pipeline-examples/<stage>/validation/` once each stage runs for real.

That said, the GR00T inference code path this pipeline reuses (ZMQ policy
server + rollout) has been runtime-validated out-of-band: the standalone
[`examples/closed-loop-sim-eval`](../examples/closed-loop-sim-eval/README.md)
(RoboCasa GR1) passed end-to-end on a G6e/L40S node on 2026-07-27
(`success rate: 1.0`). It is a different task/embodiment than Stage 4 (leisaac
SO-101), but shares the server + rollout mechanics, so that machinery is known
to work on this platform.

### Verified OK (no change needed)

- Stage 1 v3→v2.1 conversion matches upstream `convert_v3_to_v2.py` function
  by function.
- Stage 3 SO-101 modality config is identical to upstream; its imports
  (`register_modality_config`, the 5 symbols from `gr00t/data/types.py`) and
  `EmbodimentTag.NEW_EMBODIMENT` all exist at the pinned commit.
- `launch_finetune.py`, `run_gr00t_server.py`, and the task id
  `LeIsaac-SO101-PickOrange-v0` all exist at the pinned refs.
- Server invocation: tyro 0.9.17 accepts BOTH underscore and hyphen flags
  (reproduced), so Stage 4 (`--model_path`) and Stage 5 (`--model-path`) are
  both valid.
- Stage 3's other CLI flags parse cleanly against the real `FinetuneConfig`.

### Fixed (2026-07-12)

Stage 3 (`03-training/workflow.yaml`):

- [x] **`--use-relative-action` removed.** `FinetuneConfig` has no
      `use_relative_action` field; tyro exited with `Unrecognized options`
      (reproduced). `launch_finetune.py` already hardcodes
      `config.model.use_relative_action = True`, so the flag and the
      `use_relative_action` knob were dropped from the workflow.

Stage 4 (`04-closeloop/workflow.yaml`) — eval command corrected against the
leisaac official example in `docs/docs/resources/available_policy.md` (N1.6):

- [x] **`--policy_type` → `gr00tn1.6`** (was `gr00t`, which hit no branch;
      N1.6 path uses `Gr00t16ServicePolicyClient`).
- [x] **Removed non-existent flags** `--num_envs`, `--headless`,
      `--record_video`, `--video_dir`, `--total_episode`; episode count is now
      `--eval_rounds=N`, plus `--enable_cameras` and `--device=cuda`.
- [x] **`gr00t_ref` → `e8e625f4f21898c506a1d8f7d20a289c97a52acf`** to match
      leisaac's N1.6 doc (N1.6 ZMQ/server compat is commit-sensitive).

### Still to decide / verify at runtime

- [x] **Stage 3 N1.6 vs N1.7 — both paths now provided.** The workshop's main
      fine-tuning module (`infra/groot`) targets `nvidia/GR00T-N1.7-3B` via
      `finetune_gr00t.py` (the `experiment.run()` API). N1.6 is kept as the
      default (`workflow.yaml`, `launch_finetune.py`, no gated backbone, easier
      to reproduce); N1.7 is a separate optional path
      ([workflow-n1.7.yaml](03-training/workflow-n1.7.yaml)) that pins
      `gr00t_ref=23ace64f…`, uses `nvidia/GR00T-N1.7-3B`, and inlines a
      single-pod port of upstream `finetune_gr00t.py`. N1.7 needs `HF_TOKEN`
      with access to the gated `nvidia/Cosmos-Reason2-2B` backbone.
      **Chaining note:** the N1.7 checkpoint requires an N1.7-compatible
      server/policy client in Stage 4, which currently pins the N1.6 `gr00t_ref`
      + `--policy_type gr00tn1.6`; override Stage 4 before chaining N1.7.
- [ ] **Stage 3 `max_steps`/`save_steps` are tiny** (smoke checks). Scale up
      for a policy-quality run.
- [ ] **Stage 4 emits no video.** `policy_inference.py` sets
      `env_cfg.recorders = None` and wraps no `RecordVideo`, so no mp4 is
      produced. Success/fail comes from the rollout log; the `videos/` output
      stays empty unless you add a `gym.wrappers.RecordVideo` patch.

Reference — leisaac's official N1.6 example (the target shape for Stage 4):

```shell
python scripts/evaluation/policy_inference.py \
    --task=LeIsaac-SO101-PickOrange-v0 \
    --eval_rounds=10 \
    --policy_type=gr00tn1.6 \
    --policy_host=localhost --policy_port=5555 \
    --policy_timeout_ms=5000 --policy_action_horizon=16 \
    --policy_language_instruction="Pick up the orange and place it on the plate" \
    --device=cuda --enable_cameras
```

### Notes

- Stage 4's `run-isaaclab.sh` origin only launches the container interactively
  (Step 6); the actual `policy_inference.py` command lived in the external
  workshop guide (Module 8), which is why the invocation needed cross-checking
  against the leisaac docs above.
- Follow the repo convention: keep any validation artifacts under
  `e2e-pipeline-examples/<stage>/validation/` with a `validation.md`.
