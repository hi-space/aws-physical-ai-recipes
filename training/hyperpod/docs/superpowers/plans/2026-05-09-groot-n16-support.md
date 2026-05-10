# GR00T N1.6 Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GR00T N1.6 as a default alternative to gated N1.7, so workshop participants can fine-tune without HuggingFace access requests.

**Architecture:** Single `GROOT_VERSION` environment variable (default `n1.6`) controls model selection across setup script and sbatch template. Same venv, same repo branch, same fine-tune CLI — only `--base-model-path` changes.

**Tech Stack:** Bash scripts, SLURM sbatch, GitBook-style markdown (guide docs)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/setup_groot_env.sh` | Modify | Add `GROOT_VERSION` param, conditional HF_TOKEN logic |
| `slurm-templates/vla/finetune_groot_venv.sbatch` | Modify | Version-based `BASE_MODEL` default, conditional HF_TOKEN check |
| Guide: `4.-vla-training.md` | Modify | Version selection UI, conditional HF token section |
| Guide: `3.-data-preparation.md` | Modify | Update GR00T overview to cover both versions |
| Guide: `README.md` | Modify | Mention N1.6/N1.7 choice in workshop overview |

---

### Task 1: Modify `setup_groot_env.sh` — Add GROOT_VERSION support

**Files:**
- Modify: `training/hyperpod/scripts/setup_groot_env.sh`

- [ ] **Step 1: Add GROOT_VERSION parameter and version-dependent logic**

Replace the entire file with this updated version. Key changes:
- `GROOT_VERSION` defaults to `n1.6`
- HF_TOKEN setup block only runs for `n1.7`
- Usage comment updated

```bash
#!/bin/bash
# Setup GR00T training environment using uv virtual environment
# Run this on the head node (or compute node with GPU)
#
# This creates a self-contained venv at /fsx/envs/gr00t
# that is shared across all nodes via FSx.
#
# Usage:
#   bash setup_groot_env.sh                    # Default: N1.6 (no HF token needed)
#   GROOT_VERSION=n1.7 HF_TOKEN=hf_xxx bash setup_groot_env.sh  # N1.7 (gated)
#
# After setup:
#   source /fsx/envs/gr00t/bin/activate
#   python -m gr00t.experiment.launch_finetune --help

set -e

export PATH="$HOME/.local/bin:$PATH"

GROOT_VERSION="${GROOT_VERSION:-n1.6}"
ENVS_DIR="/fsx/envs"
GR00T_ENV="${ENVS_DIR}/gr00t"
GR00T_REPO="/fsx/scratch/Isaac-GR00T"

echo "=================================================="
echo "GR00T Training Environment Setup (uv venv)"
echo "  Version: ${GROOT_VERSION}"
echo "=================================================="

# Resolve model name from version
case "${GROOT_VERSION}" in
    n1.6)
        BASE_MODEL="nvidia/GR00T-N1.6-3B"
        echo "  Model: ${BASE_MODEL} (open — no HF token required)"
        ;;
    n1.7)
        BASE_MODEL="nvidia/GR00T-N1.7-3B"
        echo "  Model: ${BASE_MODEL} (gated — HF token required)"
        if [ -z "${HF_TOKEN:-}" ] && [ ! -f /fsx/scratch/.hf_token ]; then
            echo ""
            echo "  WARNING: HF_TOKEN not set and /fsx/scratch/.hf_token not found."
            echo "  N1.7 is a gated model. You need:"
            echo "    1. Request access: https://huggingface.co/nvidia/GR00T-N1.7-3B"
            echo "    2. Request access: https://huggingface.co/nvidia/Cosmos-Reason2-2B"
            echo "    3. Set token: export HF_TOKEN=hf_xxx"
            echo ""
        fi
        ;;
    *)
        echo "ERROR: Unknown GROOT_VERSION='${GROOT_VERSION}'. Use 'n1.6' or 'n1.7'."
        exit 1
        ;;
