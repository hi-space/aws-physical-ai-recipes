#!/bin/bash
set -euo pipefail

# VLA 학습 실행 래퍼
# Usage: ./run_vla.sh --model groot --dataset aloha --epochs 50

MODEL="groot"
DATASET=""
EPOCHS=""
NODES=1

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL="$2"; shift 2;;
    --dataset) DATASET="$2"; shift 2;;
    --epochs) EPOCHS="$2"; shift 2;;
    --nodes) NODES="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

if [ -z "$DATASET" ]; then
  echo "Usage: ./run_vla.sh --model [groot|pi0] --dataset <name> [--epochs N] [--nodes N]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case $MODEL in
  groot) SBATCH_FILE="${SCRIPT_DIR}/finetune_groot.sbatch";;
  pi0)   SBATCH_FILE="${SCRIPT_DIR}/finetune_pi0.sbatch";;
  *)     echo "Unknown model: ${MODEL}. Use 'groot' or 'pi0'"; exit 1;;
esac

EXPORT_VARS="ALL,DATASET=${DATASET}"
[ -n "$EPOCHS" ] && EXPORT_VARS="${EXPORT_VARS},EPOCHS=${EPOCHS}"

JOB_ID=$(sbatch --parsable --nodes=${NODES} --export="${EXPORT_VARS}" "${SBATCH_FILE}")

echo "=== VLA Training Submitted ==="
echo "  Model:    ${MODEL}"
echo "  Dataset:  ${DATASET}"
echo "  Nodes:    ${NODES}"
echo "  Job ID:   ${JOB_ID}"
echo ""
echo "  Monitor:  squeue -j ${JOB_ID}"
echo "  Logs:     /fsx/scratch/logs/${MODEL}-${JOB_ID}.out"
echo "  Cancel:   scancel ${JOB_ID}"
