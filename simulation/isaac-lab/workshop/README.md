# GR00T + SO-ARM 101 Workshop

**NVIDIA GR00T N1.7 실시간 파인튜닝 + SO-101 Closed-loop 제어**

AWS 물리 로봇 학습 워크숍에서 NVIDIA의 최신 대규모 멀티태스크 정책 모델인 GR00T를 직접 파인튜닝하고, 그 결과를 Isaac Sim에서 시뮬레이션된 SO-ARM 101 로봇으로 실시간 제어하는 경험을 얻습니다. 분산 학습 + 개별 노트북 환경에서의 실시간 시각화를 통해 엔드투엔드 AI 로봇 학습 파이프라인을 이해합니다.

| 항목 | 내용 |
|------|------|
| **소요 시간** | ~2시간 |
| **난이도** | Level 300 (고급) |
| **대상 인원** | AI 엔지니어, 로봇 개발자, ML 연구자 |
| **선수 지식** | Python, 강화학습 기초, Linux CLI |
| **권장 GPU** | NVIDIA A100 40GB (또는 H100) |
| **AWS 서비스** | EC2 DCV, EFS, Batch, S3 |

---

## 프로젝트 구조 (Project Structure)

```
simulation/isaac-lab/workshop/
├── README.md                              # 이 파일
├── pyproject.toml                         # Python 의존성 및 CLI 진입점
├── setup.sh                               # 원클릭 환경 셋업 스크립트
├── configs/
│   └── so101_modality_config.py           # GR00T 모달리티 설정 (5-DOF + 그리퍼)
├── batch/
│   └── entrypoint.sh                      # AWS Batch 컨테이너 진입점
└── src/workshop/
    ├── robots/
    │   ├── so_arm101.py                   # SO-ARM 101 로봇 정의
    │   └── urdf/
    │       ├── so_arm101.urdf             # URDF 모델 (setup.sh에서 자동 다운로드)
    │       └── assets/                    # STL 메시 파일들
    ├── tasks/
    │   ├── reach/
    │   │   ├── reach_env_cfg.py           # Reach 작업 환경 설정
    │   │   └── agents/rsl_rl_ppo_cfg.py   # PPO 강화학습 설정
    │   └── lift/
    │       ├── lift_env_cfg.py            # Lift 작업 환경 설정
    │       └── agents/rsl_rl_ppo_cfg.py   # PPO 강화학습 설정
    └── scripts/
        ├── list_envs.py                   # 등록된 환경 나열
        ├── train_rl.py                    # RL 정책 학습
        ├── play_rl.py                     # 학습된 정책 시각화
        ├── collect_demos.py               # 데모 수집
        ├── convert_to_lerobot.py          # LeRobot 형식 변환
        ├── download_hf_dataset.py         # HuggingFace 데이터셋 다운로드
        ├── upload_s3.py                   # S3 업로드
        ├── submit_batch_job.py            # AWS Batch 작업 제출
        └── run_closed_loop.py             # Closed-loop 시뮬레이션 클라이언트
```

---

## 등록된 환경 (Registered Environments)

워크숍에서 사용 가능한 두 가지 작업:

| 환경 ID | 설명 | 목적 |
|---------|------|------|
| `Workshop-SO101-Reach-v0` | SO-101 엔드이펙터를 목표 위치로 도달 | 기본 움직임 학습 |
| `Workshop-SO101-Reach-Play-v0` | Reach 평가 환경 (테스트 용) | 학습된 정책 시각화 |
| `Workshop-SO101-Lift-v0` | 큐브를 테이블에서 들어올리기 | 물체 조작 학습 |
| `Workshop-SO101-Lift-Play-v0` | Lift 평가 환경 (테스트 용) | 학습된 정책 시각화 |

---

## Module 0: 환경 셋업 (~10분)

워크숍 시작 전 필수 준비 단계입니다.

### 0.1 DCV 접속

1. AWS 콘솔에서 EC2 인스턴스의 DCV 연결 정보 확인
2. 브라우저에서 접속: `https://<Instance-Public-IP>:8443`
3. 로그인 (기본: ubuntu / 패스워드 또는 세션 토큰)

> **참고**: DCV는 원격 데스크톱 프로토콜입니다. GPU 시각화가 필요하므로 꼭 필요합니다.

### 0.2 Isaac-GR00T 클론 및 설치

Terminal을 열고 다음 명령어를 실행합니다:

