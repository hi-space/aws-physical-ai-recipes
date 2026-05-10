# HyperPod Workshop Consolidation Design

## Overview

SO101 로봇의 VLA(GR00T N1.6) fine-tuning과 closed-loop 시뮬레이션 검증을 중심으로 한 AWS HyperPod 워크샵을 정리·통합한다. 최종 목표는 fine-tuned GR00T 모델이 LeIsaac PickOrange 시뮬레이션에서 성공적으로 동작하는 것.

## Target Audience

로봇/RL/VLA 연구·개발자. AWS 인프라 경험 없음. Physical AI 학습 파이프라인을 클라우드에서 돌리는 방법을 배우는 것이 목적.

## Core Story

```
SO101 "place orange" task
├── [3장] 데이터: so101-place-orange (HF → S3 → FSx DRA 자동 임포트)
├── [4장] VLA 학습: GR00T N1.6 fine-tune
├── [5장] RL 학습 (Optional): Isaac Lab SO101-Reach / SO101-Lift
└── [6장] 검증: fine-tuned GR00T → LeIsaac PickOrange headless closed-loop 성공
```

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| VLA model | GR00T N1.6 | Open access, HF 즉시 다운로드, workshop 안정성 |
| Dataset | LightwheelAI/so101-place-orange | 61 episodes, LeRobot v2, 6-DOF, SO101 전용 |
| Dataset delivery | S3 → FSx DRA | 자동 동기화, 별도 다운로드 불필요 |
| RL tasks | Workshop-SO101-Reach-v0 / Lift-v0 | 유지, Optional 챕터로 포지셔닝 |
| Closed-loop env | LeIsaac-SO101-PickOrange-v0 | VLA 학습과 동일 task 계열, headless 지원 |
| Closed-loop infra | HyperPod compute node | 별도 EC2 불필요, g6e.12xlarge에서 headless |
| GPU instance | ml.g6e.12xlarge (L40S x4) | Isaac Sim + GR00T policy 동시 실행 충분 |
| Region | us-east-1 | 테스트 리전 |

## Chapter Changes

### 1. Infra Deploy — 최소 수정

- us-east-1 명시
- 기존 CDK 구조 유지

### 2. Cluster Access — 최소 수정

- 변경 없음

### 3. Data Preparation — 중간 수정

**제거:**
- ALOHA, DROID, Pusht 등 다른 데이터셋 언급
- "빌트인 DROID 샘플" 가이드

**변경:**
- 데이터셋을 `LightwheelAI/so101-place-orange` 단일화
- 워크플로우: HF에서 로컬 다운로드 → S3 업로드 → FSx DRA 자동 임포트
- 검증: `prepare_dataset.py --validate` 로 LeRobot v2 포맷 확인
- 디렉토리: `/fsx/datasets/groot/so101-place-orange/`

**데이터셋 구조 (참조):**
```
so101-place-orange/
├── meta/
│   ├── info.json          # fps=30, robot_type=so101_follower, codebase_version=v2.1
│   ├── episodes.jsonl
│   └── tasks.jsonl        # "place orange on the plate"
├── data/chunk-000/
│   └── episode_000000.parquet  # action(6-DOF), observation.state(6-DOF)
└── videos/chunk-000/
    ├── observation.images.front/episode_000000.mp4
    └── observation.images.wrist/episode_000000.mp4
```

### 4. VLA Training — 중간 수정

**변경:**
- GR00T N1.6 고정 (N1.7 언급은 참고 정보로만)
- DATASET 기본값: `/fsx/datasets/groot/so101-place-orange`
- embodiment_tag: `new_embodiment` (커스텀 로봇이므로 modality config 필수)
- modality config 파일 필요: SO101 6-DOF 관절 매핑 정의
- `finetune_groot_venv.sbatch` 파라미터 정리:
  - GROOT_VERSION=nvidia/GR00T-N1.6-3B
  - DATASET_PATH=/fsx/datasets/groot/so101-place-orange
  - EMBODIMENT_TAG=new_embodiment
  - MODALITY_CONFIG=/fsx/scratch/aws-physical-ai-recipes/training/hyperpod/configs/so101_modality.py
  - MAX_STEPS=2000
  - BATCH_SIZE=32

**SO101 Modality Config (`configs/so101_modality.py`):**
```python
# SO101 follower arm: 6-DOF joint position control
MODALITY_CONFIG = {
    "state": {
        "keys": ["observation.state"],
        "dim": 6,  # shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper
    },
    "action": {
        "keys": ["action"],
        "dim": 6,  # same 6 joints as target positions
    },
    "video": {
        "keys": ["observation.images.front", "observation.images.wrist"],
    },
}
```
- 이 파일은 레포에 `configs/so101_modality.py`로 포함

**출력:**
- Checkpoint: `/fsx/checkpoints/vla/groot-so101-place-orange/`
- S3 자동 백업

### 5. RL Training — 최소 수정, Optional 표시

**변경:**
- 챕터 제목에 "(Optional)" 추가
- "HyperPod에서 RL 학습도 가능하다"는 부가 설명 포지셔닝
- 기존 Reach + Lift task 코드 유지
- Isaac Lab 환경 설치/실행 그대로

