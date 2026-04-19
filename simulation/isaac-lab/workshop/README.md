# GR00T + SO-ARM 101 Workshop

> Isaac Lab 시뮬레이션에서 SO-ARM 101 로봇의 RL 정책을 학습하고, NVIDIA GR00T N1.7 파운데이션 모델을 파인튜닝하여 Isaac Sim 내 SO-101을 Closed-loop으로 제어하는 핸즈온 워크숍

| 항목 | 내용 |
|------|------|
| **소요 시간** | Fast Track ~1.5시간 / Deep Dive ~2.5시간 |
| **난이도** | Level 300 (Advanced) |
| **대상** | SA/개발자 또는 ML 엔지니어, 10~30명 |
| **사전 요구** | CDK로 배포된 GPU EC2 인스턴스 ([infra-multiuser-groot](../infra-multiuser-groot/)) |
| **GPU** | g6.12xlarge (4x L40S, 192 GiB) 권장 |
| **AWS 서비스** | EC2 DCV, EFS, Batch, S3 |

## 프로젝트 구조

```
simulation/isaac-lab/workshop/
├── README.md                              # 이 문서
├── pyproject.toml                         # Python 패키지 설정 + CLI entry points
├── setup.sh                               # 환경 셋업 스크립트
├── configs/
│   ├── modality.json                      # SO-101 state/action 인덱스 매핑
│   └── so101_modality_config.py           # GR00T 모달리티 등록
├── batch/
│   ├── Dockerfile.groot                   # GR00T 파인튜닝 Batch 컨테이너
│   └── entrypoint.sh                      # Batch Job 진입점
└── src/workshop/
    ├── robots/
    │   ├── so_arm101.py                   # ArticulationCfg (로봇 정의)
    │   └── urdf/                          # URDF + STL (setup.sh가 다운로드)
    ├── tasks/
    │   ├── reach/                         # Reach 태스크 (엔드이펙터 위치 추적)
    │   │   ├── reach_env_cfg.py
    │   │   └── agents/rsl_rl_ppo_cfg.py
    │   └── lift/                          # Lift 태스크 (큐브 들어올리기)
    │       ├── lift_env_cfg.py
    │       └── agents/rsl_rl_ppo_cfg.py
    └── scripts/
        ├── list_envs.py                   # 등록된 환경 목록
        ├── train_rl.py                    # RL 학습
        ├── play_rl.py                     # 학습된 정책 시각화
        ├── collect_demos.py               # 시연 데이터 수집
        ├── convert_to_lerobot.py          # LeRobot v2.1 형식 변환
        ├── download_hf_dataset.py         # HuggingFace 데이터셋 다운로드
        ├── upload_s3.py                   # S3 업로드
        ├── submit_batch_job.py            # AWS Batch Job 제출
        └── run_closed_loop.py             # Closed-loop 시뮬레이션 클라이언트
```

## 등록된 환경

| 환경 ID | 설명 | 용도 |
|---------|------|------|
| `Workshop-SO101-Reach-v0` | 엔드이펙터 → 목표 위치 도달 | RL 학습 (4096 envs) |
| `Workshop-SO101-Reach-Play-v0` | Reach 시각화용 | 학습 결과 확인 (50 envs) |
| `Workshop-SO101-Lift-v0` | 큐브 집어 목표 높이로 들어올리기 | RL 학습 (4096 envs) |
| `Workshop-SO101-Lift-Play-v0` | Lift 시각화용 | 학습 결과 확인 (50 envs) |

---

## Module 0: 환경 셋업 (~10분)

CDK로 배포된 EC2 인스턴스에 DCV로 접속한 상태에서 시작합니다.

### 0-1. DCV 접속

브라우저에서 `https://<Instance-Public-IP>:8443` 접속 후 로그인합니다.

### 0-2. Isaac Lab 환경 설치 (newton-setup)

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/newton-setup
bash setup.sh
source ~/.bashrc
```

이 스크립트가 완료되면:
- Python 3.11 venv (`~/venv311`) 활성화
- IsaacLab (feature/newton) + Isaac Sim 5.1.0 설치
- `~/.bashrc`에 자동 활성화 설정

### 0-3. Isaac-GR00T 클론

```bash
cd ~/environment
git clone https://github.com/NVIDIA/Isaac-GR00T.git
cd Isaac-GR00T
pip install -e ".[all]"
```

### 0-4. 워크숍 셋업

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop
bash setup.sh
```

이 스크립트가 수행하는 작업:
1. Python 환경 확인 (venv311 활성화 여부, isaaclab 설치 확인)
2. 워크숍 추가 의존성 설치 (pandas, pyarrow, boto3, pyzmq)
3. 워크숍 패키지 editable 설치 (`pip install --no-deps -e .`)
4. SO-ARM 101 URDF + STL 메시 다운로드 (TheRobotStudio 공식)
5. 등록된 환경 검증

### 0-5. 환경 검증

```bash
list_envs
```

예상 출력:
```
Registered workshop environments (4):

  Workshop-SO101-Lift-Play-v0
  Workshop-SO101-Lift-v0
  Workshop-SO101-Reach-Play-v0
  Workshop-SO101-Reach-v0
```