esac

# Step 0: Install system dependencies
echo "[0/4] Checking system dependencies..."
if ! command -v ffmpeg &>/dev/null || ! command -v git-lfs &>/dev/null; then
    sudo apt-get update -y -qq 2>/dev/null
    sudo apt-get install -y -qq ffmpeg git-lfs 2>/dev/null || true
    git lfs install 2>/dev/null || true
fi

# Step 1: Install uv if not available
if ! command -v uv &>/dev/null; then
    echo "[1/4] Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
else
    echo "[1/4] uv already installed"
fi

# Step 2: Clone Isaac-GR00T
echo "[2/4] Setting up Isaac-GR00T repository..."
if [ -d "${GR00T_REPO}" ]; then
    echo "  Repository exists, updating..."
    cd "${GR00T_REPO}" && git pull 2>/dev/null || true
else
    echo "  Cloning Isaac-GR00T..."
    git clone https://github.com/NVIDIA/Isaac-GR00T.git "${GR00T_REPO}"
fi

# Step 3: Create venv and install dependencies
echo "[3/4] Creating virtual environment at ${GR00T_ENV}..."
sudo mkdir -p "${ENVS_DIR}" && sudo chmod 777 "${ENVS_DIR}" 2>/dev/null || mkdir -p "${ENVS_DIR}"

if [ -d "${GR00T_ENV}" ]; then
    echo "  Environment exists. To recreate, run: rm -rf ${GR00T_ENV}"
else
    cd "${GR00T_REPO}"
    uv venv "${GR00T_ENV}" --python 3.10
    source "${GR00T_ENV}/bin/activate"

    echo "  Installing GR00T dependencies (this takes 5-10 minutes)..."
    uv pip install -e .
    uv pip install flash-attn --no-build-isolation 2>/dev/null || \
        echo "  WARNING: flash-attn install failed (needs GPU node). Will work without it."
    uv pip install bitsandbytes mlflow sagemaker-mlflow boto3

    deactivate
fi

# Step 4: Verify
echo "[4/4] Verifying installation..."
source "${GR00T_ENV}/bin/activate"
python -c "import gr00t; print(f'  GR00T version: {gr00t.__version__}')" 2>/dev/null || \
    python -c "import gr00t; print('  GR00T package OK')"

# Setup HuggingFace token if provided (only needed for N1.7)
if [ "${GROOT_VERSION}" = "n1.7" ] && [ -n "${HF_TOKEN:-}" ]; then
    python -c "from huggingface_hub import HfApi; HfApi().set_access_token('${HF_TOKEN}')" 2>/dev/null || true
    echo "  HuggingFace token configured"
fi
deactivate

echo ""
echo "=================================================="
echo "Setup complete! (GR00T ${GROOT_VERSION})"
echo ""
echo "Usage:"
echo "  source /fsx/envs/gr00t/bin/activate"
if [ "${GROOT_VERSION}" = "n1.7" ]; then
    echo "  export GROOT_VERSION=n1.7"
    echo "  HF_TOKEN=hf_xxx sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch"
else
    echo "  sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch"
fi
echo "=================================================="
```

- [ ] **Step 2: Verify script syntax**

Run: `bash -n training/hyperpod/scripts/setup_groot_env.sh`
Expected: No output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/scripts/setup_groot_env.sh
git commit -m "feat(hyperpod): add GROOT_VERSION support to setup script

Default to N1.6 (open model, no HF token required) for workshop ease.
N1.7 available via GROOT_VERSION=n1.7 with HF_TOKEN."
```

---

### Task 2: Modify `finetune_groot_venv.sbatch` — Version-based model selection

**Files:**
- Modify: `training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch`

- [ ] **Step 1: Update sbatch with GROOT_VERSION logic**

Replace the entire file with this updated version. Key changes:
- `GROOT_VERSION` defaults to `n1.6`
- `BASE_MODEL` derived from version
- HF_TOKEN check only for `n1.7`