### 6. Simulation Verification — 전면 재작성

**제거:**
- "EC2 companion workshop" 참조 전체
- "Option A: Mount FSx directly" / "Option B: Download from S3" 분기
- 별도 Docker container 관리 설명

**새 구조:**

```
HyperPod Compute Node (ml.g6e.12xlarge, headless)
┌─────────────────────────────────────────────────┐
│                                                 │
│  ┌──────────────────┐     ┌──────────────────┐  │
│  │ GR00T Policy     │◄───►│ LeIsaac Isaac Sim│  │
│  │ Server           │ ZMQ │ PickOrange env   │  │
│  │ (fine-tuned ckpt)│     │ (headless)       │  │
│  └──────────────────┘     └──────────────────┘  │
│                                                 │
│  1. Policy Server: fine-tuned checkpoint 로드    │
│  2. Isaac Sim: PickOrange 환경 headless 시작     │
│  3. Loop: observation → policy → action          │
│  4. 결과: 성공률, 에피소드 길이 출력              │
└─────────────────────────────────────────────────┘
```

**워크플로우:**
1. LeIsaac 환경 설정 (setup script로 자동화)
2. Fine-tuned checkpoint 경로 확인 (`/fsx/checkpoints/vla/groot-so101-place-orange/`)
3. `sbatch eval_closed_loop.sbatch` 제출
4. 결과 메트릭 확인 (success_rate > 0)

**LeIsaac 실행 환경:**
- Isaac Sim container (enroot sqsh)에 LeIsaac 패키지를 추가 설치
- `setup_isaaclab_env.sh`에서 LeIsaac clone + pip install 포함
- LeIsaac 환경 등록: `LeIsaac-SO101-PickOrange-v0`

**서버 준비 상태 확인 (PhysAI 패턴 차용):**
- Policy server 시작 후 ZMQ health check (msgpack ping)로 준비 완료 확인
- 타임아웃 180초 (Cosmos vision encoder 로딩 시간)
- 실패 시 자동 kill + 에러 로그 출력

**결과 출력 (PhysAI metrics.json 패턴 차용):**
- eval 완료 후 `/fsx/checkpoints/vla/groot-so101-place-orange/metrics.json` 생성
- 포맷: `{"success_rate": float, "episodes": int, "avg_episode_length": float}`
- MLflow에도 자동 기록

**필요한 코드 변경:**
- `eval_closed_loop.sbatch`: LeIsaac PickOrange 환경으로 변경, metrics.json 출력 추가
- `scripts/setup_isaaclab_env.sh`: LeIsaac clone + install 추가
- Isaac Sim container rootfs에 LeIsaac task 등록

### 7. MLflow Tracking — 최소 수정

- 변경 없음

### 8. Cleanup — 최소 수정

- 변경 없음

## Code Changes Required

### Scripts

| File | Change |
|------|--------|
| `scripts/setup_groot_env.sh` | so101-place-orange 데이터셋 경로 기본값 |
| `scripts/setup_isaaclab_env.sh` | LeIsaac 환경 설치 추가 (closed-loop eval용) |
| `examples/vla/prepare_dataset.py` | S3 업로드 헬퍼 또는 가이드 추가 |
| `configs/so101_modality.py` | **신규** — SO101 6-DOF state/action/video modality 매핑 |

### SLURM Templates

| File | Change |
|------|--------|
| `slurm-templates/vla/finetune_groot_venv.sbatch` | DATASET 기본값 변경, N1.6 고정, embodiment_tag |
| `slurm-templates/vla/eval_closed_loop.sbatch` | LeIsaac PickOrange로 변경, HyperPod headless |
| `slurm-templates/rl/finetune_isaaclab.sbatch` | 최소 수정 (동작 확인) |

### Workshop Docs

| File | Change Level |
|------|-------------|
| `3.-data-preparation.md` | 중간 — so101-place-orange 통일, S3→FSx |
| `4.-vla-training.md` | 중간 — N1.6 고정, 파라미터 통일 |
| `5.-rl-training.md` | 최소 — Optional 표시 |
| `6.-simulation-verification.md` | 전면 재작성 — HyperPod headless closed-loop |

## Verification Criteria

워크샵 완성 기준:

1. `cdk deploy` → 클러스터 정상 생성 (us-east-1)
2. so101-place-orange S3 업로드 → FSx DRA 자동 임포트 확인
3. `sbatch finetune_groot_venv.sbatch` → GR00T N1.6 fine-tune 완료, checkpoint 생성
4. `sbatch finetune_isaaclab.sbatch` → Reach/Lift RL 학습 정상 (Optional)
5. `sbatch eval_closed_loop.sbatch` → **fine-tuned GR00T가 PickOrange에서 동작, 성공률 > 0**

## Out of Scope

- GR00T N1.7 지원 (참고만)
- 별도 EC2/DCV GUI 시뮬레이션
- 실물 로봇 배포
- Multi-node distributed training (single-node multi-GPU로 충분)
- 커스텀 데이터 수집 가이드