```bash
cd ~/environment
git clone https://github.com/NVIDIA/Isaac-GR00T.git
cd Isaac-GR00T
uv sync --all-extras
```

> **소요 시간**: 3~5분 (네트워크 속도에 따라 달라짐)

### 0.3 워크숍 환경 셋업

```bash
cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/
bash setup.sh
```

이 스크립트는 다음을 자동으로 수행합니다:
- SO-ARM 101 URDF 및 STL 메시 파일 다운로드 (TheRobotStudio 공식 저장소)
- Python 의존성 설치
- Isaac Lab 환경 검증

### 0.4 환경 검증

```bash
uv run list_envs
```

다음과 같은 출력을 확인해야 합니다:

```
Registered Environments:
  Workshop-SO101-Reach-v0
  Workshop-SO101-Reach-Play-v0
  Workshop-SO101-Lift-v0
  Workshop-SO101-Lift-Play-v0
```

✅ 모든 네 개 환경이 나타나면 셋업 완료!

---

## Module 1: 데이터 준비 (~20분 또는 ~50분)

GR00T 파인튜닝을 위한 데이터 준비 단계입니다. **두 가지 트랙** 중 선택:

### Fast Track: 사전 준비된 데이터 활용 (~20분)

이 트랙은 이미 준비된 HuggingFace 데이터셋을 사용하므로 가장 빠릅니다.

#### 1.1 HuggingFace 데이터셋 다운로드

```bash
cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/

uv run download_hf \
  --repo_id "your-org/so101-demos" \
  --output_dir /tmp/so101_data
```

> **참고**: 실제 레포지토리 ID는 워크숍 진행자가 제공합니다.

데이터셋 구조 확인:

```bash
ls -lh /tmp/so101_data/
# data/
#   episode_0/
#   episode_1/
#   ...
```

#### 1.2 S3에 업로드

데이터를 분산 학습을 위해 S3에 업로드합니다:

```bash
uv run upload_s3 \
  --local_path /tmp/so101_data \
  --bucket my-workspace-bucket \
  --s3_prefix datasets/so101_workshop
```

✅ 완료 후 S3 URI를 메모해 두세요 (Module 2에서 필요):

```
s3://my-workspace-bucket/datasets/so101_workshop/
```

---

### Deep Dive: 처음부터 데이터 생성 (~50분)

이 트랙은 RL 정책을 학습한 후 그 정책으로 데모를 수집합니다. 학습 과정을 완전히 이해하고 싶은 경우 선택하세요.

#### 1.1 RL 정책 학습 (로컬 또는 AWS Batch)

**옵션 A: 로컬 학습 (단일 GPU, DCV에서)**

```bash
cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/

uv run train_rl \
  --task Workshop-SO101-Lift-v0 \
  --headless \
  --num_envs 256 \
  --max_iterations 5000
```

**옵션 B: AWS Batch 분산 학습 (권장, 8개 GPU)**

```bash
uv run submit_batch \
  --job_type rl \
  --task Workshop-SO101-Lift-v0 \
  --job_name "workshop-lift-training" \
  --job_queue "gpu-queue" \
  --job_definition "workshop-rl-training" \
  --follow
```

> **소요 시간**: 30~45분 (인스턴스 수와 환경 수에 따라 달라짐)

#### 1.2 학습된 정책 시각화

학습이 완료되면 결과를 확인합니다:

```bash
uv run play_rl \
  --task Workshop-SO101-Lift-Play-v0 \
  --checkpoint /tmp/so101_training/checkpoint-5000 \
  --video
```

로봇이 큐브를 집어올리는 모습을 볼 수 있습니다!

#### 1.3 데모 수집

학습된 정책으로 데모를 200개 에피소드 수집합니다:

```bash
uv run collect \
  --task Workshop-SO101-Lift-Play-v0 \
  --checkpoint /tmp/so101_training/checkpoint-5000 \
  --num_episodes 200 \
  --output_dir /tmp/so101_demos
```

#### 1.4 LeRobot 형식 변환

수집된 데모를 GR00T 파인튜닝용 LeRobot 형식으로 변환합니다:

```bash
uv run convert \
  --input_dir /tmp/so101_demos \
  --output_dir /tmp/so101_lerobot \
  --task_description "lift cube to target height"
```

#### 1.5 데이터셋 통계 생성

Isaac-GR00T 저장소로 이동하여 통계량을 생성합니다:

```bash
cd ~/environment/Isaac-GR00T

python gr00t/data/stats.py \
  --dataset-path /tmp/so101_lerobot \
  --embodiment-tag NEW_EMBODIMENT \
  --modality-config-path ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/configs/so101_modality_config.py
```

