# E2E Pipeline Examples

The full physical-AI pipeline from the [e2e-workshop](../../e2e-workshop/),
repackaged as OSMO workflows that run on the AWS reference architecture
(`g7e-rtx-pro-6000` platform, Karpenter, OSMO datasets).

Where `examples/` holds standalone single-purpose workflows, this directory is
an ordered pipeline: each stage's OSMO **output dataset** feeds the next stage's
**input dataset**, so you can run data prep → training → closed-loop eval as a
chain, or run any stage on its own.

```
01-data-prep ─▶ (lerobot dataset) ─▶ 03-training ─▶ (checkpoint) ─▶ 04-closeloop
                                                          │
02-sim  (standalone RL track)                             └──────▶ 05-edge (Greengrass)
```

## Stages

| Stage | What it does | OSMO in → out |
| --- | --- | --- |
| [01-data-prep](01-data-prep/workflow.yaml) | Download a LeRobot dataset from HF, auto-convert v3→v2.1, validate. | — → `e2e-pipeline-lerobot-dataset` |
| [02-sim](02-sim/workflow.yaml) | Isaac Lab RL: train H1 humanoid to walk (PPO), replay + record video. | — → `e2e-pipeline-sim-rl-artifacts` |
| [03-training](03-training/workflow.yaml) | GR00T VLA fine-tune on the SO-101 dataset with the workshop SO-101 modality config. | `e2e-pipeline-lerobot-dataset` → `e2e-pipeline-groot-checkpoint` |
| [04-closeloop](04-closeloop/workflow.yaml) | LeIsaac + SO-101 + kitchen scene closed-loop eval against the ZMQ policy server. | `e2e-pipeline-groot-checkpoint` → `e2e-pipeline-closeloop-artifacts` |
| [05-edge](05-edge/README.md) | Greengrass components that run the GR00T policy server on a robot. | S3 model → on-device server |

## Mapping to the e2e-workshop

| This stage | e2e-workshop source | Key adaptations |
| --- | --- | --- |
| 01-data-prep | `groot/training/data/{upload_dataset,convert_v3_to_v2}.py` | Writes to an OSMO dataset instead of S3; conversion logic embedded inline. |
| 02-sim | Modules 2–4, `scripts/reinforcement_learning/skrl/{train,play}.py` | Runs headless in an OSMO pod; exports checkpoint + TensorBoard + video as a dataset. |
| 03-training | `infra/groot/assets/{run_finetune_workflow.sh,finetune_gr00t.py}`, `groot/training/data/configs/so101_modality_config.py` | Single-pod OSMO task; consumes Stage 1 dataset; SO-101 modality config + `use_relative_action` knob. |
| 04-closeloop | `groot/inference/run-isaaclab.sh` | Same LeIsaac install + N1.6 language-key patch + headless-keyboard patch + kitchen_with_orange/so101_follower assets, orchestrated by OSMO instead of Docker-on-DCV. |
| 05-edge | `edge/workshop-components/N1.6/com.workshop.{setup,inference}` | Model from S3 (not CloudFront tarball); parameterized ECR image; TRT optional. |

## Running the chain

GPU stages need visible G7e capacity before OSMO validation:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

# Stage 1 — data prep (CPU)
osmo workflow submit e2e-pipeline-examples/01-data-prep/workflow.yaml \
  --set hf_dataset_id=LightwheelAI/leisaac-pick-orange

# Stage 3 — fine-tune (consumes Stage 1 output)
osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000

# Stage 4 — closed-loop eval (consumes Stage 3 output)
osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set input_dataset=e2e-pipeline-groot-checkpoint

scripts/wait-gpu-node-cleanup.sh
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
workflow YAML (see "Fixed" below). Full end-to-end runtime validation on GPU is
still pending; artifacts should land under
`e2e-pipeline-examples/<stage>/validation/` once each stage runs for real.

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

- [ ] **Stage 3 N1.6 vs N1.7.** Upstream `finetune_gr00t.py` defaults to
      `nvidia/GR00T-N1.7-3B`. This recipe uses `launch_finetune.py` (hardcoded
      N1.6 Eagle backbone) + `nvidia/GR00T-N1.6-3B` — self-consistent with the
      pinned commit, but diverges from the workshop's N1.7 intent.
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
