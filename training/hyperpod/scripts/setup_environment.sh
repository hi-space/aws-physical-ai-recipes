#!/bin/bash
# Setup script for HyperPod workshop environment
# Run once on Head Node after first login
#
# This script:
#   1. Clones the recipes repository to FSx (shared across all nodes)
#   2. Builds GR00T training container and imports to Enroot
#   3. Installs head-node Python dependencies
#   4. Creates directory structure on FSx
#
# Prerequisites:
#   - FSx mounted at /fsx
#   - Docker and Enroot available
#   - AWS CLI configured (for ECR access)

set -euo pipefail

echo "=== HyperPod Workshop Environment Setup ==="

REPO_DIR="/fsx/scratch/aws-physical-ai-recipes"
CONTAINER_PATH="/fsx/enroot/data/gr00t-train+latest.sqsh"

# 0. Ensure git is installed
if ! command -v git &>/dev/null; then
  echo "Installing git..."
  sudo apt-get update -y -qq && sudo apt-get install -y -qq git 2>/dev/null || \
    sudo yum install -y git 2>/dev/null || true
fi

# 1. Clone the repo to FSx
echo "[1/4] Setting up repository..."
if [ ! -d "${REPO_DIR}" ]; then
  git clone --depth 1 https://github.com/hi-space/aws-physical-ai-recipes.git "${REPO_DIR}"
  echo "  Repository cloned to ${REPO_DIR}"
else
  cd "${REPO_DIR}" && git pull
  echo "  Repository updated"
fi

# 2. Import GR00T container from ECR
echo "[2/4] Setting up GR00T training container..."
if [ -f "${CONTAINER_PATH}" ]; then
  echo "  Container already exists at ${CONTAINER_PATH}"
else
  # Docker is NOT available on HyperPod nodes.
  # Container must be pre-built and pushed to ECR externally.
  # This step imports directly from ECR using enroot.
  AWS_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "us-west-2")
  AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/gr00t-train:latest"

  echo "  Importing container from ECR: ${ECR_URI}"
  echo "  (Container must be pre-built externally with: bash container/build_and_push_ecr.sh)"

  mkdir -p /fsx/enroot/data /fsx/enroot/tmp
  export ENROOT_CACHE_PATH=/fsx/enroot
  export ENROOT_DATA_PATH=/fsx/enroot/data
  export TMPDIR=/fsx/enroot/tmp

  # Authenticate enroot to ECR
  aws ecr get-login-password --region "${AWS_REGION}" | \
    enroot import --output "${CONTAINER_PATH}" "docker://${ECR_URI}" 2>&1 || {
      echo "  ERROR: Container import failed."
      echo "  Ensure the container image exists in ECR."
      echo "  Build it externally: bash container/build_and_push_ecr.sh"
      exit 1
    }
  echo "  Container ready at ${CONTAINER_PATH}"
fi

# 3. Install Python dependencies on head node
echo "[3/4] Installing head-node dependencies..."
pip install mlflow sagemaker-mlflow boto3 huggingface_hub pyarrow --quiet
echo "  Python packages installed"

# 4. Create directory structure
echo "[4/4] Creating directory structure..."
mkdir -p /fsx/datasets/groot /fsx/checkpoints/vla /fsx/scratch/logs /fsx/enroot/data
chmod 777 /fsx/datasets /fsx/checkpoints /fsx/scratch /fsx/enroot 2>/dev/null || true
echo "  Directories ready"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Download dataset:"
echo "     python ${REPO_DIR}/training/hyperpod/examples/vla/download_dataset.py"
echo "  2. Submit training:"
echo "     sbatch ${REPO_DIR}/training/hyperpod/slurm-templates/vla/finetune_groot.sbatch"