이 스크립트는 정규화 통계량을 생성하며, 이후 파인튜닝 시 필수입니다.

#### 1.6 S3 업로드

LeRobot 데이터셋을 S3에 업로드합니다:

```bash
cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/

uv run upload_s3 \
  --local_path /tmp/so101_lerobot \
  --bucket my-workspace-bucket \
  --s3_prefix datasets/so101_workshop_lerobot
```

✅ S3 URI 메모:

```
s3://my-workspace-bucket/datasets/so101_workshop_lerobot/
```

---

## Module 2+3: GR00T 파인튜닝 + 실시간 Closed-loop 시뮬레이션 (~40~60분)

이 모듈에서는 Module 1의 데이터를 활용하여 GR00T를 파인튜닝하고, 동시에 최신 체크포인트를 Policy Server로 로드하여 Closed-loop 시뮬레이션에서 실시간으로 제어합니다.

**핵심 아이디어**: 학습과 시각화가 병렬로 진행됩니다. EFS 공유 스토리지를 통해 Policy Server가 주기적으로 최신 체크포인트를 감지하고 리로드합니다.

### 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────┐
│  AWS Batch (분산 학습) 또는 단일 GPU (DCV)                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  GR00T 파인튜닝 프로세스                              │  │
│  │  → /efs/checkpoints/groot/checkpoint-1000           │  │
│  │  → /efs/checkpoints/groot/checkpoint-2000           │  │
│  │  → /efs/checkpoints/groot/checkpoint-3000           │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────┬─────────────────────────────────────┘
                         │ (EFS 공유)
                         ▼
            ┌────────────────────────────┐
            │   Policy Server (gRPC)     │
            │   포트 5555                 │
            │ - 모델 로드                │
            │ - 체크포인트 감지 (watch)   │
            │ - 추론 요청 처리             │
            └────────────────────────────┘
                         ▲
                         │ (gRPC)
                         │
            ┌────────────────────────────┐
            │  Isaac Sim (Closed-loop)    │
            │  - SO-101 시뮬레이션        │
            │ - 상태 수집                │
            │ - Policy Server에 요청      │
            │ - 액션 적용                │
            └────────────────────────────┘
```

### Fast Track: 단일 GPU (DCV 환경에서) (~40분)

이 트랙은 로컬 DCV 인스턴스에서 모든 작업을 수행합니다. 진행 상황을 실시간으로 확인할 수 있습니다.

#### 준비 작업

Module 1에서 준비한 데이터 확인:

```bash
ls -lh /tmp/so101_lerobot/
# 또는 S3에서: s3://my-workspace-bucket/datasets/so101_workshop_lerobot/
```

#### 2.1 GR00T 파인튜닝 (Terminal 1)

Terminal을 3개 준비합니다 (각각 다른 작업 실행).

**Terminal 1 - 파인튜닝 시작:**

```bash
cd ~/environment/Isaac-GR00T

CUDA_VISIBLE_DEVICES=0 NUM_GPUS=1 bash examples/finetune.sh \
  --base-model-path nvidia/GR00T-N1.7-3B \
  --dataset-path /tmp/so101_lerobot \
  --modality-config-path ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/configs/so101_modality_config.py \
  --embodiment-tag NEW_EMBODIMENT \
  --output-dir /tmp/so101_finetune
```

또는 S3에서 데이터를 사용하는 경우:

```bash
# 또는 S3 데이터 사용
aws s3 sync s3://my-workspace-bucket/datasets/so101_workshop_lerobot/ /tmp/so101_lerobot/

# 그 후 위 명령어 동일하게 실행
```

> **예상 소요 시간**: 30~40분
> 
> **로그 출력 예시:**
> ```
> [Training] Epoch 1/10, Loss: 0.432
> [Checkpoint] Saved checkpoint-500 to /tmp/so101_finetune/checkpoint-500
> [Training] Epoch 2/10, Loss: 0.289
> ...
> ```

#### 2.2 Policy Server 시작 (Terminal 2)

새로운 Terminal을 열고:

```bash
cd ~/environment/Isaac-GR00T

python gr00t/eval/run_gr00t_server.py \
  --model-path /tmp/so101_finetune/checkpoint-2000 \
  --embodiment-tag NEW_EMBODIMENT \
  --modality-config-path ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/configs/so101_modality_config.py \
  --host 0.0.0.0 \
  --port 5555
