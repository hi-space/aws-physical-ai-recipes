#!/bin/bash
set -euo pipefail

# Isaac Lab RL Training wrapper
# Usage:
#   ./run_rl.sh --task Workshop-SO101-Reach-v0
#   ./run_rl.sh --task Workshop-SO101-Lift-v0 --iterations 500

TASK="Workshop-SO101-Reach-v0"
NUM_ENVS=""
MAX_ITERATIONS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --task) TASK="$2"; shift 2;;
    --envs) NUM_ENVS="$2"; shift 2;;
    --iterations) MAX_ITERATIONS="$2"; shift 2;;
    --help|-h) echo "Usage: $0 [--task TASK_ID] [--envs NUM] [--iterations NUM]"; exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

EXPORT_VARS="ALL,TASK=${TASK}"
[ -n "${NUM_ENVS}" ] && EXPORT_VARS="${EXPORT_VARS},NUM_ENVS=${NUM_ENVS}"
[ -n "${MAX_ITERATIONS}" ] && EXPORT_VARS="${EXPORT_VARS},MAX_ITERATIONS=${MAX_ITERATIONS}"

mkdir -p /fsx/scratch/logs

JOB_ID=$(sbatch --parsable --export="${EXPORT_VARS}" "${SCRIPT_DIR}/finetune_isaaclab.sbatch")

echo "=== Isaac Lab RL Training Submitted ==="
echo "  Task:       ${TASK}"
echo "  Job ID:     ${JOB_ID}"
echo ""
echo "  Monitor:    squeue -j ${JOB_ID}"
echo "  Logs:       /fsx/scratch/logs/isaaclab-${JOB_ID}.out"
echo "  Cancel:     scancel ${JOB_ID}"
