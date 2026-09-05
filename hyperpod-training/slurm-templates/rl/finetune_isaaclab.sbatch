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
#   - Isaac Lab container (nvcr.io/nvidia/isaac-lab, Isaac Sim 5.x + Isaac Lab 2.3 + rsl_rl)
#     at: /fsx/enroot/data/isaaclab+latest.sqsh
#   - Workshop task package at: /fsx/scratch/isaaclab-workshop/src
#   - mkdir -p /fsx/scratch/logs
#
# Usage:
#   sbatch finetune_isaaclab.sbatch
#   TASK=Workshop-SO101-Lift-v0 MAX_ITERATIONS=500 sbatch finetune_isaaclab.sbatch
#   MLFLOW_TRACKING_URI=<arn from Module 7 cdk deploy output> sbatch finetune_isaaclab.sbatch
#
# Environment Variables:
#   TASK: Isaac Lab task ID (default: Workshop-SO101-Reach-v0)
#   NUM_ENVS: Parallel environments (default: 2048)
#   MAX_ITERATIONS: Training iterations (default: 300, ~15-20 min)
#   LOG_DIR: Output directory (default: /fsx/checkpoints/rl)
#   CHECKPOINT: Resume from path (optional)
#   MLFLOW_TRACKING_URI: SageMaker Managed MLflow tracking server ARN (optional;
#     enables experiment tracking. No-op if unset.)
#   MLFLOW_EXPERIMENT_NAME: MLflow experiment name (default: isaaclab-rl)

set -e

TASK="${TASK:-Workshop-SO101-Reach-v0}"
NUM_ENVS="${NUM_ENVS:-2048}"
MAX_ITERATIONS="${MAX_ITERATIONS:-300}"
LOG_DIR="${LOG_DIR:-/fsx/checkpoints/rl}"
CHECKPOINT="${CHECKPOINT:-}"

CONTAINER_IMAGE="${CONTAINER_IMAGE:-/fsx/enroot/data/isaaclab+latest.sqsh}"
WORKSHOP_PKG="/fsx/scratch/isaaclab-workshop/src"
SCRIPT_DIR="/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl"

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

# If container exists, use it via enroot
if [ -f "${CONTAINER_IMAGE}" ]; then
    echo "Using container: ${CONTAINER_IMAGE}"
    CHECKPOINT_ARG=""
    [ -n "${CHECKPOINT}" ] && CHECKPOINT_ARG="--checkpoint ${CHECKPOINT}"

    CONTAINER_NAME="isaaclab"

    # Create container from sqsh once (reuse across jobs, requires sudo)
    if ! enroot list | grep -q "^${CONTAINER_NAME}$"; then
        echo "Creating container rootfs (first time only, ~5-10 min on FSx)..."
        sudo enroot create --name "${CONTAINER_NAME}" "${CONTAINER_IMAGE}"
    fi

    # Patch entrypoint to pass through commands (default runs runheadless.sh).
    # The rootfs lives under ENROOT_DATA_PATH; `enroot list -f` prints NAME/PID/COMM of running
    # instances (not a path), so it must not be parsed for this.
    ROOTFS_PATH="${ENROOT_DATA_PATH:-/fsx/enroot/data}/${CONTAINER_NAME}"
    sudo tee "${ROOTFS_PATH}/etc/rc" > /dev/null << 'RCEOF'