```

> **예상 로그 출력:**
> ```
> Loading model from /tmp/so101_finetune/checkpoint-2000
> Model loaded: GR00T-N1.7-3B
> Policy Server listening on 0.0.0.0:5555
> Watching /tmp/so101_finetune for checkpoint updates...
> ```

Policy Server는 체크포인트 디렉토리를 감시하며, Terminal 1의 새로운 체크포인트가 완성되면 자동으로 리로드합니다.

#### 2.3 Closed-loop 시뮬레이션 (Terminal 3)

마지막 Terminal에서:

```bash
cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/

uv run closed_loop \
  --policy_host localhost \
  --instruction "lift the cube"
```

Isaac Sim이 시작되고, SO-101이 Policy Server의 명령을 받아 큐브를 집어올리기 시작합니다!

**실시간 확인:**
- Terminal 1: 파인튜닝 진행률과 손실값
- Terminal 2: 새로운 체크포인트 감지 및 모델 리로드 메시지
- Terminal 3: Isaac Sim 시각화에서 로봇의 성능 개선 과정 확인

이렇게 하면 학습이 진행되면서 Policy Server가 점진적으로 더 나은 모델을 로드하게 되고, Closed-loop 시뮬레이션에서 로봇의 제어 성능이 실시간으로 향상되는 것을 직접 체험할 수 있습니다!

---

### Deep Dive: AWS Batch 분산 학습 (~60분)

이 트랙은 AWS Batch를 사용하여 여러 GPU에서 분산 학습을 진행합니다. 대규모 모델과 데이터셋에 최적화되어 있습니다.

#### 2.1 Batch 학습 작업 제출

```bash
cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/

uv run submit_batch \
  --job_type groot \
  --job_name "workshop-groot-finetune" \
  --job_queue "gpu-queue" \
  --job_definition "workshop-groot-training" \
  --dataset_s3_uri "s3://my-workspace-bucket/datasets/so101_workshop_lerobot/" \
  --follow
```

`--follow` 플래그를 사용하면 작업이 완료될 때까지 실시간으로 로그를 확인할 수 있습니다.

> **예상 소요 시간**: 45~60분 (인스턴스 수에 따라 달라짐)

#### 2.2 체크포인트 진행 모니터링 (DCV에서)

Batch 작업이 실행 중인 동안, DCV의 Terminal에서 EFS 체크포인트 디렉토리를 모니터링합니다:

```bash
# EFS 마운트 경로 (AWS에서 설정한 경로)
watch -n 5 "ls -lht /efs/checkpoints/groot/ | head -10"
```

새로운 체크포인트 파일이 주기적으로 나타나는 것을 볼 수 있습니다.

#### 2.3 Policy Server 시작 (DCV에서)

EFS에 체크포인트가 나타나면, DCV의 Terminal에서 Policy Server를 시작합니다:

```bash
cd ~/environment/Isaac-GR00T

python gr00t/eval/run_gr00t_server.py \
  --model-path /efs/checkpoints/groot/checkpoint-1000 \
  --embodiment-tag NEW_EMBODIMENT \
  --modality-config-path ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/configs/so101_modality_config.py \
  --host 0.0.0.0 \
  --port 5555
```

#### 2.4 Closed-loop 시뮬레이션 실행 (DCV에서)

```bash
cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop/

uv run closed_loop \
  --policy_host localhost \
  --instruction "lift the cube"
```

#### 2.5 체크포인트 업데이트 모니터링

학습이 진행되면서:

1. Batch 작업은 계속 `/efs/checkpoints/groot/` 에 새로운 체크포인트를 저장
2. Policy Server는 이를 감시하여 자동 리로드
3. Closed-loop 시뮬레이션에서 로봇의 성능이 점진적으로 개선

> **Tip**: 여러 개의 DCV Terminal을 사용하여 동시에 모니터링할 수 있습니다:
> - Terminal 1: `watch -n 5 "ls -lht /efs/checkpoints/groot/"`
> - Terminal 2: Policy Server 로그 확인
> - Terminal 3: Closed-loop 시뮬레이션 실행

---

## CLI 명령어 참조 (CLI Reference)

### 환경 및 작업 관리

```bash
# 등록된 모든 환경 나열
uv run list_envs

# RL 정책 학습 (기본: 512 환경, 5000 반복)
uv run train_rl --task Workshop-SO101-Reach-v0
uv run train_rl --task Workshop-SO101-Lift-v0 --num_envs 256 --max_iterations 2000

