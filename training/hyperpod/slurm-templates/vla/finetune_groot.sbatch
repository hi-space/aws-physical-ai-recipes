#!/bin/bash
#SBATCH --job-name=groot-n1.7-finetune
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=4
#SBATCH --gres=gpu:4
#SBATCH --time=4:00:00
#SBATCH --output=/fsx/scratch/logs/groot-%j.out
#SBATCH --error=/fsx/scratch/logs/groot-%j.err

# GR00T-N1.7 Fine-tuning via Isaac-GR00T official pipeline
# Container: nvcr.io/nvidia/gr00t/gr00t-core:1.7.0 (includes gr00t package)

DATASET="${DATASET:-aloha}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-aloha}"
DATA_CONFIG="${DATA_CONFIG:-default}"
MAX_STEPS="${MAX_STEPS:-5000}"
BATCH_SIZE="${BATCH_SIZE:-32}"
LR="${LR:-2e-5}"
SAVE_STEPS="${SAVE_STEPS:-500}"
STATE_DROPOUT="${STATE_DROPOUT:-0.3}"
EXPERIMENT="${EXPERIMENT:-groot-n1.7-${DATASET}-$(date +%Y%m%d-%H%M%S)}"
MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:-}"
CHECKPOINT_DIR="/fsx/checkpoints/vla/${EXPERIMENT}"
GPUS_PER_NODE=4
CONTAINER_IMAGE="/fsx/scratch/nvidia+gr00t+gr00t-core+1.7.0.sqsh"
SCRIPTS_DIR="/fsx/scratch/aws-physical-ai-recipes/training/hyperpod"

export MLFLOW_TRACKING_URI
export WANDB_DISABLED=true

mkdir -p "${CHECKPOINT_DIR}" /fsx/scratch/logs

srun --container-image="${CONTAINER_IMAGE}" \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=${GPUS_PER_NODE} \
       "${SCRIPTS_DIR}/examples/vla/train_groot.py" \
       --dataset-path "/fsx/datasets/groot/${DATASET}" \
       --embodiment-tag "${EMBODIMENT_TAG}" \
       --data-config "${DATA_CONFIG}" \
       --output-dir "${CHECKPOINT_DIR}" \
       --max-steps "${MAX_STEPS}" \
       --batch-size "${BATCH_SIZE}" \
       --learning-rate "${LR}" \
       --save-steps "${SAVE_STEPS}" \
       --state-dropout "${STATE_DROPOUT}" \
       --experiment "${EXPERIMENT}"
