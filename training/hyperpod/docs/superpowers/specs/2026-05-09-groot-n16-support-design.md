# GR00T N1.6 Support — Design Spec

## Problem

GR00T N1.7 is a gated model on HuggingFace. Workshop participants must:
1. Request access to `nvidia/GR00T-N1.7-3B`
2. Request access to `nvidia/Cosmos-Reason2-2B`
3. Generate an HF token with Read permissions

This process creates friction in workshop settings where time is limited.

## Solution

Add GR00T N1.6 as a parallel alternative track. N1.6 (`nvidia/GR00T-N1.6-3B`) is **not gated** — it can be downloaded immediately without HF access requests.

## Key Facts

| | N1.6 | N1.7 |
|--|------|------|
| HuggingFace | Open (no gate) | Gated (access request required) |
| License | NVIDIA OneWay Noncommercial | Apache 2.0 |
| Parameters | 3B | 3B |
| VLM Backbone | Eagle (SigLip2 + T5) | Cosmos-Reason2-2B (Qwen3-VL) |
| Fine-tune CLI | `launch_finetune.py` | `launch_finetune.py` (same) |
| Data format | LeRobot v2 | LeRobot v2 |
| Embodiment tags | Same set | Same set |
| Isaac-GR00T repo | main branch (drop-in swap) | main branch |

N1.7 blog confirms: "Upgrading from N1.6? It's a drop-in swap — point `--model-path` to `nvidia/GR00T-N1.7` and your existing embodiment configs and workflows carry over."

This means the same Isaac-GR00T codebase (main branch) supports both models via `--base-model-path`.

## Approach

Modify existing scripts to support a `GROOT_VERSION` environment variable that toggles between N1.6 and N1.7. No code duplication — single venv, single repo checkout.

### Default Behavior

- `GROOT_VERSION` unset → defaults to **`n1.6`** (workshop-friendly, no HF gate)
- `GROOT_VERSION=n1.7` → requires `HF_TOKEN`

## Changes

### 1. `scripts/setup_groot_env.sh`

- Add `GROOT_VERSION` parameter (default: `n1.6`)
- When `n1.6`: skip HF_TOKEN setup/check
- When `n1.7`: retain existing HF_TOKEN logic
- Repo stays on `main` branch (both versions use same codebase)
- Single venv at `/fsx/envs/gr00t` (shared for both versions)

### 2. `slurm-templates/vla/finetune_groot_venv.sbatch`

- Read `GROOT_VERSION` (default: `n1.6`)
- Set `BASE_MODEL` based on version:
  - `n1.6` → `nvidia/GR00T-N1.6-3B`
  - `n1.7` → `nvidia/GR00T-N1.7-3B`
- When `n1.6`: skip HF_TOKEN warning
- When `n1.7`: retain HF_TOKEN required check
- Memory optimizations (bf16, paged_adamw_8bit, gradient_checkpointing) apply to both

### 3. Guide: `4.-vla-training.md`

- Add version selection section at top of "4.1 학습 환경 준비"
- Add hint box: "HF 권한 없이 바로 시작하려면 N1.6 (기본값)을 사용하세요"
- Move HF token setup to conditional section: "N1.7 사용 시에만 필요"
- Update parameter table to show version-dependent defaults

### 4. Guide: `3.-data-preparation.md`

- Update "GR00T N1.7 개요" section to mention both versions
- HF 토큰 설정 내용을 N1.7 조건부로 변경

### 5. Guide: `README.md`

- 실습 과정 설명에서 N1.6/N1.7 선택 가능함을 언급
- "GR00T N1.7 Fine-tuning" → "GR00T Fine-tuning (N1.6/N1.7 선택)"

## User Flow (Workshop)

### N1.6 (기본, HF 권한 불필요)

```bash
# 환경 설정 (HF_TOKEN 불필요)
bash setup_groot_env.sh

# 학습 실행 (기본이 N1.6)
sbatch finetune_groot_venv.sbatch
```

### N1.7 (HF 권한 필요)

```bash
# HF access request 완료 후
export GROOT_VERSION=n1.7
export HF_TOKEN=hf_xxx

bash setup_groot_env.sh
sbatch finetune_groot_venv.sbatch
```

## Out of Scope

- N1.5 support (different fine-tune script: `scripts/gr00t_finetune.py`)
- Separate venv per version (unnecessary — same dependencies)
- n1.6-release tag checkout (drop-in swap confirmed, main branch works for both)
- Container mode (`finetune_groot.sbatch`) — low priority, venv mode is primary