# Headless 모드 (시각화 없음, 빠른 학습)
uv run train_rl --task Workshop-SO101-Lift-v0 --headless

# 학습된 정책 시각화
uv run play_rl --task Workshop-SO101-Reach-Play-v0 --checkpoint /path/to/checkpoint-1000
uv run play_rl --task Workshop-SO101-Lift-Play-v0 --checkpoint /path/to/checkpoint --video
```

### 데이터 준비

```bash
# HuggingFace 데이터셋 다운로드
uv run download_hf --repo_id "your-org/so101-demos" --output_dir /tmp/so101_data

# 데모 수집 (학습된 정책 사용)
uv run collect \
  --task Workshop-SO101-Lift-Play-v0 \
  --checkpoint /path/to/checkpoint-5000 \
  --num_episodes 200 \
  --output_dir /tmp/so101_demos

# LeRobot 형식 변환
uv run convert \
  --input_dir /tmp/so101_demos \
  --output_dir /tmp/so101_lerobot \
  --task_description "lift cube to target height"

# S3 업로드
uv run upload_s3 \
  --local_path /tmp/so101_data \
  --bucket my-workspace-bucket \
  --s3_prefix datasets/so101
```

### 분산 학습

```bash
# AWS Batch RL 학습 제출 (8개 GPU)
uv run submit_batch \
  --job_type rl \
  --job_name "workshop-lift" \
  --job_queue "gpu-queue" \
  --job_definition "workshop-rl-training" \
  --task Workshop-SO101-Lift-v0

# AWS Batch GR00T 파인튜닝 제출 (8개 GPU)
uv run submit_batch \
  --job_type groot \
  --job_name "workshop-groot" \
  --job_queue "gpu-queue" \
  --job_definition "workshop-groot-training" \
  --dataset_s3_uri "s3://my-workspace-bucket/datasets/so101_lerobot/" \
  --follow
```

### Closed-loop 시뮬레이션

```bash
# Policy Server 실행
python gr00t/eval/run_gr00t_server.py \
  --model-path /tmp/so101_finetune/checkpoint-2000 \
  --embodiment-tag NEW_EMBODIMENT \
  --modality-config-path ./configs/so101_modality_config.py \
  --host 0.0.0.0 \
  --port 5555

# Closed-loop 클라이언트 실행 (Policy Server 포함)
uv run closed_loop --policy_host localhost --instruction "lift the cube"
```

---

## GPU 요구사항 (GPU Requirements)

각 작업에 필요한 최소 GPU 메모리:

| 작업 | 최소 VRAM | 권장 인스턴스 | 참고 |
|------|----------|-------------|------|
| RL 학습 (PPO) | 20GB | 1x A100 40GB | `--num_envs 256` 기준 |
| GR00T 파인튜닝 | 35GB | 1x A100 40GB | 배치 크기 64 기준 |
| GR00T 분산 학습 | 20GB × 8 | 8x A100 40GB | AWS Batch |
| Policy Server | 15GB | 1x A100 40GB | 추론 전용 |
| Closed-loop 시뮬레이션 | 8GB | 1x A100 40GB | Isaac Sim 포함 |
| **전체 통합 (단일 노드)** | **40GB** | **1x A100 40GB** | 파인튜닝 + Policy Server + Closed-loop |

> **조언**: AWS A100 40GB 또는 H100을 권장합니다. T4나 V100으로도 가능하지만 속도가 느립니다.

---

## 트러블슈팅 (Troubleshooting)

### 일반 문제

| 증상 | 원인 | 해결책 |
|------|------|------|
| `list_envs` 실패 | Isaac Lab 설치 안 됨 | `cd Isaac-GR00T && uv sync --all-extras` 재실행 |
| `CUDA out of memory` | 배치 크기가 너무 큼 | `--num_envs 128` 으로 줄이기 또는 GPU 업그레이드 |
| Policy Server가 연결 안 됨 | 방화벽 또는 포트 차단 | `netstat -tuln \| grep 5555` 확인, DCV 보안 그룹 설정 확인 |
| Closed-loop에서 "Policy not loaded" | Policy Server 미시작 | Terminal 2에서 Policy Server 실행 확인 |
| `import workshop` 실패 | 경로 문제 | `cd ~/environment/Isaac-GR00T/exts/omni.isaac.sim_workshop && uv sync` 재실행 |

### 데이터 관련 문제

| 증상 | 원인 | 해결책 |
|------|------|------|
| HF 다운로드 실패 | 인터넷 연결 또는 저장소 문제 | `--repo_id` 확인, 인터넷 상태 체크 |
| LeRobot 변환 실패 | 데모 형식 불일치 | `collect` 명령어로 수집한 데이터 확인 |
| S3 업로드 느림 | 네트워크 또는 용량 큼 | 멀티파트 업로드 자동 사용, AWS 리전 확인 |

### Batch 작업 관련 문제

| 증상 | 원인 | 해결책 |
|------|------|------|
| Batch 작업 `RUNNABLE` 상태 | 큐 또는 컴퓨팅 환경 문제 | AWS 콘솔에서 컴퓨팅 환경 상태 확인 |
| "EFS mount failed" | EFS 마운트 설정 오류 | IAM 권한 확인, EFS 마운트 포인트 확인 |
| 체크포인트 안 보임 | `/efs/` 경로 설정 오류 | Batch 작업 정의의 `CHECKPOINT_DIR` 확인 |

### Isaac Sim 및 시각화 문제

| 증상 | 원인 | 해결책 |
|------|------|------|
| Isaac Sim 시작 안 됨 | GPU 드라이버 또는 X11 문제 | `nvidia-smi` 실행 확인, DCV 재연결 |
| SO-101 로봇 표시 안 됨 | URDF 로드 실패 | `setup.sh` 재실행하여 URDF 다운로드 |
| Closed-loop 액션 적용 안 됨 | gRPC 통신 실패 | `netstat -tuln` 에서 포트 5555 확인 |

---

## 환경 변수 (Environment Variables)

Batch 작업 또는 고급 설정을 위한 주요 환경 변수:

```bash
# GPU 설정
export CUDA_VISIBLE_DEVICES=0,1,2,3  # 사용할 GPU ID
export NUM_GPUS=4                     # GPU 개수