```bash
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
#   sbatch finetune_groot_venv.sbatch                          # Default: N1.6
#   GROOT_VERSION=n1.7 HF_TOKEN=hf_xxx sbatch finetune_groot_venv.sbatch  # N1.7
#   NUM_GPUS=1 DATASET=droid_sample sbatch finetune_groot_venv.sbatch
#
# Environment Variables:
#   GROOT_VERSION: Model version - n1.6 (default, open) or n1.7 (gated)
#   HF_TOKEN: HuggingFace token (required for N1.7 only)
#   NUM_GPUS: Number of GPUs (default: 1)
#   DATASET: Dataset name under /fsx/datasets/groot/ (default: demo_data)
#   DATASET_PATH: Full dataset path, overrides DATASET
#   EMBODIMENT_TAG: Robot embodiment tag (default: oxe_droid_relative_eef_relative_joint)
#   BASE_MODEL: Base model path (default: derived from GROOT_VERSION)
#   MAX_STEPS: Training steps (default: 2000)
#   SAVE_STEPS: Save every N steps (default: 2000)
#   GLOBAL_BATCH_SIZE: Global batch size (default: 2)
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
DATASET="${DATASET:-demo_data}"
DATASET_PATH="${DATASET_PATH:-/fsx/datasets/groot/${DATASET}}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-oxe_droid_relative_eef_relative_joint}"
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
echo "Version: ${GROOT_VERSION}"
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
```

- [ ] **Step 2: Verify script syntax**

Run: `bash -n training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch`
Expected: No output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch
git commit -m "feat(hyperpod): add GROOT_VERSION to finetune sbatch

Default to N1.6 (open). HF_TOKEN check only for N1.7.
BASE_MODEL resolved from GROOT_VERSION unless explicitly overridden."
```

---

### Task 3: Update guide `4.-vla-training.md` — Add version selection

**Files:**
- Modify: `/home/ubuntu/workspace/physical-ai-aws-docs/physical-ai-on-aws-guide/hyperpod-distributed-training/4.-vla-training.md`

- [ ] **Step 1: Replace the GR00T N1.7 특징 section with version comparison**

Find the section starting at "### GR00T N1.7의 특징" (around line 11) and replace it with a version-neutral overview plus comparison table:

```markdown
### GR00T 모델 버전 선택

이 워크숍에서는 **GR00T N1.6** (기본) 또는 **N1.7** 중 선택하여 Fine-tuning을 수행할 수 있습니다.

| | N1.6 (기본) | N1.7 |
|--|-------------|------|
| HuggingFace 접근 | **즉시 다운로드** (권한 불필요) | Gated (access request 필요) |
| 라이선스 | NVIDIA Noncommercial | Apache 2.0 |
| VLM Backbone | Eagle (SigLip2 + T5) | Cosmos-Reason2-2B (Qwen3-VL) |
| 파라미터 | 3B | 3B |
| 데이터 형식 | LeRobot v2 | LeRobot v2 |
| Fine-tune CLI | `launch_finetune.py` | `launch_finetune.py` (동일) |

{% hint style="success" %}
**워크숍 권장: N1.6 (기본값)**

N1.6은 HuggingFace access request 없이 바로 다운로드할 수 있어 워크숍에 적합합니다. Fine-tuning 워크플로우는 N1.7과 완전히 동일합니다.
{% endhint %}

{% hint style="info" %}
**N1.7을 사용하려면:**

