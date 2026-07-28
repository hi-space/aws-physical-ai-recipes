# Stage 1 — Data Prep

Download a LeRobot dataset from Hugging Face, auto-convert it from LeRobot v3 to
v2.1 if needed, validate it, and publish it as an OSMO dataset for the training
stage. Runs as a CPU-only OSMO task.

- OSMO input:  none (pulls from Hugging Face)
- OSMO output: `e2e-pipeline-lerobot-dataset` (consumed by Stage 3)

## Running

```bash
osmo workflow submit e2e-pipeline-examples/01-data-prep/workflow.yaml \
  --set hf_dataset_id=LightwheelAI/leisaac-pick-orange
```

This is CPU-only, so no GPU prewarm is needed.

## Parameters (default-values)

| Parameter | Default | Description |
| --- | --- | --- |
| `hf_dataset_id` | `LightwheelAI/leisaac-pick-orange` | Hugging Face dataset to download |
| `default_task` | `pick up the orange and place it on the plate` | Task/instruction string written into the dataset |
| `output_dataset` | `e2e-pipeline-lerobot-dataset` | OSMO output dataset name |
| `cpu` / `memory` / `storage` | `4` / `16Gi` / `12Gi` | Pod resources |

## What it does

1. Downloads the Hugging Face dataset.
2. Detects the LeRobot format version and, if it is v3, converts it to v2.1
   (the format GR00T fine-tuning expects). The conversion logic is embedded
   inline, reproduced function-for-function from
   `e2e-workshop/groot/training/data/convert_v3_to_v2.py`.
3. Writes a `meta/modality.json` at prep time so the published dataset is
   self-contained (upstream writes this at train time).
4. Validates the result and publishes it to the OSMO output dataset.

## Mapping to e2e-workshop

Adapts `groot/training/data/{upload_dataset,convert_v3_to_v2}.py`. The upstream
scripts write to S3; here the output goes to an OSMO dataset and the conversion
runs inline in the pod.
