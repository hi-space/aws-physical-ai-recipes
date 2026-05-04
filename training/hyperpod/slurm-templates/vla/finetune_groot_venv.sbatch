#!/bin/bash
#SBATCH --job-name=groot-finetune
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:1
#SBATCH --time=4:00:00
#SBATCH --output=/fsx/scratch/logs/groot-%j.out
#SBATCH --error=/fsx/scratch/logs/groot-%j.err

# GR00T Fine-tuning using uv virtual environment (no container required)
#
# Prerequisites:
#   - Run setup_groot_env.sh first to create /fsx/envs/gr00t
#   - Dataset prepared at /fsx/datasets/groot/<DATASET>
#   - HuggingFace token with access to nvidia/GR00T-N1.7-3B (gated model)
#     Set via: export HF_TOKEN=hf_xxx or huggingface-cli login
#   - mkdir -p /fsx/scratch/logs
#
# Usage:
#   HF_TOKEN=hf_xxx sbatch finetune_groot_venv.sbatch
#   NUM_GPUS=1 DATASET=droid_sample EMBODIMENT_TAG=oxe_droid_relative_eef_relative_joint sbatch finetune_groot_venv.sbatch
#
# Environment Variables:
#   HF_TOKEN: HuggingFace token (required for gated models)
#   NUM_GPUS: Number of GPUs (default: 1)
#   DATASET: Dataset name under /fsx/datasets/groot/ (default: demo_data)
#   DATASET_PATH: Full dataset path, overrides DATASET
#   EMBODIMENT_TAG: Robot embodiment tag (default: oxe_droid_relative_eef_relative_joint)
#   BASE_MODEL: Base model path (default: nvidia/GR00T-N1.7-3B)
#   MAX_STEPS: Training steps (default: 2000)
#   SAVE_STEPS: Save every N steps (default: 2000)
#   GLOBAL_BATCH_SIZE: Global batch size (default: 2)
#   OUTPUT_DIR: Checkpoint output (default: /fsx/checkpoints/vla/groot-<DATASET>)

set -e

if [ -z "${HF_TOKEN}" ] && [ -f /fsx/scratch/.hf_token ]; then
    export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
fi
if [ -z "${HF_TOKEN}" ]; then
    echo "WARNING: HF_TOKEN not set. Model download may fail for gated repos."
    echo "  Set via: export HF_TOKEN=hf_xxx  OR  echo hf_xxx > /fsx/scratch/.hf_token"
fi
export HF_TOKEN="${HF_TOKEN:-}"

NUM_GPUS="${NUM_GPUS:-1}"
DATASET="${DATASET:-demo_data}"
DATASET_PATH="${DATASET_PATH:-/fsx/datasets/groot/${DATASET}}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-oxe_droid_relative_eef_relative_joint}"
BASE_MODEL="${BASE_MODEL:-nvidia/GR00T-N1.7-3B}"
MAX_STEPS="${MAX_STEPS:-2000}"
SAVE_STEPS="${SAVE_STEPS:-2000}"
SAVE_TOTAL_LIMIT="${SAVE_TOTAL_LIMIT:-5}"
GLOBAL_BATCH_SIZE="${GLOBAL_BATCH_SIZE:-2}"
DATALOADER_NUM_WORKERS="${DATALOADER_NUM_WORKERS:-2}"
OUTPUT_DIR="${OUTPUT_DIR:-/fsx/checkpoints/vla/groot-${DATASET}}"

GR00T_ENV="/fsx/envs/gr00t"
GR00T_REPO="/fsx/scratch/Isaac-GR00T"

echo "=================================================="
echo "GR00T Fine-tuning Job (venv mode)"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: ${SLURM_NODELIST}"
echo "Environment: ${GR00T_ENV}"
echo "Base Model: ${BASE_MODEL}"
echo "Dataset: ${DATASET_PATH}"
echo "Output: ${OUTPUT_DIR}"
echo "GPUs: ${NUM_GPUS}"
echo "Max Steps: ${MAX_STEPS}"
echo "Batch Size: ${GLOBAL_BATCH_SIZE}"
echo "Start: $(date)"
echo "=================================================="

if [ ! -d "${GR00T_ENV}" ]; then
    echo "ERROR: Virtual environment not found at ${GR00T_ENV}"
    echo "Run: bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_groot_env.sh"
    exit 1
fi

if [ ! -d "${GR00T_REPO}" ]; then
    echo "ERROR: Isaac-GR00T repository not found at ${GR00T_REPO}"
    echo "Run: bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_groot_env.sh"
    exit 1
fi

mkdir -p "${OUTPUT_DIR}" /fsx/scratch/logs

source "${GR00T_ENV}/bin/activate"
cd "${GR00T_REPO}"

GRAD_ACCUM="${GRAD_ACCUM:-${GLOBAL_BATCH_SIZE}}"

# Apply memory optimizations for single-GPU training (A10G 24GB)
# - load_bf16: load model weights in bf16 (halves memory from ~12GB to ~6GB)
# - gradient_checkpointing: trade compute for memory on activations
# - paged_adamw_8bit: reduces optimizer state memory (~12GB to ~3GB)
sed -i 's/config.model.load_bf16 = False/config.model.load_bf16 = True/' \
    gr00t/experiment/launch_finetune.py
sed -i 's/config.training.optim = "adamw_torch"/config.training.optim = "paged_adamw_8bit"/' \
    gr00t/experiment/launch_finetune.py
grep -q "config.training.gradient_checkpointing" gr00t/experiment/launch_finetune.py || \
    sed -i '/config.training.warmup_ratio/a\    config.training.gradient_checkpointing = True' \
    gr00t/experiment/launch_finetune.py

# Verify memory optimizations were applied
grep -q "config.model.load_bf16 = True" gr00t/experiment/launch_finetune.py || \
    echo "WARNING: bf16 loading patch failed - training may OOM"
grep -q "paged_adamw_8bit" gr00t/experiment/launch_finetune.py || \
    echo "WARNING: 8-bit optimizer patch failed - training may OOM"

python -m gr00t.experiment.launch_finetune \
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
    --gradient-accumulation-steps "${GRAD_ACCUM}" \
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
