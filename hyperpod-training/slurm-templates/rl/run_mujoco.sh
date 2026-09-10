#!/bin/bash
set -euo pipefail

# MuJoCo (CPU) RL Training wrapper — appendix E3
# Usage:
#   ./run_mujoco.sh                                   # SO-101 Reach, 1M steps
#   ./run_mujoco.sh --steps 3000000                   # longer run
#   ./run_mujoco.sh --task InvertedPendulum-v5 --steps 100000   # Gymnasium smoke test

TASK="Workshop-SO101-Reach-MuJoCo-v0"
NUM_ENVS=""
TOTAL_STEPS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --task) TASK="$2"; shift 2;;
    --envs) NUM_ENVS="$2"; shift 2;;
    --steps) TOTAL_STEPS="$2"; shift 2;;
    --help|-h) echo "Usage: $0 [--task TASK_ID] [--envs NUM] [--steps NUM]"; exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

EXPORT_VARS="ALL,TASK=${TASK}"
[ -n "${NUM_ENVS}" ] && EXPORT_VARS="${EXPORT_VARS},NUM_ENVS=${NUM_ENVS}"
[ -n "${TOTAL_STEPS}" ] && EXPORT_VARS="${EXPORT_VARS},TOTAL_STEPS=${TOTAL_STEPS}"

mkdir -p /fsx/scratch/logs

JOB_ID=$(sbatch --parsable --export="${EXPORT_VARS}" "${SCRIPT_DIR}/train_mujoco.sbatch")

echo "=== MuJoCo RL Training Submitted (cpu partition) ==="
echo "  Task:       ${TASK}"
echo "  Job ID:     ${JOB_ID}"
echo ""
echo "  Monitor:    squeue -j ${JOB_ID}"
echo "  Logs:       /fsx/scratch/logs/mujoco-${JOB_ID}.out"
echo "  Cancel:     scancel ${JOB_ID}"
