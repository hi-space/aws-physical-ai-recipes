# Physical AI End-to-End on AWS

A collection of recipes for running the **whole robot AI model lifecycle — training, deployment, and evaluation** — on AWS. Train a reinforcement learning policy (RL Policy) for a humanoid robot with NVIDIA Isaac Lab, fine-tune a Vision-Language-Action (VLA) model that understands natural language with NVIDIA GR00T, and verify it by actually moving the robot in a simulation environment.

> 한국어 문서: [README.ko.md](README.ko.md)

> A step-by-step hands-on guide is provided as a separate document → **[Physical AI on AWS — End-to-End Workshop](https://hi-space.gitbook.io/physical-ai-on-aws/guide/e2e-workshop)**

## Overview

Training AI with a real robot takes millions of trial-and-error attempts. Doing that with an actual robot is costly in time, money, and safety. The **Sim-to-Real** approach that leverages simulation is the standard, but setting up GPU infrastructure yourself, standing up a distributed training cluster, and deploying a model to an inference environment is still a heavy lift.

This repository bundles that infrastructure and the training/inference code so you can bring it all up with a single command. AWS CDK automatically deploys a GPU instance (DCV), and the SageMaker training environment is layered on top when the stage needs it. The GR00T training container and inference endpoint are also provided in a standardized form.

Two training tracks are covered.

| Track | Description | Output |
|------|------|--------|
| **RL Policy** (Isaac Lab) | Train a humanoid robot to walk over rough terrain with PPO. Simulates 2,048 virtual robots at once on a single GPU | `.pt` checkpoint |
| **VLA Foundation Model** (GR00T) | Fine-tune a 3B-parameter model that takes camera footage + natural-language commands and directly generates robot joint commands, on a custom dataset | A fine-tuned model exported to S3 (pulled with `aws s3 sync` and loaded in IsaacSim) |

Both tracks share the same underlying infrastructure (VPC · GPU EC2).

## Features

- **One-click deployment** — CDK creates the VPC and GPU EC2 (DCV) in one shot. ECR·SageMaker Studio·MLflow are deployed additionally for whichever track needs them. Shared FSx for Lustre is optional (`-c enableFsx=true`)
- **One-account-per-person model** — stack and resource identifiers automatically use the account ID, so names are always deterministic with no extra arguments
- **Automatic fallback** — if an AZ lacks capacity for the GPU instance, a Lambda automatically detects it and deploys to an available one instead
- **MLOps integration** — a single-step SageMaker Pipeline in which the training job uploads the unpacked model straight to S3 from the source at the end; model versions and metrics are tracked in MLflow
- **Consuming uncompressed exports** — pull the exported S3 prefix with `aws s3 sync` and load it directly in IsaacSim (EC2) without untarring
- **Fleet monitoring** — a Next.js dashboard that shows the Rerun 3D viewer and TensorBoard for distributed training workers on one screen

## Prerequisites

- AWS account (administrator or equivalent permissions)
- GPU instance service quota — check the G6/G5 vCPU limit in the deployment region
- Node.js 18+, AWS CDK CLI
- Python 3.10+ (for the GR00T training scripts — `uv` recommended)

CloudShell is the most convenient option since it comes with almost all of the above already set up.

## Getting Started

### 1) Deploy the IsaacLab infrastructure

```bash
git clone https://github.com/hi-space/aws-physical-ai-recipes.git
cd aws-physical-ai-recipes/e2e-workshop/infra/isaaclab
npm install

cdk deploy -c region=us-east-1

# Workshop Studio event account (no EC2 GPU): CPU workstation + SageMaker/HyperPod modules only
cdk deploy -c region=us-east-1 -c profile=workshop-studio
```

The deployment profiles are `personal` (default, GPU workstation) and `workshop-studio` (CPU workstation, us-east-1/us-west-2). Specify the same value across all three stacks (IsaacLab · GrootFinetune · HyperPod).

The stack name becomes `IsaacLab-Latest-<ACCOUNT_ID>`, suffixed with the target account ID (assuming one account per person).

Deployment takes about 35–45 minutes. Most of that time is spent inside the GPU instance pulling the Isaac Sim image (about 20GB), building Isaac Lab, and installing the desktop environment. Once it finishes, connect via the printed `DcvUrl` to use the GPU desktop.

### 2) RL training — humanoid locomotion with Isaac Lab

From the DCV desktop:

```bash
docker run --shm-size=60g --gpus all --rm -it --network=host \
  -e ACCEPT_EULA=Y -e PRIVACY_CONSENT=Y -e DISPLAY \
  isaaclab-batch:latest bash

# Inside the container
cd /workspace/IsaacLab
./isaaclab.sh -p scripts/reinforcement_learning/skrl/train.py \
  --task Isaac-Velocity-Rough-H1-v0 --num_envs 2048 --headless
```

### 3) VLA training — GR00T fine-tuning

```bash
# Deploy the additional GR00T infrastructure
cd ../../infra/groot
npm install
npm run deploy                        # Single stack: GrootFinetune-<ACCOUNT_ID>

# Training code environment
cd ../../groot
uv sync && source .venv/bin/activate
npx --prefix ../infra/groot ts-node ../infra/groot/bin/update-config.ts \
    --region us-east-1

# Training + uncompressed export (Pipeline) — run via notebook
./setup-notebooks.sh   # Run once (prepares kernel and dependencies)
# Open notebooks/02_sagemaker_pipeline.ipynb in code-server and run the cells in order
```

Once complete, an uncompressed model is produced at `s3://<bucket>/<model.s3_prefix>/<execution-id>/`. Pull this prefix on the DCV instance with `aws s3 sync` and load it in IsaacSim.

## Project Structure

```
e2e-workshop/
├── infra/
│   ├── isaaclab/              IsaacLab CDK stack (GPU EC2 + DCV, optional shared FSx)
│   └── groot/                 GR00T VLA CDK single stack (ECR + CodeBuild + SageMaker + MLflow)
├── groot/                     GR00T training code (uv venv)
│   ├── training/              SageMaker training container + trigger scripts
│   ├── pipeline/              Training → uncompressed export automation Pipeline
│   └── inference/
│       └── batch-zmq/         GR00T Policy Server ZMQ ping client
├── apps/
│   └── mlops-dashboard/       RL Fleet monitoring dashboard (Next.js)
├── scripts/

└── assets/                    Screenshots
```

Each subdirectory has its own README with more detailed usage and options.

## Workshop Modules

The [workshop guide](https://hi-space.gitbook.io/physical-ai-on-aws/guide/e2e-workshop) walks through this codebase module by module.

| Module | What it covers | Directories mainly used |
|------|-------------|------------------------|
| 1. Infrastructure check and environment access | Access the pre-deployed GPU desktop (DCV) · code-server | `infra/isaaclab/` |
| 2. Deploy the Greengrass base model | Deploy the GR00T base model as a Greengrass component in simulation | `infra/groot/` |
| 3. VLA infrastructure | Verify the ECR + SageMaker for GR00T, validate base-model inference | `infra/groot/`, `groot/inference/batch-zmq/` · notebook: `groot/notebooks/01_infra_and_base_check.ipynb` |
| 4. SageMaker pipeline | GR00T fine-tuning + uncompressed export automation | `groot/training/`, `groot/pipeline/` · notebook: `groot/notebooks/02_sagemaker_pipeline.ipynb` |
| 5. Closed-loop evaluation | Evaluate the fine-tuned model in simulation with LeIsaac | `groot/inference/run-isaaclab.sh` · notebook: `groot/notebooks/03_closed_loop_eval.ipynb` |
| 6. Greengrass edge deployment | Deploy the fine-tuned model to the edge (TensorRT) | `infra/groot/` |
| 7-10. RL track | Isaac Lab single-node RL → HyperPod distributed training → policy verification | `infra/isaaclab/assets/workshop/`, `../hyperpod-training/` |
| 11. Resource cleanup | Clean up all stacks | — |

## License

This project's license follows the LICENSE file at the repository root. External models/datasets used (NVIDIA GR00T, Isaac Lab, Cosmos-Reason2-2B, leisaac-pick-orange, etc.) follow their own respective licenses.

## References

- [NVIDIA Isaac Lab](https://isaac-sim.github.io/IsaacLab/)
- [NVIDIA GR00T Foundation Model](https://developer.nvidia.com/gr00t)
- [Isaac-GR00T (GitHub)](https://github.com/NVIDIA/Isaac-GR00T)
- [LeIsaac — Closed-loop Evaluation Framework](https://github.com/LightwheelAI/leisaac)
