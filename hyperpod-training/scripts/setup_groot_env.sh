#!/bin/bash
# Setup GR00T training environment using uv virtual environment
# Run this on the head node (or compute node with GPU)
#
# This creates a self-contained venv at /fsx/envs/gr00t
# that is shared across all nodes via FSx.
#
# Usage:
#   bash setup_groot_env.sh                    # Default: N1.6 (no HF token needed)
#   GROOT_VERSION=n1.7 HF_TOKEN=hf_xxx bash setup_groot_env.sh  # N1.7 (gated)
#
# After setup:
#   source /fsx/envs/gr00t/bin/activate
#   python -m gr00t.experiment.launch_finetune --help

set -e

export PATH="$HOME/.local/bin:$PATH"
export UV_CACHE_DIR="/fsx/scratch/.cache/uv"
# The venv's bin/python is an absolute symlink to the base interpreter, and uv
# keeps it absolute even with --relocatable. Left at the default
# (~/.local/share/uv/python) the interpreter lands on the setup pod's local
# filesystem, so the venv works inside that pod and breaks in every later one
# with "missing /fsx/envs/gr00t/bin/python". Keeping it on FSx makes the symlink
# resolve from any node that mounts /fsx.
export UV_PYTHON_INSTALL_DIR="/fsx/envs/.uv-python"
mkdir -p "${UV_CACHE_DIR}" "${UV_PYTHON_INSTALL_DIR}" 2>/dev/null || true

GROOT_VERSION="${GROOT_VERSION:-n1.6}"
# On a Slurm node the ubuntu user needs sudo to create root-owned /fsx paths.
# The EKS setup Job runs the same script as root in a container with no sudo
# binary, so resolve it instead of hardcoding it.
SUDO="$(command -v sudo || true)"
ENVS_DIR="/fsx/envs"
GR00T_ENV="${ENVS_DIR}/gr00t"
GR00T_REPO="/fsx/scratch/Isaac-GR00T"

echo "=================================================="
echo "GR00T Training Environment Setup (uv venv)"
echo "  Version: ${GROOT_VERSION}"
echo "=================================================="

# Resolve model name and repository ref from version.
#
# The ref must be pinned. `main` declares requires-python >=3.12,<3.13 while this
# venv is built with --python 3.10, so `uv pip install -e .` fails outright on a
# main checkout. Both release refs are tags (not branches) and pin Python 3.10
# with torch 2.7.1 / flash-attn 2.7.4.post1.
case "${GROOT_VERSION}" in
    n1.6)
        BASE_MODEL="nvidia/GR00T-N1.6-3B"
        GROOT_REF="n1.6-release"
        echo "  Model: ${BASE_MODEL} (open — no HF token required)"
        ;;
    n1.7)
        BASE_MODEL="nvidia/GR00T-N1.7-3B"
        GROOT_REF="n1.7-release"
        echo "  Model: ${BASE_MODEL} (gated — HF token required)"
        if [ -z "${HF_TOKEN:-}" ] && [ ! -f /fsx/scratch/.hf_token ]; then
            echo ""
            echo "  WARNING: HF_TOKEN not set and /fsx/scratch/.hf_token not found."
            echo "  N1.7 is a gated model. You need:"
            echo "    1. Request access: https://huggingface.co/nvidia/GR00T-N1.7-3B"
            echo "    2. Request access: https://huggingface.co/nvidia/Cosmos-Reason2-2B"
            echo "    3. Set token: export HF_TOKEN=hf_xxx"
            echo ""
        fi
        ;;
    *)
        echo "ERROR: Unknown GROOT_VERSION='${GROOT_VERSION}'. Use 'n1.6' or 'n1.7'."
        exit 1
        ;;
esac

# Step 0: Install system dependencies
echo "[0/4] Checking system dependencies..."
if ! command -v ffmpeg &>/dev/null || ! command -v git-lfs &>/dev/null; then
    # Keep stderr visible. Suppressing it here once turned a missing `sudo` into a
    # bare exit 127 with nothing to go on.
    ${SUDO} apt-get update -y -qq || echo "  WARN: apt-get update failed, continuing"
    ${SUDO} apt-get install -y -qq ffmpeg git-lfs || echo "  WARN: apt-get install failed, continuing"
    git lfs install || echo "  WARN: git lfs install failed, continuing"