# 체크포인트 저장
export CHECKPOINT_DIR=/efs/checkpoints/groot

# Isaac Lab
export ISAAC_HEADLESS=1              # Headless 모드 (시각화 없음)
export ISAAC_NUM_ENVS=256            # 병렬 환경 개수

# GR00T
export LOGLEVEL=INFO                 # 로그 레벨 (DEBUG, INFO, WARNING, ERROR)
```

---

## 참고 자료 (References)

**공식 문서:**
- [NVIDIA Isaac Lab](https://docs.omniverse.nvidia.com/isaacsim/latest/index.html) - 로봇 시뮬레이션 프레임워크
- [NVIDIA GR00T](https://github.com/NVIDIA/Isaac-GR00T) - 멀티태스크 정책 모델
- [TheRobotStudio SO-ARM 100](https://github.com/TheRobotStudio/SO-ARM100) - SO-101 로봇 모델
- [HuggingFace LeRobot](https://github.com/huggingface/lerobot) - 로봇 데이터 표준

**AWS 서비스:**
- [AWS EC2 DCV](https://aws.amazon.com/ko/ec2/dcv/) - 원격 데스크톱
- [AWS Batch](https://aws.amazon.com/ko/batch/) - 대규모 분산 처리
- [AWS EFS](https://aws.amazon.com/ko/efs/) - 공유 파일 스토리지
- [AWS S3](https://aws.amazon.com/ko/s3/) - 객체 스토리지

**학습 자료:**
- [Isaac Lab 튜토리얼](https://docs.omniverse.nvidia.com/isaacsim/latest/manual_standalone_examples/rst/intermediate/tutorials/index.html)
- [강화학습 기초 (OpenAI Spinning Up)](https://spinningup.openai.com/)
- [GR00T 논문](https://arxiv.org/abs/2405.04031) - 원론문

**커뮤니티:**
- [NVIDIA Isaac Lab Discord](https://discord.gg/NVIDIA)
- [TheRobotStudio SO-ARM 포럼](https://github.com/TheRobotStudio/SO-ARM100/discussions)

---

## 문의 및 지원 (Support)

워크숍 중 문제가 발생하면:

1. **로그 확인**: 각 Terminal의 에러 메시지 읽기
2. **이 README의 트러블슈팅 섹션 참고**
3. **AWS 콘솔**: Batch 작업 상태, EC2 인스턴스 상태 확인
4. **커뮤니티**: 관련 GitHub 이슈 또는 Discord 채널 검색

---

**마지막 업데이트**: 2026년 4월 19일
**GR00T 버전**: N1.7-3B
**SO-ARM 버전**: 101
**Isaac Lab 버전**: ≥ 2.3.0
