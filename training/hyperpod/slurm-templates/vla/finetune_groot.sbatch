#!/bin/bash
#SBATCH --job-name=groot-finetune
#SBATCH --partition=train
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --cpus-per-gpu=12
#SBATCH --time=24:00:00
#SBATCH --output=/fsx/scratch/logs/groot-%j.out
#SBATCH --error=/fsx/scratch/logs/groot-%j.err

# GR00T-N1.6-3B Fine-tuning (PyTorch DDP)

DATASET="${DATASET:-aloha}"
EPOCHS="${EPOCHS:-50}"
BATCH_SIZE="${BATCH_SIZE:-32}"
LR="${LR:-1e-4}"
EXPERIMENT="${EXPERIMENT:-groot-${DATASET}-$(date +%Y%m%d-%H%M%S)}"
MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:?Set MLflow tracking URI}"
CHECKPOINT_DIR="/fsx/checkpoints/vla/${EXPERIMENT}"

export MLFLOW_TRACKING_URI

mkdir -p "${CHECKPOINT_DIR}" /fsx/scratch/logs

srun --container-image=nvcr.io/nvidia/gr00t:1.6.0 \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       /fsx/scratch/train_groot.py \
       --dataset-path "/fsx/datasets/groot/${DATASET}" \
       --output-dir "${CHECKPOINT_DIR}" \
       --epochs "${EPOCHS}" \
       --batch-size "${BATCH_SIZE}" \
       --lr "${LR}" \
       --experiment "${EXPERIMENT}"
