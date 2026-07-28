# Stage 6 — Cosmos Transfer 2.5 Visual Augmentation (optional)

Photorealistically augment the Stage 1 LeRobot dataset with
[Cosmos Transfer 2.5](https://github.com/nvidia-cosmos/cosmos-transfer2.5), then
feed the augmented dataset into Stage 3 fine-tuning. This is an **optional middle
step** — the default chain is Stage 1 → Stage 3; insert this stage only when you
want domain-randomized / photorealistic training frames to narrow the sim-to-real
gap.

- OSMO input:  `e2e-pipeline-lerobot-dataset` (from Stage 1)
- OSMO output: `e2e-pipeline-lerobot-dataset-cosmos`

## Where it fits in the chain

```
01-data-prep ─▶ (lerobot dataset) ─▶ 03-training
                     │
                     └▶ 06-cosmos-augment ─▶ (augmented lerobot dataset) ─▶ 03-training
```

Each per-episode camera mp4 in the LeRobot layout
(`videos/chunk-XXX/<video_key>/episode_XXXXXX.mp4`) is re-rendered through Cosmos
Transfer and written back **in place** at the same relative path, so the output
is a drop-in LeRobot dataset. Stage 3 consumes it with nothing changed but
`--set input_dataset=…`.

## Edge control (RGB-only)

nut-pouring's Cosmos step (`examples/nut-pouring-pipeline`) uses **depth**
control, but that pipeline generates its videos from MimicGen sim and has depth
mp4s to condition on. The e2e Stage 1 dataset is real teleoperation LeRobot data
(`front`/`wrist` RGB, **no depth**), so this stage uses **edge** control: Cosmos
derives an edge/structure hint from the RGB frames themselves, needing no extra
depth-generation step. If you later add a depth pass, switch with
`--set control_mode=depth`.

## Running

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos

# then point Stage 3 at the augmented dataset
osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset-cosmos \
  --set max_steps=10000 --set save_steps=10000

scripts/wait-gpu-node-cleanup.sh
```

Cosmos Transfer is a heavy diffusion workload — the `exec_timeout` is 3 days and
runtime scales with episode/frame count. Start with a small dataset.

## Parameters (default-values)

| Parameter | Default | Description |
| --- | --- | --- |
| `input_dataset` | `e2e-pipeline-lerobot-dataset` | Stage 1 LeRobot dataset |
| `output_dataset` | `e2e-pipeline-lerobot-dataset-cosmos` | Augmented dataset name |
| `control_mode` | `edge` | Cosmos control hint (`edge` for RGB-only; `depth` if you add depth) |
| `prompt` | `A robot arm … photorealistic kitchen …` | Text prompt steering the augmentation |
| `cosmos_transfer_ref` | `0033b77a…` | Pinned `cosmos-transfer2.5` commit (from `versions.yaml`) |
| `tokenizer_revision_from` / `tokenizer_revision_to` | `6787e176…` / `f176dc95…` | Cosmos Predict tokenizer revision patch |
| `cpu` / `memory` / `storage` | `30` / `128Gi` / `200Gi` | Pod resources |
| `platform` | `g7e-rtx-pro-6000` | OSMO GPU platform |

## Outputs

- `artifacts/dataset/` — the augmented LeRobot dataset (same layout as Stage 1)
- `artifacts/augmentation-manifest.json` — control mode, videos augmented, source
  codebase version / episode count / fps

## Mapping to nut-pouring

This stage adapts `examples/nut-pouring-pipeline/workflows/03_cosmos_augmentation.yaml`
(same pinned `cosmos-transfer2.5` ref + tokenizer patch, same
`cosmos-predict2-container:1.2` image) to the e2e LeRobot layout, with two
differences: it operates on the LeRobot `videos/…/episode_*.mp4` per-episode
files (not flat `demo_*_robot_pov_cam.mp4`), and it uses **edge** control instead
of depth because the leisaac dataset has no depth videos.

## Verify at runtime

This stage's source-level shape is correct (LeRobot discovery + in-place mp4
replacement mirror Stage 3 / the nut-pouring Cosmos step), but the following are
**pending GPU runtime validation**:

- [ ] The exact Cosmos Transfer 2.5 **edge** spec asset path/schema at the pinned
      ref. The workflow probes a few candidate spec templates and falls back to a
      minimal edge spec; confirm against the pinned repo's `assets/robot_example`
      and adjust `SPEC_TEMPLATE` if needed.
- [ ] Frame-count / fps re-alignment: the augmented clip is re-encoded to the
      source `nb_read_frames` + `r_frame_rate` so LeRobot per-episode indexing
      stays valid. Verify Cosmos preserves (or the re-encode restores) frame count
      so `meta/episodes.jsonl` lengths still match.
- [ ] End-to-end: run Stage 3 on the augmented dataset and confirm it trains.
