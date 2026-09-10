#!/bin/bash
#SBATCH --job-name=mujoco-rl
#SBATCH --partition=cpu
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --time=2:00:00
#SBATCH --output=/fsx/scratch/logs/mujoco-%j.out
#SBATCH --error=/fsx/scratch/logs/mujoco-%j.err

# SO-101 Reach RL training in MuJoCo on a HyperPod CPU node (appendix A4)
#
# --partition=cpu: HyperPod adds every compute node to the universal `dev` partition and,
# for the CPU groups (cpu-c5-4x / cpu-c5-9x / cpu-m5-4x), also to `cpu`. Submitting to
# `cpu` guarantees the job never lands on an idle GPU node.
#
# Prerequisites:
#   - scripts/setup_mujoco_env.sh has been run once (venv at /fsx/envs/mujoco, SO-101 MJCF on FSx)
#   - A CPU node is up: ./scripts/scale-cluster.sh cpu-c5-4x 1 --wait
#
# Usage:
#   sbatch train_mujoco.sbatch
#   TOTAL_STEPS=3000000 sbatch train_mujoco.sbatch
#   TASK=InvertedPendulum-v5 TOTAL_STEPS=100000 sbatch train_mujoco.sbatch   # quick Gymnasium smoke test
#
# Environment Variables:
#   TASK: Gymnasium task ID (default: Workshop-SO101-Reach-MuJoCo-v0)
#   NUM_ENVS: parallel environment processes (default: all vCPUs of the node)
#   TOTAL_STEPS: total environment steps (default: 1000000, ~5 min on ml.c5.4xlarge)
#   LOG_DIR: output root (default: /fsx/checkpoints/rl → <LOG_DIR>/reach-mujoco/SO101_Reach)
#   CHECKPOINT: resume from a model .zip (optional)

set -e

TASK="${TASK:-Workshop-SO101-Reach-MuJoCo-v0}"
NUM_ENVS="${NUM_ENVS:-0}"
TOTAL_STEPS="${TOTAL_STEPS:-1000000}"
LOG_DIR="${LOG_DIR:-/fsx/checkpoints/rl}"
CHECKPOINT="${CHECKPOINT:-}"

VENV_DIR="${VENV_DIR:-/fsx/envs/mujoco}"
SCRIPT_DIR="/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl"
export MUJOCO_MENAGERIE_DIR="${MUJOCO_MENAGERIE_DIR:-/fsx/scratch/mujoco_menagerie}"

echo "=================================================="
echo "MuJoCo RL Training Job (CPU)"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: ${SLURM_NODELIST} ($(nproc) vCPUs)"
echo "Task: ${TASK}"
echo "Envs: ${NUM_ENVS} (0 = one per vCPU)"
echo "Total steps: ${TOTAL_STEPS}"
echo "Log Dir: ${LOG_DIR}"
echo "Start: $(date)"
echo "=================================================="

if [ ! -x "${VENV_DIR}/bin/python" ]; then
    echo "ERROR: venv not found at ${VENV_DIR}."
    echo "  Run once on the head node: bash ${SCRIPT_DIR%/examples/rl}/scripts/setup_mujoco_env.sh"
    exit 1
fi

mkdir -p "${LOG_DIR}" /fsx/scratch/logs
source "${VENV_DIR}/bin/activate"
export PYTHONUNBUFFERED=1
# One MuJoCo process per env: keep BLAS from oversubscribing the cores.
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1

CHECKPOINT_ARG=""
[ -n "${CHECKPOINT}" ] && CHECKPOINT_ARG="--checkpoint ${CHECKPOINT}"

EXIT_CODE=0
python "${SCRIPT_DIR}/train_mujoco.py" \
    --task "${TASK}" \
    --num_envs "${NUM_ENVS}" \
    --total_steps "${TOTAL_STEPS}" \
    --log_dir "${LOG_DIR}" \
    ${CHECKPOINT_ARG} || EXIT_CODE=$?

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
