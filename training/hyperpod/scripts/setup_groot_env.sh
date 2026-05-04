#!/bin/bash
# Setup GR00T training environment using uv virtual environment
# Run this on the head node (or compute node with GPU)
#
# This creates a self-contained venv at /fsx/envs/gr00t
# that is shared across all nodes via FSx.
#
# Usage:
#   bash setup_groot_env.sh
#
# After setup:
#   source /fsx/envs/gr00t/bin/activate
#   python -m gr00t.experiment.launch_finetune --help

set -e

export PATH="$HOME/.local/bin:$PATH"

ENVS_DIR="/fsx/envs"
GR00T_ENV="${ENVS_DIR}/gr00t"
GR00T_REPO="/fsx/scratch/Isaac-GR00T"

echo "=================================================="
echo "GR00T Training Environment Setup (uv venv)"
echo "=================================================="

# Step 0: Install system dependencies
echo "[0/4] Checking system dependencies..."
if ! command -v ffmpeg &>/dev/null || ! command -v git-lfs &>/dev/null; then
    sudo apt-get update -y -qq 2>/dev/null
    sudo apt-get install -y -qq ffmpeg git-lfs 2>/dev/null || true
    git lfs install 2>/dev/null || true
fi

# Step 1: Install uv if not available
if ! command -v uv &>/dev/null; then
    echo "[1/4] Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
else
    echo "[1/4] uv already installed"
fi

# Step 2: Clone Isaac-GR00T
echo "[2/4] Setting up Isaac-GR00T repository..."
if [ -d "${GR00T_REPO}" ]; then
    echo "  Repository exists, updating..."
    cd "${GR00T_REPO}" && git pull 2>/dev/null || true
else
    echo "  Cloning Isaac-GR00T..."
    git clone https://github.com/NVIDIA/Isaac-GR00T.git "${GR00T_REPO}"
fi

# Step 3: Create venv and install dependencies
echo "[3/4] Creating virtual environment at ${GR00T_ENV}..."
sudo mkdir -p "${ENVS_DIR}" && sudo chmod 777 "${ENVS_DIR}" 2>/dev/null || mkdir -p "${ENVS_DIR}"

if [ -d "${GR00T_ENV}" ]; then
    echo "  Environment exists. To recreate, run: rm -rf ${GR00T_ENV}"
else
    cd "${GR00T_REPO}"
    uv venv "${GR00T_ENV}" --python 3.10
    source "${GR00T_ENV}/bin/activate"

    echo "  Installing GR00T dependencies (this takes 5-10 minutes)..."
    uv pip install -e .
    uv pip install flash-attn --no-build-isolation 2>/dev/null || \
        echo "  WARNING: flash-attn install failed (needs GPU node). Will work without it."
    uv pip install bitsandbytes mlflow sagemaker-mlflow boto3

    deactivate
fi

# Step 4: Verify
echo "[4/4] Verifying installation..."
source "${GR00T_ENV}/bin/activate"
python -c "import gr00t; print(f'  GR00T version: {gr00t.__version__}')" 2>/dev/null || \
    python -c "import gr00t; print('  GR00T package OK')"

# Setup HuggingFace token if provided
if [ -n "${HF_TOKEN:-}" ]; then
    python -c "from huggingface_hub import HfApi; HfApi().set_access_token('${HF_TOKEN}')" 2>/dev/null || true
    echo "  HuggingFace token configured"
fi
deactivate

echo ""
echo "=================================================="
echo "Setup complete!"
echo ""
echo "Usage:"
echo "  source /fsx/envs/gr00t/bin/activate"
echo "  sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch"
echo "=================================================="
