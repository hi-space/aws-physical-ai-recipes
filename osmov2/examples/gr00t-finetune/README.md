# GR00T Fine-Tune

PASK-aligned GR00T fine-tune workflow using NVIDIA `GR00T-N1.6-3B`, the upstream SO100 `cube_to_bowl_5` data path, and the pinned source ref in `versions.yaml`.

Files:

| File | Stack | Notes |
| --- | --- | --- |
| [workflow.yaml](workflow.yaml) | PyTorch 25.03 (Isaac Sim 4.5 era) | stable, validated |
| [workflow-g6.yaml](workflow-g6.yaml) | PyTorch 25.03, G6 L4 platform | G6 fallback |
| [workflow-5.1.yaml](workflow-5.1.yaml) | PyTorch 25.04 (Isaac Sim 5.1 era) | latest |

- [validation.md](validation.md): validation result, plots, replays, and run manifests.
- [validation/](validation/): retained validation artifacts.

Run the bounded E2E validation:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  SMOKE_SET_HF_CREDENTIAL=true \
  HF_TOKEN_FILE="$HOME/.huggingface/token" \
  WORKFLOW_FILE=examples/gr00t-finetune/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

Use `g7e.8xlarge` for the validated path because the workflow requests `cpu: 16`, `memory: 96Gi`, and `gpu: 1`.

For a longer quality-oriented run matching the SO-101 tutorial checkpoint scale:

```bash
osmo workflow submit examples/gr00t-finetune/workflow.yaml \
  --pool default \
  -t json \
  --set max_steps=10000 \
  --set save_steps=10000 \
  --set save_total_limit=1 \
  --set global_batch_size=1 \
  --set gpu_metrics_interval_seconds=10 \
  --set-string output_dataset=gr00t-finetune-10k-artifacts \
  --set-string retain_model_weights=true
```

The default workflow values are intentionally small because this repo uses them to validate OSMO execution, credentials, scheduling, artifact upload, and cleanup. They are not a full policy-quality benchmark.
