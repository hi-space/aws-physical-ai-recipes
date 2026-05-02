#!/bin/bash
#SBATCH --job-name=pi0-finetune
#SBATCH --partition=train
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --cpus-per-gpu=12
#SBATCH --time=48:00:00
#SBATCH --output=/fsx/scratch/logs/pi0-%j.out
#SBATCH --error=/fsx/scratch/logs/pi0-%j.err

# π0 Fine-tuning (PyTorch DDP)

DATASET="${DATASET:-bridge_v2}"
EPOCHS="${EPOCHS:-100}"
BATCH_SIZE="${BATCH_SIZE:-16}"
LR="${LR:-5e-5}"
EXPERIMENT="${EXPERIMENT:-pi0-${DATASET}-$(date +%Y%m%d-%H%M%S)}"
MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:?Set MLflow tracking URI}"
CHECKPOINT_DIR="/fsx/checkpoints/vla/${EXPERIMENT}"

export MLFLOW_TRACKING_URI

mkdir -p "${CHECKPOINT_DIR}" /fsx/scratch/logs

srun --container-image=docker://ghcr.io/physical-intelligence/openpi:latest \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       /fsx/scratch/train_pi0.py \
       --dataset-path "/fsx/datasets/pi0/${DATASET}" \
       --output-dir "${CHECKPOINT_DIR}" \
       --epochs "${EPOCHS}" \
       --batch-size "${BATCH_SIZE}" \
       --lr "${LR}" \
       --experiment "${EXPERIMENT}"