---

## Module 1: 데이터 준비

GR00T 파인튜닝에 사용할 LeRobot v2.1 형식 SO-101 데이터셋을 확보합니다.

### Fast Track: HuggingFace 데이터셋 (~20분)

#### 1-1. 데이터 다운로드 + 변환

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop

download_hf \
  --repo_id izuluaga/finish_sandwich \
  --output_dir /tmp/so101_data
```

#### 1-2. S3 업로드

```bash
upload_s3 \
  --local_path /tmp/so101_data/izuluaga/finish_sandwich \
  --bucket <your-bucket> \
  --s3_prefix datasets/so101
```

---

### Deep Dive: Isaac Lab RL → 데이터 수집 (~50분)

#### 1-1. RL 학습

**DCV에서 직접 학습:**

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop

train_rl --task Workshop-SO101-Lift-v0 --headless
```

**또는 AWS Batch 분산 학습:**

```bash
submit_batch \
  --job_type rl \
  --task Workshop-SO101-Lift-v0 \
  --job_name workshop-lift-rl \
  --job_queue <queue-name> \
  --job_definition <job-def-name> \
  --follow
```

#### 1-2. 학습 결과 확인

```bash
play_rl \
  --task Workshop-SO101-Lift-Play-v0 \
  --checkpoint logs/rsl_rl/lift_so101/<timestamp>/checkpoints/best_agent.pt
```

#### 1-3. 시연 데이터 수집

```bash
collect \
  --task Workshop-SO101-Lift-Play-v0 \
  --checkpoint logs/rsl_rl/lift_so101/<timestamp>/checkpoints/best_agent.pt \
  --num_episodes 200 \
  --output_dir /tmp/so101_demos
```

#### 1-4. LeRobot v2.1 변환

```bash
convert \
  --input_dir /tmp/so101_demos \
  --output_dir /tmp/so101_lerobot \
  --task_description "lift cube to target height"
```

#### 1-5. 통계량 생성

```bash
cd ~/environment/Isaac-GR00T

python gr00t/data/stats.py \
  --dataset-path /tmp/so101_lerobot \
  --embodiment-tag NEW_EMBODIMENT \
  --modality-config-path ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop/configs/so101_modality_config.py
```

#### 1-6. S3 업로드

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop

upload_s3 \
  --local_path /tmp/so101_lerobot \
  --bucket <your-bucket> \
  --s3_prefix datasets/so101_lerobot
```

**산출물**: S3에 LeRobot v2.1 SO-101 데이터셋

---

## Module 2+3: GR00T 파인튜닝 + 실시간 Closed-loop (~40~60분)

학습과 시각화가 병렬로 진행됩니다. EFS를 통해 학습 중간 체크포인트를 공유하여, Isaac Sim에서 모델이 점점 나아지는 과정을 시각적으로 체험합니다.

### Closed-loop 아키텍처

```
┌─────────────────────────────────────────────┐
│  학습 (AWS Batch 또는 DCV 단일 GPU)          │
│  GR00T 파인튜닝                              │
│  → 매 N step 체크포인트 저장                  │
└──────────────────┬──────────────────────────┘
                   │ EFS (/efs/checkpoints/groot/)
                   ▼
┌─────────────────────────────────────────────┐
│  DCV 인스턴스                                │
│                                              │
│  Terminal 1: GR00T Policy Server (ZMQ :5555) │
│              최신 checkpoint 로드             │
│                                              │
│  Terminal 2: Isaac Sim + Closed-loop Client   │
│              observation → Policy Server      │
│              ← 16-step action sequence        │
│              action 적용 → SO-101 동작        │
└─────────────────────────────────────────────┘
```

### Fast Track: 단일 GPU (DCV) (~40분)

Terminal 3개를 준비합니다.

**Terminal 1 — GR00T 파인튜닝:**

```bash
cd ~/environment/Isaac-GR00T

CUDA_VISIBLE_DEVICES=0 NUM_GPUS=1 uv run bash examples/finetune.sh \
  --base-model-path nvidia/GR00T-N1.7-3B \
  --dataset-path /tmp/so101_lerobot \
  --modality-config-path ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop/configs/so101_modality_config.py \
  --embodiment-tag NEW_EMBODIMENT \
  --output-dir /tmp/so101_finetune
```

**Terminal 2 — Policy Server** (체크포인트가 생성된 후):

```bash
cd ~/environment/Isaac-GR00T

uv run python gr00t/eval/run_gr00t_server.py \
  --model-path /tmp/so101_finetune/checkpoint-2000 \
  --embodiment-tag NEW_EMBODIMENT \
  --modality-config-path ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop/configs/so101_modality_config.py \
  --host 0.0.0.0 --port 5555
```

**Terminal 3 — Closed-loop 시뮬레이션:**

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop

closed_loop --policy_host localhost --instruction "lift the cube"
```

Isaac Sim이 시작되고, SO-101이 GR00T Policy Server의 명령을 받아 동작합니다. 체크포인트가 갱신되면 Policy Server를 재시작하여 개선된 모델을 확인할 수 있습니다.

