#!/bin/bash
#SBATCH --job-name=isaaclab-rl
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:1
#SBATCH --time=2:00:00
#SBATCH --output=/fsx/scratch/logs/isaaclab-%j.out
#SBATCH --error=/fsx/scratch/logs/isaaclab-%j.err

# Isaac Lab RL Training on HyperPod (headless, container-based)
#
# Prerequisites:
#   - Run setup_isaaclab_env.sh first to import container and prepare tasks
#   - Isaac Lab container at: /fsx/enroot/data/isaaclab+latest.sqsh
#   - Workshop task package at: /fsx/scratch/isaaclab-workshop/src
#   - mkdir -p /fsx/scratch/logs
#
# Usage:
#   sbatch finetune_isaaclab.sbatch
#   TASK=Workshop-SO101-Lift-v0 MAX_ITERATIONS=500 sbatch finetune_isaaclab.sbatch
#
# Environment Variables:
#   TASK: Isaac Lab task ID (default: Workshop-SO101-Reach-v0)
#   NUM_ENVS: Parallel environments (default: 2048)
#   MAX_ITERATIONS: Training iterations (default: 300, ~15-20 min)
#   LOG_DIR: Output directory (default: /fsx/checkpoints/rl)
#   CHECKPOINT: Resume from path (optional)

set -e

TASK="${TASK:-Workshop-SO101-Reach-v0}"
NUM_ENVS="${NUM_ENVS:-2048}"
MAX_ITERATIONS="${MAX_ITERATIONS:-300}"
LOG_DIR="${LOG_DIR:-/fsx/checkpoints/rl}"
CHECKPOINT="${CHECKPOINT:-}"

CONTAINER_IMAGE="${CONTAINER_IMAGE:-/fsx/enroot/data/isaaclab+latest.sqsh}"
WORKSHOP_PKG="/fsx/scratch/isaaclab-workshop/src"
SCRIPT_DIR="/fsx/scratch/aws-physical-ai-recipes/training/hyperpod/examples/rl"

echo "=================================================="
echo "Isaac Lab RL Training Job"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: ${SLURM_NODELIST}"
echo "Task: ${TASK}"
echo "Envs: ${NUM_ENVS}"
echo "Iterations: ${MAX_ITERATIONS}"
echo "Log Dir: ${LOG_DIR}"
echo "Start: $(date)"
echo "=================================================="

mkdir -p "${LOG_DIR}" /fsx/scratch/logs

# If container exists, use it
if [ -f "${CONTAINER_IMAGE}" ]; then
    echo "Using container: ${CONTAINER_IMAGE}"
    CHECKPOINT_ARG=""
    [ -n "${CHECKPOINT}" ] && CHECKPOINT_ARG="--checkpoint ${CHECKPOINT}"

    srun --container-image="${CONTAINER_IMAGE}" \
        --container-mounts="/fsx:/fsx" \
        --container-env="ACCEPT_EULA=Y,PRIVACY_CONSENT=Y,PYTHONPATH=${WORKSHOP_PKG}" \
        python "${SCRIPT_DIR}/train_isaaclab.py" \
            --task "${TASK}" \
            --num_envs "${NUM_ENVS}" \
            --max_iterations "${MAX_ITERATIONS}" \
            --log_dir "${LOG_DIR}" \
            ${CHECKPOINT_ARG} \
            --headless
else
    # Fallback: use venv if Isaac Lab is installed
    echo "Container not found. Attempting venv mode..."
    ISAACLAB_ENV="/fsx/envs/isaaclab"

    if [ ! -d "${ISAACLAB_ENV}" ]; then
        echo "ERROR: Neither container (${CONTAINER_IMAGE}) nor venv (${ISAACLAB_ENV}) found."
        echo "  Option A: Import Isaac Lab container:"
        echo "    enroot import docker://nvcr.io#nvidia/isaac-sim:4.5.0"
        echo "  Option B: Install Isaac Lab in venv (requires CUDA):"
        echo "    See isaac-lab-workshop/README.md"
        exit 1
    fi

    source "${ISAACLAB_ENV}/bin/activate"

    CHECKPOINT_ARG=""
    [ -n "${CHECKPOINT}" ] && CHECKPOINT_ARG="--checkpoint ${CHECKPOINT}"

    python "${SCRIPT_DIR}/train_isaaclab.py" \
        --task "${TASK}" \
        --num_envs "${NUM_ENVS}" \
        --max_iterations "${MAX_ITERATIONS}" \
        --log_dir "${LOG_DIR}" \
        ${CHECKPOINT_ARG} \
        --headless
fi

EXIT_CODE=$?

echo ""
echo "=================================================="
if [ ${EXIT_CODE} -eq 0 ]; then
    echo "RL Training completed successfully"
    echo "Checkpoints: ${LOG_DIR}/"
else
    echo "RL Training failed with exit code: ${EXIT_CODE}"
fi
echo "End: $(date)"
echo "=================================================="

exit ${EXIT_CODE}
