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
01-data-prep ─▶ (lerobot dataset) ─▶ 03-vla-finetune
                     │
                     └▶ 06-cosmos-augment ─▶ (augmented lerobot dataset) ─▶ 03-vla-finetune
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

## Recommended GPU

This is the heaviest stage: it requests `cpu: 30`, `memory: 128Gi`, `gpu: 1`.
The recommended node is `g6e.12xlarge` (48 vCPU / 384GB) — the `cpu: 30` request
does not fit `g6e.8xlarge` (32 vCPU) once DaemonSet overhead is subtracted, so
this is the one stage that needs a larger g6e size. It still uses a single L40S
(48GB), but Cosmos is a diffusion workload that may OOM on 48GB at higher
resolutions / frame counts — see the g7e note below if that happens.

## Running

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.12xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos

# then point Stage 3 at the augmented dataset
osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset-cosmos \
  --set max_steps=10000 --set save_steps=10000

scripts/wait-gpu-node-cleanup.sh
```

Cosmos Transfer is a heavy diffusion workload — the `exec_timeout` is 3 days and
runtime scales with episode/frame count. Start with a small dataset.

### Runtime and the `num_steps` knob

Measured on a single L40S (`g6e.8xlarge`): one 774-frame episode is processed as
9 chunks × `num_steps` sampling steps, ≈ **80 min/episode at the default
`num_steps=35`** (≈ 8.5 min/chunk). Wall-clock is roughly linear in `num_steps`,
so the full 120-clip dataset at 35 steps (~160h) does **not** finish inside the
3-day `exec_timeout`. For time-boxed runs, trade fidelity for speed:

```bash
# ~half the time (some photorealism loss), lower resolution cuts per-chunk compute
osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos \
  --set num_steps=15 --set resolution=480
```

| `num_steps` | Approx. per-episode | Use |
| --- | --- | --- |
| `35` (default) | ~80 min | training-grade augmentation |
| `15` | ~35 min | fast iteration / functional checks |
| `10` | ~23 min | smoke runs |

For training-grade output on the full dataset, keep `num_steps=35` and instead run
an **episode subset**, parallelize across GPUs, or raise `exec_timeout`.

Cosmos may OOM on the default 48GB g6e card at higher resolutions / frame counts.
To run on the 96GB g7e (RTX PRO 6000, `g7e.12xlarge`) card instead, prewarm a g7e
node and add `--set platform=g7e-rtx-pro-6000` (the g7e NodePool is always
deployed, so no redeploy is needed):

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.12xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/06-cosmos-augment/workflow.yaml \
  --set platform=g7e-rtx-pro-6000 \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set output_dataset=e2e-pipeline-lerobot-dataset-cosmos
```

## Parameters (default-values)

| Parameter | Default | Description |
| --- | --- | --- |
| `input_dataset` | `e2e-pipeline-lerobot-dataset` | Stage 1 LeRobot dataset |
| `output_dataset` | `e2e-pipeline-lerobot-dataset-cosmos` | Augmented dataset name |
| `control_mode` | `edge` | Cosmos control hint (`edge` for RGB-only; `depth` if you add depth) |
| `prompt` | `A robot arm … photorealistic kitchen …` | Text prompt steering the augmentation |
| `num_steps` | `35` | Diffusion sampling steps — dominant runtime knob (wall-clock ~linear); lower for time-boxed runs (`15` ≈ half, `10` ≈ third) |
| `resolution` | `720` | Output resolution (`720` or `480`); `480` cuts per-chunk compute/VRAM at lower fidelity |
| `cosmos_transfer_ref` | `0033b77a…` | Pinned `cosmos-transfer2.5` commit (from `versions.yaml`) |
| `tokenizer_revision_from` / `tokenizer_revision_to` | `6787e176…` / `f176dc95…` | Cosmos Predict tokenizer revision patch |
| `cpu` / `memory` / `storage` | `30` / `128Gi` / `200Gi` | Pod resources |
| `platform` | `g6e-l40s` | OSMO GPU platform (g6e L40S, recommended `g6e.12xlarge` for the cpu:30 request; --set platform=g7e-rtx-pro-6000 for the 96GB `g7e.12xlarge`) |

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
replacement mirror Stage 3 / the nut-pouring Cosmos step).

### Verified against the pinned ref (2026-07-28)

Source-level audit against `cosmos-transfer2.5@0033b77a` (cloned the ref and
reproduced `inference.py` / `config.py` validation):

- [x] **Edge spec path.** `assets/robot_example/edge/robot_edge_spec.json` (the
      first `SPEC_TEMPLATE` candidate) exists at the pinned ref, so the workflow
      uses it and never hits the minimal fallback.
- [x] **Spec mutation fixed.** The shipped edge template carries
      `prompt_path: "../robot_prompt.txt"` and `edge.control_path: "robot_edge.mp4"`
      — both dangling relative paths once the spec is copied to `/tmp/cosmos_specs`.
      Cosmos validates them as `pydantic.FilePath` after `os.chdir(spec.parent)`,
      so the un-patched spec failed with two `path_not_file` errors (reproduced).
      The PYSPEC block now drops `prompt_path` (using an inline `prompt`) and
      clears every control key before setting `edge: {control_weight: 1.0}` with
      **no** `control_path`, so Cosmos derives the edge hint on-the-fly from the
      RGB frames (CannyEdge). The patched spec validates clean against the pinned
      schema.
- [x] **`inference.py -i/-o`** are valid tyro aliases (`input_files` / `output_dir`).

### GPU runtime validation (2026-07-28)

Ran on a single L40S (`g6e.8xlarge`, `--set cpu=16 memory=200Gi`). The first
episode completed end-to-end; the run was then cancelled after confirming output
(the full 120-clip dataset would exceed `exec_timeout` at `num_steps=35` — see the
runtime note above).

- [x] **Model load + diffusion.** All gated models (Cosmos-Transfer2.5-2B,
      Predict2.5-2B, Reason1-7B, Qwen2.5-VL-7B, Wan2.1 VAE) download and load; the
      guardrail import-time gated download is bypassed by the `core.py` patch +
      `--disable-guardrails`, and edge hints are computed online (no control file).
- [x] **Frame-count / fps re-alignment.** The augmented episode re-encodes to the
      source `nb_read_frames` + `r_frame_rate`: verified the output mp4 is **774
      frames @ 30fps, 640×480 — identical to the source**, so LeRobot per-episode
      indexing stays valid. The `tpad`-clone-then-`-frames:v` trim behaves as
      intended.
- [x] **Host RAM.** `num_steps` diffusion loads all 5 models simultaneously;
      `g6e.8xlarge` (256GB) is comfortable (~12GB used), but `g6e.2xlarge` (64GB)
      OOM-reboots the node at the diffusion step. Size the node for host RAM, not
      just the 48GB L40S.

- [ ] End-to-end: run Stage 3 on the augmented dataset and confirm it trains
      (still pending — only the augmentation step is runtime-verified).