1. https://huggingface.co/nvidia/GR00T-N1.7-3B → "Request access" 클릭
2. https://huggingface.co/nvidia/Cosmos-Reason2-2B → "Request access" 클릭
3. https://huggingface.co/settings/tokens 에서 Read 권한 토큰 생성
4. `export GROOT_VERSION=n1.7` 및 `export HF_TOKEN=hf_xxx` 설정
{% endhint %}
```

- [ ] **Step 2: Update section 4.1 학습 환경 준비 — setup command**

Replace the setup bash block (around line 44-47) to show version choice:

```markdown
```bash
# GR00T 학습 환경 설치 (약 5-10분) — 기본: N1.6
bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_groot_env.sh

# N1.7을 사용하려면:
# GROOT_VERSION=n1.7 bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_groot_env.sh
```
```

- [ ] **Step 3: Replace the "HuggingFace 토큰 설정 (필수)" section**

The old section (lines 68-79) required HF_TOKEN for everyone. Replace with conditional:

```markdown
### HuggingFace 토큰 설정 (N1.7 사용 시에만)

{% hint style="warning" %}
N1.6 (기본)을 사용하는 경우 이 단계를 건너뛰세요. N1.6은 토큰 없이 바로 다운로드됩니다.
{% endhint %}

GR00T N1.7은 **gated model**입니다. N1.7을 사용하려면 반드시 토큰을 설정하세요:

1. https://huggingface.co/nvidia/GR00T-N1.7-3B → "Request access" 클릭
2. https://huggingface.co/nvidia/Cosmos-Reason2-2B → "Request access" 클릭
3. https://huggingface.co/settings/tokens 에서 Read 권한 토큰 생성

```bash
# 토큰 저장 (N1.7 학습 스크립트에서 자동으로 읽음)
echo "hf_xxxxxxxxxxxx" > /fsx/scratch/.hf_token
export GROOT_VERSION=n1.7
```
```

- [ ] **Step 4: Update section 4.3 SLURM 작업 제출 — basic usage**

Replace the basic training commands (around lines 136-141):

```markdown
### 기본 학습 (데모 데이터)

```bash
# 학습 작업 제출 (기본: N1.6, HF 토큰 불필요)
sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch
```

기본 설정:
- Model: `nvidia/GR00T-N1.6-3B` (open, 즉시 다운로드)
- Dataset: `/fsx/datasets/groot/demo_data` (Isaac-GR00T 내장 DROID 샘플)
- GPU: 1개 (A10G 24GB)
- Batch size: 2, Max steps: 2000

N1.7을 사용하려면:

```bash
export GROOT_VERSION=n1.7
export HF_TOKEN="hf_xxxxxxxxxxxx"
sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot_venv.sbatch
```
```

- [ ] **Step 5: Update 환경 변수 목록 table**

Add `GROOT_VERSION` as first row in the table (around line 182):

```markdown
| 변수 | 기본값 | 설명 |
|------|--------|------|
| `GROOT_VERSION` | n1.6 | 모델 버전 (n1.6: open, n1.7: gated) |
| `HF_TOKEN` | (N1.7만 필수) | HuggingFace 토큰 |
| `NUM_GPUS` | 1 | 사용할 GPU 수 |
| `DATASET` | demo_data | 데이터셋 이름 (/fsx/datasets/groot/ 하위) |
| `DATASET_PATH` | /fsx/datasets/groot/${DATASET} | 전체 경로 (DATASET보다 우선) |
| `EMBODIMENT_TAG` | oxe_droid_relative_eef_relative_joint | 로봇 태그 |
| `BASE_MODEL` | GROOT_VERSION에 따라 자동 결정 | 베이스 모델 |
| `MAX_STEPS` | 2000 | 학습 스텝 |
| `GLOBAL_BATCH_SIZE` | 2 | 배치 크기 |
| `GRAD_ACCUM` | GLOBAL_BATCH_SIZE | Gradient accumulation |
| `SAVE_STEPS` | 2000 | 체크포인트 주기 |
| `OUTPUT_DIR` | /fsx/checkpoints/vla/groot-${DATASET} | 저장 경로 |
```

- [ ] **Step 6: Update troubleshooting table**

Replace the `OSError: gated repo` row:

```markdown
| `OSError: gated repo` | N1.7 사용 시 HF 토큰 미설정 | N1.6 사용 (기본값) 또는 `echo "hf_xxx" > /fsx/scratch/.hf_token` + `export GROOT_VERSION=n1.7` |
```

- [ ] **Step 7: Commit**

```bash
git add physical-ai-on-aws-guide/hyperpod-distributed-training/4.-vla-training.md
git commit -m "docs(hyperpod): add N1.6/N1.7 version selection to VLA training guide"
```

---

### Task 4: Update guide `3.-data-preparation.md` — Version-neutral overview

**Files:**
- Modify: `/home/ubuntu/workspace/physical-ai-aws-docs/physical-ai-on-aws-guide/hyperpod-distributed-training/3.-data-preparation.md`

- [ ] **Step 1: Update frontmatter description**

```markdown
---
description: GR00T Fine-tuning용 데이터셋 준비 및 검증
---
```

(No change needed — already version-neutral.)

- [ ] **Step 2: Replace the "GR00T N1.7 개요" section (lines 37-43)**

Replace with:

```markdown
## GR00T 모델 개요

