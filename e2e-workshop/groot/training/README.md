# GR00T Training

Code for fine-tuning the NVIDIA GR00T VLA model as a SageMaker Training Job. Covers defining the training Docker image, preparing the dataset, and launching training via a SageMaker Estimator.

> 한국어 문서: [README.ko.md](README.ko.md)

## Overview

Handles three main tasks.

1. **Build the training image** — Build the Dockerfile in `container/` with CodeBuild and push to ECR
2. **Prepare the dataset** — Organize a HuggingFace dataset or local data into LeRobot v2.1 format and upload to S3
3. **Run training** — Launch and monitor a SageMaker Training Job

## Project Structure

```
training/
├── container/    Code that builds the training Docker image (built by CodeBuild)
│   ├── Dockerfile
│   ├── buildspec.yml
│   ├── train.py            Training entrypoint invoked by SageMaker
│   └── sitecustomize.py    Monkey-patch that forces MLflow logging on
├── data/         Dataset upload/conversion utilities and SO-101 modality examples
│   ├── upload_dataset.py
│   ├── convert_v3_to_v2.py
│   ├── download_model.py
│   └── configs/            so101_modality.json, so101_modality_config.py
├── scripts/      Scripts to trigger training and image build
│   ├── trigger_build.py
│   ├── run_training.py
│   └── build_local.sh
└── tests/
```

## Getting Started

Assumes the parent [`groot/`](../) environment is already set up (`uv sync` complete, `config.yaml` filled in).

### Build the container

Starts the CodeBuild project and waits for the build to finish.

```bash
python training/scripts/trigger_build.py --type training     # build the training image
python training/scripts/trigger_build.py --type training --groot-version n1.7
```

Pushed to ECR under three tags: `latest`, the version (`n1.6`/`n1.7`), and the commit hash.

### Upload the dataset

```bash
python training/data/upload_dataset.py \
    --hf-dataset-id LightwheelAI/leisaac-pick-orange
# or a local dataset
python training/data/upload_dataset.py \
    --local-path ./my-dataset --prefix datasets/my-robot
```

### Run training

The default instance is `ml.g5.12xlarge` (A10G, 4 GPUs). If you have g6e quota, `--instance-type ml.g6e.12xlarge` (L40S, 4 GPUs) also works.

Quick validation (100 steps):

```bash
python training/scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 100 --save-steps 50
```

Full training run:

```bash
python training/scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 6000 --save-steps 2000
```

To run lightly on a single GPU, add `--instance-type ml.g5.2xlarge --num-gpus 1`.

## Configuration

Every argument to `run_training.py` reads its default from the parent `config.yaml`, and CLI options take precedence.

| Option | Description |
|------|------|
| `--dataset-s3-uri` | Path to the dataset already uploaded to S3 |
| `--hf-dataset-id` | For downloading directly from HF (skips the S3 upload) |
| `--hf-token` | For gated datasets/models. Can also be an SSM reference like `ssm:/groot/hf-token` |
| `--max-steps`, `--save-steps` | Number of training steps and checkpoint interval |
| `--instance-type`, `--num-gpus` | Instance type and GPU count |
| `--global-batch-size` | Global batch size |
| `--use-spot` / `--no-spot` | Whether to use Spot Instances |
| `--groot-version` | `n1.6` or `n1.7` |
| `--embodiment-tag` | Defaults to `NEW_EMBODIMENT`. For a GR00T built-in embodiment, e.g. `LIBERO_PANDA` |

## Training Container

| File | Role |
|------|------|
| `Dockerfile` | Defines the training image. Installs Python 3.10, Isaac-GR00T, transformers, and MLflow on an `nvcr.io/nvidia/pytorch` base |
| `buildspec.yml` | The procedure CodeBuild uses to build the above Dockerfile and push it to ECR |
| `train.py` | Training entrypoint invoked by SageMaker. Parses SageMaker env vars, runs Isaac-GR00T's `launch_finetune.py`, and saves the resulting model to `SM_MODEL_DIR` |
| `sitecustomize.py` | Monkey-patch that forces MLflow logging on. Works around GR00T hardcoding `report_to` so that the HF Trainer's MLflow callback doesn't get auto-registered, and renames the run to `MLFLOW_RUN_NAME` (= the Training Job name) |
| `requirements.txt` | pip-installed by the sagemaker-training toolkit at container startup (no image rebuild needed). Includes `nvidia-ml-py` for MLflow GPU system metrics |

## Monitoring

`run_training.py` and `pipeline/build_pipeline.py` inject the same definitions (`GR00T_METRIC_DEFINITIONS`, `mlflow_container_env`) into the Estimator.

- **CloudWatch metric** — Parses the dict logs the HF Trainer prints to stdout (`{'loss': ..., 'grad_norm': ..., 'learning_rate': ...}`) with a regex and publishes them as `train:loss`, `train:grad_norm`, `train:learning_rate` (these three are the entirety of the keys GR00T's `Gr00tTrainer` emits — `epoch` is hidden and there's no eval step). The Training Job *Performance* tab in Studio shows only the last value in a table; view the time-series graphs in CloudWatch (`/aws/sagemaker/TrainingJobs`, `TrainingJobName` dimension)
- **MLflow** — `MLFLOW_TRACKING_URI`/`MLFLOW_EXPERIMENT_NAME`/`MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING` are auto-configured on the container. Run name = the Training Job name, per-step loss/grad_norm/learning_rate + `system/` GPU/CPU/memory/disk/network time series, the full TrainingArguments as params, and tags like `sagemaker.checkpoint_s3_uri`/`sagemaker.export_s3_uri`. Checkpoint files are not copied as MLflow artifacts (only the S3 path is tagged) — setting `HF_MLFLOW_LOG_ARTIFACTS=true` would duplicate tens of GB (including optimizer state) into the artifact store on every save_steps

Access the MLflow UI via a URL issued with:

```bash
aws sagemaker create-presigned-mlflow-tracking-server-url \
    --tracking-server-name groot-mlflow-<ACCOUNT_ID> \
    --query AuthorizedUrl --output text
```

Stop it when not in use to save cost:

```bash
aws sagemaker stop-mlflow-tracking-server --tracking-server-name groot-mlflow-<ACCOUNT_ID>
```

## Custom Robot

The default scenario is SO-101 + `leisaac-pick-orange`, but to train on other data:

1. Build the dataset in LeRobot v2.1 format, including `meta/modality.json`
2. Place a `modality_config.py` at the dataset root and call `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)`
3. Upload with `python training/data/upload_dataset.py --local-path ./my-dataset --prefix datasets/my-robot`
4. Train with `--dataset-s3-uri s3://.../my-robot --embodiment-tag NEW_EMBODIMENT`

For a GR00T built-in embodiment, only `meta/modality.json` is needed.

## See Also

- Fully automates data prep → training → smoke gate → model registration in one shot: [`../pipeline/`](../pipeline/)
- Simulation closed-loop evaluation: [`../inference/`](../inference/)
- Infrastructure definitions: [`../../infra/groot/`](../../infra/groot/)
