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
#   - For N1.7 only: HuggingFace token with access to nvidia/GR00T-N1.7-3B
#     Set via: export HF_TOKEN=hf_xxx or huggingface-cli login
#   - mkdir -p /fsx/scratch/logs
#
# Usage:
#   sbatch finetune_groot_venv.sbatch                          # Default: N1.6 + so101-place-orange
#   DATASET=my_data EMBODIMENT_TAG=OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT sbatch finetune_groot_venv.sbatch
#
# Environment Variables:
#   GROOT_VERSION: Model version - n1.6 (default, open) or n1.7 (gated)
#   HF_TOKEN: HuggingFace token (required for N1.7 only)
#   NUM_GPUS: Number of GPUs (default: 1)
#   DATASET: Dataset name under /fsx/datasets/groot/ (default: so101-place-orange)
#   DATASET_PATH: Full dataset path, overrides DATASET
#   EMBODIMENT_TAG: Robot embodiment tag (default: new_embodiment)
#   MODALITY_CONFIG: Path to modality config (default: .../configs/so101_modality.py)
#   BASE_MODEL: Base model path (default: derived from GROOT_VERSION)
#   MAX_STEPS: Training steps (default: 2000)
#   SAVE_STEPS: Save every N steps (default: 2000)
#   GLOBAL_BATCH_SIZE: Global batch size (default: 32)
#   OUTPUT_DIR: Checkpoint output (default: /fsx/checkpoints/vla/groot-<DATASET>)

set -e

GROOT_VERSION="${GROOT_VERSION:-n1.6}"

# Resolve BASE_MODEL from version (can be overridden explicitly)
case "${GROOT_VERSION}" in
    n1.6) BASE_MODEL="${BASE_MODEL:-nvidia/GR00T-N1.6-3B}" ;;
    n1.7) BASE_MODEL="${BASE_MODEL:-nvidia/GR00T-N1.7-3B}" ;;
    *)
        echo "ERROR: Unknown GROOT_VERSION='${GROOT_VERSION}'. Use 'n1.6' or 'n1.7'."
        exit 1
        ;;
esac

# HF_TOKEN handling (only required for N1.7)
if [ "${GROOT_VERSION}" = "n1.7" ]; then
    if [ -z "${HF_TOKEN}" ] && [ -f /fsx/scratch/.hf_token ]; then
        export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
    fi
    if [ -z "${HF_TOKEN}" ]; then
        echo "WARNING: HF_TOKEN not set. N1.7 is a gated model — download may fail."
        echo "  Set via: export HF_TOKEN=hf_xxx  OR  echo hf_xxx > /fsx/scratch/.hf_token"
    fi
    export HF_TOKEN="${HF_TOKEN:-}"
fi

NUM_GPUS="${NUM_GPUS:-1}"
DATASET="${DATASET:-so101-place-orange}"
DATASET_PATH="${DATASET_PATH:-/fsx/datasets/groot/${DATASET}}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-NEW_EMBODIMENT}"
MODALITY_CONFIG="${MODALITY_CONFIG:-/fsx/scratch/aws-physical-ai-recipes/training/hyperpod/configs/so101_modality.py}"
MAX_STEPS="${MAX_STEPS:-2000}"
SAVE_STEPS="${SAVE_STEPS:-2000}"
SAVE_TOTAL_LIMIT="${SAVE_TOTAL_LIMIT:-5}"
GLOBAL_BATCH_SIZE="${GLOBAL_BATCH_SIZE:-32}"
DATALOADER_NUM_WORKERS="${DATALOADER_NUM_WORKERS:-4}"
OUTPUT_DIR="${OUTPUT_DIR:-/fsx/checkpoints/vla/groot-${DATASET}}"

GR00T_ENV="/fsx/envs/gr00t"
GR00T_REPO="/fsx/scratch/Isaac-GR00T"

echo "=================================================="
echo "GR00T Fine-tuning Job (venv mode)"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: ${SLURM_NODELIST}"
echo "Version: ${GROOT_VERSION}"
echo "Environment: ${GR00T_ENV}"
echo "Base Model: ${BASE_MODEL}"
echo "Dataset: ${DATASET_PATH}"
echo "Output: ${OUTPUT_DIR}"
echo "GPUs: ${NUM_GPUS}"
echo "Max Steps: ${MAX_STEPS}"
echo "Batch Size: ${GLOBAL_BATCH_SIZE}"
echo "Modality Config: ${MODALITY_CONFIG}"
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

# Remove stale checkpoints that may conflict with optimizer changes (paged_adamw_8bit)
if ls "${OUTPUT_DIR}"/checkpoint-* &>/dev/null; then
    echo "Clearing stale checkpoints in ${OUTPUT_DIR} to avoid optimizer mismatch..."
    rm -rf "${OUTPUT_DIR}"/checkpoint-* "${OUTPUT_DIR}"/training_args.bin
fi

# Clean up stale GPU processes from previous jobs (e.g. Isaac Sim kit processes)
if command -v nvidia-smi &>/dev/null; then
    stale_pids=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | tr -d ' ')
    if [ -n "${stale_pids}" ]; then
        echo "Cleaning stale GPU processes: ${stale_pids}"
        echo "${stale_pids}" | xargs -r sudo kill -9 2>/dev/null || true
        sleep 2
    fi
fi

source "${GR00T_ENV}/bin/activate"
cd "${GR00T_REPO}"

GRAD_ACCUM="${GRAD_ACCUM:-${GLOBAL_BATCH_SIZE}}"

# Apply memory optimizations for single-GPU training (A10G 24GB)
# - paged_adamw_8bit: reduces optimizer state memory (~12GB to ~3GB)
# - gradient_checkpointing: trade compute for memory on activations
# NOTE: load_bf16=True is NOT compatible with N1.6 model loading
sed -i 's/config.training.optim = "adamw_torch"/config.training.optim = "paged_adamw_8bit"/' \
    gr00t/experiment/launch_finetune.py
grep -q "config.training.gradient_checkpointing" gr00t/experiment/launch_finetune.py || \
    sed -i '/config.training.warmup_ratio/a\    config.training.gradient_checkpointing = True' \
    gr00t/experiment/launch_finetune.py

# Verify memory optimizations were applied
grep -q "paged_adamw_8bit" gr00t/experiment/launch_finetune.py || \
    echo "WARNING: 8-bit optimizer patch failed - training may OOM"

python -m gr00t.experiment.launch_finetune \
    --base-model-path "${BASE_MODEL}" \
    --dataset-path "${DATASET_PATH}" \
    --embodiment-tag "${EMBODIMENT_TAG}" \
    --modality-config-path "${MODALITY_CONFIG}" \
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