mkdir -p "/isaac-sim" 2> /dev/null
cd "/isaac-sim" && unset OLDPWD || exit 1
export CARB_APP_PATH=/isaac-sim/kit
export ISAAC_PATH=/isaac-sim
export EXP_PATH=/isaac-sim/apps
export ISAAC_SIM_PATH=/isaac-sim
export PATH=/isaac-sim/kit/python/bin:/isaac-sim:$PATH
export LD_LIBRARY_PATH=/isaac-sim/kit/python/lib:/isaac-sim/kit/libs:$LD_LIBRARY_PATH
export LD_PRELOAD=/isaac-sim/kit/libcarb.so
source /isaac-sim/setup_python_env.sh
if [ -s /etc/rc.local ]; then . /etc/rc.local; fi
if [ $# -gt 0 ]; then exec "$@"; else exec /bin/sh -c /isaac-sim/runheadless.sh; fi
RCEOF

    # The isaac-lab image ships isaaclab / isaaclab_rl / rsl_rl. Only the MLflow
    # tracking packages used by train_isaaclab.py may be missing (uses chroot to
    # avoid the slow entrypoint). numpy is pinned <2: Isaac Sim's compiled extensions
    # are built against numpy 1.26 and fail to import if pip upgrades it.
    if ! sudo chroot "${ROOTFS_PATH}" /bin/bash -c \
        "LD_LIBRARY_PATH=/isaac-sim/kit/python/lib /isaac-sim/kit/python/bin/python3 -c 'import importlib.metadata as m; m.version(\"rsl-rl-lib\"); m.version(\"mlflow\"); m.version(\"sagemaker-mlflow\")' 2>/dev/null"; then
        echo "Installing MLflow packages into container..."
        sudo cp /etc/resolv.conf "${ROOTFS_PATH}/etc/resolv.conf"
        sudo chroot "${ROOTFS_PATH}" /bin/bash -c \
            "export LD_LIBRARY_PATH=/isaac-sim/kit/python/lib:/isaac-sim/kit/libs && \
             /isaac-sim/kit/python/bin/python3 -m pip install --no-cache-dir \
             'numpy<2' mlflow sagemaker-mlflow 2>&1 | tail -3"
        echo "MLflow packages installed."
    fi

    # The trainer runs as root inside the enroot container (sudo), outside the cgroup Slurm
    # tracks for this job, so `scancel` alone leaves it running on the GPU. Run it in the
    # background and forward SIGTERM/SIGINT ourselves; `wait` is interruptible so the trap fires.
    TRAIN_MATCH="train_isaaclab.py --task ${TASK} --num_envs ${NUM_ENVS} --max_iterations ${MAX_ITERATIONS} --log_dir ${LOG_DIR}"
    _stop_container() {
        echo "[finetune_isaaclab] job signalled — stopping the container process"
        sudo pkill -TERM -f "${TRAIN_MATCH}" 2>/dev/null || true
        sleep 15
        sudo pkill -KILL -f "${TRAIN_MATCH}" 2>/dev/null || true
        exit 143
    }
    trap _stop_container TERM INT
    sudo enroot start --root \
        --rw \
        --mount /fsx:/fsx \
        --env ACCEPT_EULA=Y \
        --env PRIVACY_CONSENT=Y \
        --env PYTHONPATH="${WORKSHOP_PKG}" \
        --env PYTHONUNBUFFERED=1 \
        --env NVIDIA_VISIBLE_DEVICES=all \
        --env NVIDIA_DRIVER_CAPABILITIES=all \
        --env GIT_PYTHON_REFRESH=quiet \
        --env MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:-}" \
        --env MLFLOW_EXPERIMENT_NAME="${MLFLOW_EXPERIMENT_NAME:-isaaclab-rl}" \
        "${CONTAINER_NAME}" \
        /isaac-sim/kit/python/bin/python3 "${SCRIPT_DIR}/train_isaaclab.py" \
            --task "${TASK}" \
            --num_envs "${NUM_ENVS}" \
            --max_iterations "${MAX_ITERATIONS}" \
            --log_dir "${LOG_DIR}" \
            ${CHECKPOINT_ARG} \
            --headless &
    EXIT_CODE=0
    wait $! || EXIT_CODE=$?   # `|| ...` keeps `set -e` from exiting before the status is recorded
    trap - TERM INT
else
    # Fallback: use venv if Isaac Lab is installed
    echo "Container not found. Attempting venv mode..."
    ISAACLAB_ENV="/fsx/envs/isaaclab"

    if [ ! -d "${ISAACLAB_ENV}" ]; then
        echo "ERROR: Neither container (${CONTAINER_IMAGE}) nor venv (${ISAACLAB_ENV}) found."
        echo "  Option A: Import Isaac Lab container:"
        echo "    bash /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/scripts/setup_isaaclab_env.sh"
        echo "  Option B: Install Isaac Lab in venv (requires CUDA):"
        echo "    See isaac-lab-workshop/README.md"
        exit 1
    fi

    source "${ISAACLAB_ENV}/bin/activate"
    export PYTHONUNBUFFERED=1

    CHECKPOINT_ARG=""
    [ -n "${CHECKPOINT}" ] && CHECKPOINT_ARG="--checkpoint ${CHECKPOINT}"

    python "${SCRIPT_DIR}/train_isaaclab.py" \
        --task "${TASK}" \
        --num_envs "${NUM_ENVS}" \
        --max_iterations "${MAX_ITERATIONS}" \
        --log_dir "${LOG_DIR}" \
        ${CHECKPOINT_ARG} \
        --headless
    EXIT_CODE=$?
fi

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
