# GR00T VLA Fine-tuning

A collection of code for fine-tuning the NVIDIA GR00T Vision-Language-Action model on AWS SageMaker and organizing the resulting model in S3 so that IsaacSim can load it directly.

> 한국어 문서: [README.ko.md](README.ko.md)

## Overview

GR00T is a 3B-parameter Foundation Model that takes camera footage and a natural-language command ("pick up the orange") as input and directly controls the robot's joints. The code in this directory takes the GR00T base model, **fine-tunes it on your own robot dataset**, and **organizes the resulting model uncompressed in S3 so it can be loaded in IsaacSim with a single `aws s3 sync` on the DCV instance**.

The three directories connect in the following flow.

```
HF dataset ID → pipeline/ (TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel)
                   ├─→ s3://<bucket>/<model.s3_prefix>/<execution-id>/  (train.py exports directly from source)
                   │       └─→ S3 Files mount (/mnt/s3/groot) on the DCV instance → load in IsaacSim
                   └─→ Model Registry (registered as Approved if it passes SmokeGate)
```

## Prerequisites

The infrastructure must be deployed first before running this code. The CDK stack in [`../infra/groot/`](../infra/groot/) provides:

- ECR + CodeBuild to build the training container
- An S3 bucket to store model artifacts
- An IAM role with execution permissions
- An MLflow tracking server that tracks training curves and model versions

Once the deployment finishes, the infrastructure information is automatically populated into `config.yaml`, and every script in this directory uses those values as defaults.
If the `DeploymentProfile` output is `workshop-studio`, `update-config.ts` records `transform.instance_type` as `ml.g5.2xlarge` (the processing-job type allowed on Workshop Studio accounts).

Python 3.10+ and [`uv`](https://docs.astral.sh/uv/) are also required.

## Getting Started

### 1) Prepare the environment

```bash
cd e2e-workshop/groot
uv sync
source .venv/bin/activate
```

### 2) Check the container image

The training image (`groot-sm-training:latest`) is built automatically by CodeBuild (`groot-sm-training-build`) when the GrootFinetune stack is deployed (about 20–40 minutes because it includes flash-attn and other dependencies). Just confirm it is there:

```bash
aws ecr describe-images --repository-name groot-sm-training --query 'imageDetails[].imageTags'
```

Use the trigger script only when you edited `training/container/Dockerfile` and need a rebuild:

```bash
python training/scripts/trigger_build.py --type training
```

### 3) Upload the dataset

> **This step is unnecessary if you use the recommended path in 5) Pipeline** — the pipeline's TransformDataset step handles the HF download, conversion, validation, and staging for you. The steps below are for the one-shot CLI training in 4) or for local datasets.

The workshop default is the [`leisaac-pick-orange`](https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange) dataset, where an SO-101 robot picks up an orange.

```bash
python training/data/upload_dataset.py \
    --hf-dataset-id LightwheelAI/leisaac-pick-orange
```

If the dataset is in LeRobot v3 format, it is automatically converted to v2.1.

### 4) Start training

100 steps for a quick sanity check (10–15 minutes):

```bash
python training/scripts/run_training.py \
    --dataset-s3-uri s3://<bucket>/datasets/leisaac-pick-orange \
    --max-steps 100 --save-steps 50
```

The default instance is `ml.g5.12xlarge` (A10G 4-GPU). If you have a g6e quota, you can train faster with `--instance-type ml.g6e.12xlarge` (L40S 4-GPU). For a full training run, just increase the steps, e.g. `--max-steps 6000 --save-steps 2000`.

Training curves (loss/grad_norm/learning_rate, GPU utilization) are viewed in MLflow. The Training Job *Performance* tab in Studio only shows a table of the last value from `metric_definitions`; the time series is retained in CloudWatch (`/aws/sagemaker/TrainingJobs`).

### 5) Train + smoke gate + register model via Pipeline (recommended)

A 5-node pipeline that runs everything from data preparation to model registration in one go (TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel/FailStep). Just specify the HF dataset ID and TransformDataset handles the download, validation, and staging in place of the upload in 3); only models that pass SmokeGate are registered in the Model Registry as **Approved**.

```bash
./setup-notebooks.sh <region>            # Run once (prepares kernel, dependencies, and config.yaml)
```

Open [`notebooks/02_sagemaker_pipeline.ipynb`](./notebooks/02_sagemaker_pipeline.ipynb) in code-server and run the cells in order.

At the end, the training step uploads the uncompressed model directly to `s3://<bucket>/<model.s3_prefix>/<execution-id>/` (this always happens regardless of the SmokeGate result — see `pipeline/README.md`). Pull this prefix on the DCV instance with `aws s3 sync` to load it directly in IsaacSim. For more details, see [`pipeline/README.md`](./pipeline/README.md) and [`notebooks/README.md`](./notebooks/README.md).

### 6) Verify in simulation (optional)

To check whether the fine-tuned model actually performs the task inside the simulator, use the closed-loop evaluation (`run-isaaclab.sh`) in [`inference/`](./inference/).

## Project Structure

```
groot/
├── config.yaml          Configuration shared by all scripts (populated by CDK)
├── pyproject.toml       Single venv definition — one `uv sync` prepares the environment
├── setup-notebooks.sh   One-time setup script for the kernel/dependencies used to run notebooks
├── notebooks/           Workshop notebooks (05 infra/base check / 07 pipeline / 08 closed-loop evaluation)
├── training/            Model training
├── pipeline/            SageMaker Pipeline for data prep → training → smoke gate → model registration
└── inference/           Simulation closed-loop evaluation (ZMQ Policy Server)
    └── batch-zmq/
```

## Consuming Training Results

| Path | When to use it |
|--------|-----------|
| S3 Files mount → IsaacSim | The DCV instance mounts the artifacts bucket at `/mnt/s3/groot`, so the uncompressed prefix the training job uploaded appears in place and loads directly in IsaacSim (default path; `aws s3 sync` to local disk is the fallback) |
| [`inference/batch-zmq/`](./inference/batch-zmq/) | Quickly ping the GR00T Policy Server from the DCV instance to check it's alive. Can connect closed-loop with Isaac Sim |

## Custom Robot

The default scenario is SO-101, but to train on data from a different robot:

1. Prepare the dataset in LeRobot v2.1 format (including `meta/modality.json`)
2. Place `modality_config.py` at the dataset root and call `register_modality_config(..., embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)`
3. Train with `--embodiment-tag NEW_EMBODIMENT`

When using one of GR00T's built-in embodiments (`LIBERO_PANDA`, `OXE_DROID`, etc.), just specify `--embodiment-tag LIBERO_PANDA`.

## See Also

- [`notebooks/README.md`](./notebooks/README.md) — Guide for running the workshop notebooks
- [`training/README.md`](./training/README.md) — Training container and options
- [`pipeline/README.md`](./pipeline/README.md) — SageMaker Pipeline + uncompressed export
- [`inference/README.md`](./inference/README.md) — Simulation closed-loop evaluation
- [`../infra/groot/`](../infra/groot/) — The CDK infrastructure backing this code