이 워크숍에서는 **GR00T N1.6** (기본) 또는 **N1.7**을 사용합니다. 두 버전 모두 동일한 LeRobot v2 형식의 데이터셋을 사용하며, Fine-tuning 워크플로우가 동일합니다.

- **N1.6 (기본)**: HuggingFace에서 즉시 다운로드 가능 (access request 불필요)
- **N1.7**: Gated model (HF access request + 토큰 필요), Apache 2.0 라이선스

두 모델 모두:
- **3B 파라미터** VLA (Vision-Language-Action) 모델
- **LeRobot v2** 형식 데이터 지원
- 동일한 `launch_finetune.py` CLI로 Fine-tuning
- 다양한 로봇 형태(ALOHA, DROID, SO-101 등)에 대응
```

- [ ] **Step 3: Commit**

```bash
git add physical-ai-on-aws-guide/hyperpod-distributed-training/3.-data-preparation.md
git commit -m "docs(hyperpod): update data prep guide with version-neutral GR00T overview"
```

---

### Task 5: Update guide `README.md` — Mention version choice

**Files:**
- Modify: `/home/ubuntu/workspace/physical-ai-aws-docs/physical-ai-on-aws-guide/hyperpod-distributed-training/README.md`

- [ ] **Step 1: Update step 4 description (around line 158)**

Replace:

```markdown
[**4. VLA 학습 실행 (GR00T N1.7 Fine-tuning)**](4.-vla-training.md)

SLURM을 사용해 GR00T N1.7 모델 Fine-tuning 작업을 제출하고 모니터링합니다. GR00T N1.7은 최신 버전으로 3B 파라미터를 가지며 LeRobot v2 형식의 데이터를 지원합니다.
```

With:

```markdown
[**4. VLA 학습 실행 (GR00T Fine-tuning)**](4.-vla-training.md)

SLURM을 사용해 GR00T VLA 모델 Fine-tuning 작업을 제출하고 모니터링합니다. N1.6 (기본, HF 권한 불필요) 또는 N1.7 (gated) 중 선택할 수 있으며, 두 버전 모두 동일한 워크플로우를 사용합니다.
```

- [ ] **Step 2: Commit**

```bash
git add physical-ai-on-aws-guide/hyperpod-distributed-training/README.md
git commit -m "docs(hyperpod): update README to reflect N1.6/N1.7 choice"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: All 5 changes in spec are covered (setup_groot_env.sh, sbatch, 4.-vla-training.md, 3.-data-preparation.md, README.md)
- [x] **Placeholder scan**: No TBD/TODO — all code blocks are complete
- [x] **Type consistency**: `GROOT_VERSION` variable name consistent across all files; `n1.6`/`n1.7` values consistent; `BASE_MODEL` logic matches in setup + sbatch
