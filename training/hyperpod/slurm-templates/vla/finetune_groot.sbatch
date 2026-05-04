#!/bin/bash
#SBATCH --job-name=groot-finetune
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:1
#SBATCH --time=4:00:00
#SBATCH --output=/fsx/scratch/logs/groot-%j.out
#SBATCH --error=/fsx/scratch/logs/groot-%j.err

# GR00T Fine-tuning via Isaac-GR00T launch_finetune.py
# Container: Custom built via container/build_and_push_ecr.sh + import_container.sh
#
# Prerequisites:
#   - Container imported at /fsx/enroot/data/gr00t-train+latest.sqsh
#   - Dataset prepared at /fsx/datasets/groot/<DATASET>
#   - mkdir -p /fsx/scratch/logs
#
# Usage:
#   sbatch finetune_groot.sbatch
#   NUM_GPUS=4 DATASET=aloha sbatch finetune_groot.sbatch
#
# Environment Variables:
#   NUM_GPUS: Number of GPUs (default: 1)
#   DATASET: Dataset name under /fsx/datasets/groot/ (default: demo_data)
#   DATASET_PATH: Full dataset path, overrides DATASET (default: computed from DATASET)
#   EMBODIMENT_TAG: Robot embodiment tag (default: oxe_droid_relative_eef_relative_joint)
#   MODALITY_CONFIG: Modality config path inside container (default: gr00t/modality_config.py)
#   BASE_MODEL: Base model path (default: nvidia/GR00T-N1.7-3B)
#   MAX_STEPS: Training steps (default: 2000)
#   SAVE_STEPS: Save every N steps (default: 2000)
#   GLOBAL_BATCH_SIZE: Global batch size (default: 2)
#   OUTPUT_DIR: Checkpoint output (default: /fsx/checkpoints/vla/groot-<DATASET>)

set -e

NUM_GPUS="${NUM_GPUS:-1}"
DATASET="${DATASET:-demo_data}"
DATASET_PATH="${DATASET_PATH:-/fsx/datasets/groot/${DATASET}}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-oxe_droid_relative_eef_relative_joint}"
MODALITY_CONFIG="${MODALITY_CONFIG:-gr00t/modality_config.py}"
BASE_MODEL="${BASE_MODEL:-nvidia/GR00T-N1.7-3B}"
MAX_STEPS="${MAX_STEPS:-2000}"
SAVE_STEPS="${SAVE_STEPS:-2000}"
SAVE_TOTAL_LIMIT="${SAVE_TOTAL_LIMIT:-5}"
GLOBAL_BATCH_SIZE="${GLOBAL_BATCH_SIZE:-2}"
OUTPUT_DIR="${OUTPUT_DIR:-/fsx/checkpoints/vla/groot-${DATASET}}"
DATALOADER_NUM_WORKERS="${DATALOADER_NUM_WORKERS:-2}"

CONTAINER_IMAGE="/fsx/enroot/data/gr00t-train+latest.sqsh"
GR00T_HOME="/workspace/gr00t"

echo "=================================================="
echo "GR00T Fine-tuning Job"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: ${SLURM_NODELIST}"
echo "Container: ${CONTAINER_IMAGE}"
echo "Base Model: ${BASE_MODEL}"
echo "Dataset: ${DATASET_PATH}"
echo "Output: ${OUTPUT_DIR}"
echo "GPUs: ${NUM_GPUS}"
echo "Max Steps: ${MAX_STEPS}"
echo "Batch Size: ${GLOBAL_BATCH_SIZE}"
echo "Start: $(date)"
echo "=================================================="

if [ ! -f "${CONTAINER_IMAGE}" ]; then
    echo "ERROR: Container image not found at ${CONTAINER_IMAGE}"
    echo "Run: bash container/import_container.sh"
    exit 1
fi

mkdir -p "${OUTPUT_DIR}" /fsx/scratch/logs

srun --container-image="${CONTAINER_IMAGE}" \
    --container-mounts="/fsx:/fsx" \
    --container-workdir="${GR00T_HOME}" \
    "${GR00T_HOME}/.venv/bin/python" \
    gr00t/experiment/launch_finetune.py \
    --base-model-path "${BASE_MODEL}" \
    --dataset-path "${DATASET_PATH}" \
    --embodiment-tag "${EMBODIMENT_TAG}" \
    --num-gpus "${NUM_GPUS}" \
    --output-dir "${OUTPUT_DIR}" \
    --save-total-limit "${SAVE_TOTAL_LIMIT}" \
    --save-steps "${SAVE_STEPS}" \
    --max-steps "${MAX_STEPS}" \
    --no-use-wandb \
    --global-batch-size "${GLOBAL_BATCH_SIZE}" \
    --dataloader-num-workers "${DATALOADER_NUM_WORKERS}"

EXIT_CODE=$?

echo ""
echo "=================================================="
if [ ${EXIT_CODE} -eq 0 ]; then
    echo "Fine-tuning completed successfully"
else
    echo "Fine-tuning failed with exit code: ${EXIT_CODE}"
fi
echo "End: $(date)"
echo "=================================================="

exit ${EXIT_CODE}