---

### Deep Dive: AWS Batch 분산 학습 (~60분)

#### 2-1. Batch 학습 시작

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop

submit_batch \
  --job_type groot \
  --job_name workshop-groot-finetune \
  --job_queue <queue-name> \
  --job_definition <job-def-name> \
  --dataset_s3_uri s3://<bucket>/datasets/so101_lerobot \
  --max_steps 10000 \
  --batch_size 32 \
  --save_steps 2000 \
  --follow
```

#### 2-2. EFS 체크포인트 확인 (DCV)

```bash
watch -n 10 "ls -lht /efs/checkpoints/groot/ | head -10"
```

#### 2-3. Policy Server 기동 (DCV — 최신 체크포인트)

```bash
cd ~/environment/Isaac-GR00T

uv run python gr00t/eval/run_gr00t_server.py \
  --model-path /efs/checkpoints/groot/checkpoint-2000 \
  --embodiment-tag NEW_EMBODIMENT \
  --modality-config-path ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop/configs/so101_modality_config.py \
  --host 0.0.0.0 --port 5555
```

#### 2-4. Closed-loop 확인 (DCV)

```bash
cd ~/environment/aws-physical-ai-recipes/simulation/isaac-lab/workshop

closed_loop --policy_host localhost --instruction "lift the cube"
```

체크포인트가 갱신될 때마다 Policy Server를 리로드하면 모델이 점점 개선되는 과정을 시각적으로 체험할 수 있습니다.

---

## 시간 견적

| 조합 | Module 0 | Module 1 | Module 2+3 | 합계 |
|------|----------|----------|------------|------|
| All Fast Track | 10분 | 20분 | 40분 | **~1.5시간** |
| M1 Deep + M2+3 Fast | 10분 | 50분 | 40분 | **~2시간** |
| M1 Fast + M2+3 Deep | 10분 | 20분 | 60분 | **~1.5시간** + Batch 대기 |
| All Deep Dive | 10분 | 50분 | 60분 | **~2.5시간** |

## GPU 요구사항

| 작업 | 최소 VRAM | 인프라 |
|------|----------|--------|
| Isaac Lab RL 학습 | 12GB+ | DCV 또는 AWS Batch |
| Isaac Sim 시각화 + Policy Server | 16GB+ | DCV 인스턴스 |
| GR00T 파인튜닝 (단일 GPU) | 40GB+ | DCV 인스턴스 (1x L40S) |
| GR00T 파인튜닝 (분산) | 4x 48GB | AWS Batch (멀티노드) |

---

## 트러블슈팅

### 일반

| 증상 | 원인 | 해결 |
|------|------|------|
| `ModuleNotFoundError: isaaclab` | newton-setup 미실행 | `bash newton-setup/setup.sh && source ~/.bashrc` |
| `import workshop` 실패 | 워크숍 패키지 미설치 | `cd workshop && pip install --no-deps -e .` |
| `list_envs` 환경 안 보임 | tasks import 실패 | `python -c "import workshop"` 에러 메시지 확인 |

### 데이터

| 증상 | 원인 | 해결 |
|------|------|------|
| `IndexError` GR00T 학습 중 | stats.json 미생성 | `gr00t/data/stats.py` 실행 |
| `modality.json` 오류 | 인덱스 불일치 | start/end 범위 확인 (arm: 0-5, gripper: 5-6) |
| HF 다운로드 실패 | 네트워크 또는 repo_id 오류 | `--repo_id` 확인, 인터넷 상태 체크 |

### Batch / 인프라

| 증상 | 원인 | 해결 |
|------|------|------|
| Batch Job `RUNNABLE` 멈춤 | GPU 인스턴스 부족 | AWS 콘솔에서 컴퓨팅 환경 상태 확인 |
| EFS 체크포인트 안 보임 | 마운트 경로 불일치 | `CHECKPOINT_DIR` 환경변수 확인 |
| `CUDA out of memory` | 배치 크기 과다 | `GLOBAL_BATCH_SIZE=16` 또는 `--num_envs 1024` |

### Isaac Sim

| 증상 | 원인 | 해결 |
|------|------|------|
| Isaac Sim 시작 안 됨 | GPU 드라이버 문제 | `nvidia-smi` 확인, DCV 재접속 |
| URDF 로드 실패 | 파일 미다운로드 | `bash setup.sh` 재실행 |
| Policy Server 연결 실패 | 포트 미오픈 | `netstat -tuln | grep 5555` 확인 |

---

## 참고 자료

- [NVIDIA Isaac Lab](https://github.com/isaac-sim/IsaacLab) — GPU 가속 로봇 시뮬레이션
- [NVIDIA GR00T N1.7](https://github.com/NVIDIA/Isaac-GR00T) — VLA 파운데이션 모델
- [GR00T Models (HuggingFace)](https://huggingface.co/collections/nvidia/gr00t-n17)
- [SO-ARM 100 (TheRobotStudio)](https://github.com/TheRobotStudio/SO-ARM100) — 로봇 공식 설계
- [HuggingFace LeRobot](https://github.com/huggingface/lerobot) — 로봇 학습 프레임워크