fi

# Step 1: Install uv if not available
if ! command -v uv &>/dev/null; then
    echo "[1/4] Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
else
    echo "[1/4] uv already installed"
fi

# Step 2: Clone Isaac-GR00T at the pinned release ref
echo "[2/4] Setting up Isaac-GR00T repository (ref ${GROOT_REF})..."
if [ -d "${GR00T_REPO}/.git" ]; then
    echo "  Repository exists, moving to ${GROOT_REF}..."
    cd "${GR00T_REPO}"
    git fetch --depth 1 origin "refs/tags/${GROOT_REF}"
    # -f discards tracked-file edits, which is how a tree previously cloned from
    # main gets corrected. The fine-tune patches live in tracked files and are
    # re-applied by scripts/patch_groot_repo.py at every launch, so losing them
    # here is intended. Downloaded weights are untracked and survive.
    git checkout -f -B "${GROOT_REF}" FETCH_HEAD
else
    echo "  Cloning Isaac-GR00T..."
    git clone --depth 1 -b "${GROOT_REF}" https://github.com/NVIDIA/Isaac-GR00T.git "${GR00T_REPO}"
fi
echo "  HEAD: $(cd "${GR00T_REPO}" && git rev-parse --short HEAD) (${GROOT_REF})"

# Step 3: Create venv and install dependencies
echo "[3/4] Creating virtual environment at ${GR00T_ENV}..."
${SUDO} mkdir -p "${ENVS_DIR}" && ${SUDO} chmod 777 "${ENVS_DIR}" 2>/dev/null || mkdir -p "${ENVS_DIR}"

if [ -d "${GR00T_ENV}" ]; then
    echo "  Environment exists. To recreate, run: rm -rf ${GR00T_ENV}"
else
    cd "${GR00T_REPO}"
    uv venv "${GR00T_ENV}" --python 3.10
    source "${GR00T_ENV}/bin/activate"

    echo "  Installing GR00T dependencies (this takes 5-10 minutes)..."
    # flash-attn is a hard dependency of the release refs, pinned in
    # [tool.uv.sources] to a prebuilt cp310 cu12/torch2.7 wheel URL. So this one
    # command installs it with no CUDA toolchain and no compile step; installing
    # it separately would resolve a different build and break the pin.
    uv pip install -e .
    # mlflow / tensorboard are what HF Trainer's reporting callbacks import.
    # patch_groot_repo.py puts both into report_to, gated on being importable,
    # so installing them here is what turns fine-tune metrics on. Verified to
    # add only absl-py, grpcio, markdown, tensorboard-data-server alongside
    # tensorboard — no torch/numpy/protobuf movement, so the release pins hold.
    uv pip install bitsandbytes mlflow sagemaker-mlflow boto3 tensorboard

    deactivate
fi

# Step 4: Verify
echo "[4/4] Verifying installation..."
source "${GR00T_ENV}/bin/activate"
python -c "import gr00t; print(f'  GR00T version: {gr00t.__version__}')" 2>/dev/null || \
    python -c "import gr00t; print('  GR00T package OK')"

# Setup HuggingFace token if provided (only needed for N1.7)
if [ "${GROOT_VERSION}" = "n1.7" ] && [ -n "${HF_TOKEN:-}" ]; then
    python -c "from huggingface_hub import HfApi; HfApi().set_access_token('${HF_TOKEN}')" 2>/dev/null || true
    echo "  HuggingFace token configured"
fi
deactivate

echo ""
echo "=================================================="
echo "Setup complete! (GR00T ${GROOT_VERSION})"
echo ""
echo "Usage:"
echo "  source /fsx/envs/gr00t/bin/activate"
if [ "${GROOT_VERSION}" = "n1.7" ]; then
    echo "  export GROOT_VERSION=n1.7"
    echo "  HF_TOKEN=hf_xxx sbatch /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/slurm-templates/vla/finetune_groot_venv.sbatch"
else
    echo "  sbatch /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/slurm-templates/vla/finetune_groot_venv.sbatch"
fi
echo "=================================================="
