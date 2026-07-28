# Stage 3 — GR00T VLA Fine-tune

Fine-tune a GR00T Vision-Language-Action policy on the LeRobot dataset produced
by Stage 1, using the workshop SO-101 modality config. Runs as a single-pod OSMO
task on a g6e (NVIDIA L40S, 48GB) node by default.

- OSMO input:  `e2e-pipeline-lerobot-dataset` (from Stage 1)
- OSMO output: `e2e-pipeline-groot-checkpoint` (consumed by Stage 4 / exported to S3 for Stage 5)

## Two training paths: N1.6 (default) vs N1.7 (optional)

The workshop ships two GR00T fine-tune modules. This stage provides both; pick
one.

| | `workflow.yaml` (default) | `workflow-n1.7.yaml` (optional) |
| --- | --- | --- |
| GR00T version | N1.6 | N1.7 |
| Base model | `nvidia/GR00T-N1.6-3B` | `nvidia/GR00T-N1.7-3B` |
| Backbone | Eagle (`nvidia/Eagle-Block2A-2B-v2`) | Cosmos-Reason2-2B (**gated**) |
| Training entry | `launch_finetune.py` | `finetune_gr00t.py` (`experiment.run()`) |
| `Isaac-GR00T` ref | `ead52833…` | `23ace64f…` |
| `HF_TOKEN` | not required | **required** (gated backbone) |
| Output dataset | `e2e-pipeline-groot-checkpoint` | `e2e-pipeline-groot-checkpoint-n17` |

N1.6 is the default because it is easier to reproduce — no gated backbone and no
HF access needed. N1.7 mirrors the workshop's main fine-tuning module
(`e2e-workshop/infra/groot`), which targets N1.7 via the `experiment.run()` API;
use it when you specifically want to match that intent.

### N1.7 requires a Hugging Face token

The N1.7 backbone `nvidia/Cosmos-Reason2-2B` is a gated Hugging Face repo. Get
access on the model page, then pass a token with the workflow so the pod can
download it. The workflow errors out early if `HF_TOKEN` is missing.

### N1.7 chaining caveat (Stage 4)

Stage 4 (`04-closeloop`) currently pins the **N1.6** server ref
(`gr00t_ref=e8e625f4…`) and `--policy_type gr00tn1.6`. An N1.7 checkpoint needs
an N1.7-compatible policy server/client, so you must override Stage 4 before
chaining an N1.7 checkpoint into closed-loop eval. The default N1.6 path chains
into Stage 4 with no changes.

## Recommended GPU

This VLA fine-tune requests `cpu: 16`, `memory: 96Gi`, `gpu: 1`. One L40S (48GB)
fits the default N1.6 3B model at `global_batch_size: 1`. The recommended node is
`g6e.8xlarge` (32 vCPU / 256GB) — after DaemonSet overhead, a 16-vCPU node
(`g6e.4xlarge`) does not leave a clean 16 allocatable vCPUs, so the pod lands on
the next size up. For N1.7 or a larger `global_batch_size` that risks OOM on
48GB, use the 96GB `g7e.8xlarge` (see below).

## Running

GPU stages need visible g6e capacity before OSMO validation:

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.8xlarge scripts/prewarm-gpu-node.sh

# N1.6 (default)
osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000

# N1.7 (optional) — needs HF_TOKEN for the gated Cosmos-Reason2-2B backbone
osmo workflow submit e2e-pipeline-examples/03-training/workflow-n1.7.yaml \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=6000 --set save_steps=2000

scripts/wait-gpu-node-cleanup.sh
```

To run on the 96GB g7e (RTX PRO 6000, `g7e.8xlarge`) card instead — e.g. for a
larger `global_batch_size`, or when N1.7's gated backbone risks OOM on 48GB —
prewarm a g7e node and add `--set platform=g7e-rtx-pro-6000` (the g7e NodePool is
always deployed, so no redeploy is needed):

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set platform=g7e-rtx-pro-6000 \
  --set input_dataset=e2e-pipeline-lerobot-dataset \
  --set max_steps=10000 --set save_steps=10000
```

The default `max_steps`/`save_steps` (10/10) are smoke values — a training run
that just proves the pipeline works. Scale up (the numbers above, or the
workshop's ~6000) for a policy-quality checkpoint.

## Parameters (default-values)

| Parameter | N1.6 default | N1.7 default | Description |
| --- | --- | --- | --- |
| `input_dataset` | `e2e-pipeline-lerobot-dataset` | same | Stage 1 output dataset |
| `output_dataset` | `e2e-pipeline-groot-checkpoint` | `…-checkpoint-n17` | Checkpoint dataset |
| `base_model_path` | `nvidia/GR00T-N1.6-3B` | `nvidia/GR00T-N1.7-3B` | HF base model |
| `gr00t_ref` | `ead52833…` | `23ace64f…` | `Isaac-GR00T` commit |
| `embodiment_tag` | `NEW_EMBODIMENT` | same | Must match the modality config |
| `max_steps` / `save_steps` | `10` / `10` | `10` / `10` | Smoke defaults; raise for real runs |
| `global_batch_size` | `1` | `1` | Increase with more GPU memory |
| `learning_rate` | `1e-4` | `1e-4` | |
| `platform` | `g6e-l40s` | same | OSMO GPU platform (g6e L40S, recommended `g6e.8xlarge`; --set platform=g7e-rtx-pro-6000 for the 96GB `g7e.8xlarge`) |

## Outputs

- `artifacts/` — the trained checkpoint (HF-format), copied to the output dataset
- `artifacts/gpu-metrics/` — `nvidia-smi` samples + a utilization plot
- `artifacts/run-manifest.json` — model, version, training API, runtime

## Mapping to e2e-workshop

- N1.6 default reproduces `launch_finetune.py` (which hardcodes
  `use_relative_action = True`) with the SO-101 modality config from
  `groot/training/data/configs/so101_modality_config.py`.
- N1.7 optional inlines a single-pod port of
  `infra/groot/assets/finetune_gr00t.py`: the `experiment.run()` API plus its
  in-place dataset patching (modality.json annotation key, parquet
  `task_description` column, `stats.json`). The upstream EFS/S3/HF-upload and
  multi-node Batch orchestration are dropped — OSMO handles dataset I/O and this
  runs on one pod / one GPU.
