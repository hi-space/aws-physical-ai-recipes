#!/bin/bash
# Setup script for HyperPod workshop environment
# Run once on Head Node after first login

set -euo pipefail

echo "=== HyperPod Workshop Environment Setup ==="

# 0. Ensure git is installed
if ! command -v git &>/dev/null; then
  echo "Installing git..."
  sudo apt-get update -y -qq && sudo apt-get install -y -qq git 2>/dev/null || \
    sudo yum install -y git 2>/dev/null || true
fi

# 1. Clone the repo to FSx
if [ ! -d "/fsx/scratch/aws-physical-ai-recipes" ]; then
  git clone --depth 1 https://github.com/hi-space/aws-physical-ai-recipes.git /fsx/scratch/aws-physical-ai-recipes
  echo "✓ Repository cloned to /fsx/scratch/aws-physical-ai-recipes"
else
  cd /fsx/scratch/aws-physical-ai-recipes && git pull
  echo "✓ Repository updated"
fi

# 2. Pull GR00T N1.7 container
if [ ! -f "/fsx/scratch/nvidia+gr00t+gr00t-core+1.7.0.sqsh" ]; then
  echo "Pulling GR00T N1.7 container (this takes ~10 minutes)..."
  enroot import docker://nvcr.io/nvidia/gr00t/gr00t-core:1.7.0
  mv nvidia+gr00t+gr00t-core+1.7.0.sqsh /fsx/scratch/
  echo "✓ Container image ready"
else
  echo "✓ Container image already exists"
fi

# 3. Install Python dependencies on head node
pip install mlflow sagemaker-mlflow boto3 huggingface_hub pyarrow --quiet
echo "✓ Python packages installed"

# 4. Create directory structure
sudo mkdir -p /fsx/datasets/groot /fsx/checkpoints/vla /fsx/scratch/logs
sudo chmod 777 /fsx/datasets /fsx/checkpoints /fsx/scratch
echo "✓ Directory structure ready"

echo ""
echo "=== Setup Complete ==="
echo "Next steps:"
echo "  1. Download dataset: python /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/examples/vla/download_dataset.py"
echo "  2. Submit training: /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/run_vla.sh --model groot --dataset aloha"
