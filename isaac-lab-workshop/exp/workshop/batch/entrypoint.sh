#!/bin/bash
set -euo pipefail

echo "===== [$(date)] GR00T Batch Job Start ====="
echo "Node: $(hostname)"
echo "GPUs: $(nvidia-smi -L | wc -l)"

CHECKPOINT_DIR="${CHECKPOINT_DIR:-/efs/checkpoints/groot}"
mkdir -p "${CHECKPOINT_DIR}"
echo "Checkpoints → ${CHECKPOINT_DIR}"

if [ $# -gt 0 ]; then
    echo "Running: $@"
    exec "$@"
else
    echo "No command provided. Usage: entrypoint.sh <command> [args...]"
    exit 1
fi
