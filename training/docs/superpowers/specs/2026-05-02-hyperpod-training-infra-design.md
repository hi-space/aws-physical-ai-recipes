# HyperPod 로봇 모델 학습 인프라 설계

## 개요

SageMaker HyperPod 기반의 로봇 모델 학습 인프라를 AWS에 구축한다.
AI 리서처가 인프라 지식 없이 VLA fine-tuning과 RL 학습을 실행할 수 있도록
SLURM 템플릿, 예시 코드, 가이드 문서를 함께 제공한다.

**주요 워크로드:**
- VLA 학습 (주 목적): GR00T-N1.6-3B, π0 계열 fine-tuning (Behavior Cloning / SFT)
- RL 학습 (옵션): IsaacLab + Online RL (Actor-Learner 구조, Ray on SLURM)
- 시각화 검증: 학습된 모델을 Isaac Sim에서 실행 확인 (DCV)

**위치:** `training/hyperpod/` (기존 Batch 기반 `isaac-lab-workshop/infra-multiuser-groot/`와 완전 별개 프로젝트)

---

## 아키텍처

### 클러스터 구성

단일 HyperPod 클러스터, 4개 Instance Group (SLURM 파티션 매핑):

| 파티션 | 인스턴스 타입 | 최대 수 | 역할 | 스케일링 |
|--------|-------------|---------|------|---------|
| head | ml.m5.xlarge | 1 | SLURM controller | 항상 ON |
| sim | ml.g5.12xlarge | 16 | IsaacLab Actor (RL) | Spot, 0→16 autoscale |
| train | ml.g6e.12xlarge | 4 | VLA/RL Learner (4×L40S 48GB) | OnDemand, 0→4 autoscale |
| debug | ml.g5.4xlarge | 1 | DCV 시각화 검증 | OnDemand, 0→1 autoscale |

- SLURM 오토스케일링: job 없으면 0대, job 제출 시 자동 확장, idle 후 자동 종료
- head-node만 상시 실행 (SLURM 스케줄러)

### 멀티유저 격리

기존 `infra-multiuser-groot` 패턴과 동일하게 사용자별 클러스터 완전 격리:

```bash
# 새 VPC 생성 (기본)
cdk deploy -c userId=alice
cdk deploy -c userId=bob

# 기존 VPC 재사용 (UserId 태그로 자동 탐색)
cdk deploy -c userId=alice -c createVpc=false

# Train 인스턴스 프리셋 사용
cdk deploy -c userId=alice -c trainPreset=heavy    # p4d.24xlarge (8×A100)
cdk deploy -c userId=alice -c trainPreset=max      # p5.48xlarge (8×H100)
```

격리 리소스: VPC(선택적), S3 Bucket, FSx for Lustre, HyperPod Cluster, MLflow Server
VPC 재사용: `createVpc=false` 시 동일 userId의 기존 VPC를 태그로 자동 탐색
식별: 스택명/리소스명에 userId 포함, UserId 태그로 비용 추적

### 인프라 다이어그램

```
┌─────────────────────────────────────────────────────────────────┐
│                    SageMaker HyperPod Cluster                    │
│                                                                 │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │ head        │  │ sim (Spot)       │  │ train            │   │
│  │ m5.xlarge×1 │  │ g5.12xlarge ≤16  │  │ g6e.12xlarge ≤4  │   │
│  │ SLURM ctrl  │  │ IsaacLab Actor   │  │ VLA/RL Learner   │   │
│  │ Always ON   │  │ Autoscale 0→16   │  │ Autoscale 0→4    │   │
│  └─────────────┘  └──────────────────┘  └──────────────────┘   │
│                                                                 │
│  ┌──────────────────┐                                           │
│  │ debug            │                                           │
│  │ g5.4xlarge ≤1    │                                           │
│  │ DCV 시각화       │                                           │
│  │ Autoscale 0→1    │                                           │
│  └──────────────────┘                                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
     ┌────────▼───┐  ┌─────▼─────┐  ┌───▼────────────┐
     │ FSx Lustre │  │    S3     │  │ SageMaker      │
     │ (고속 I/O) │  │ (데이터,  │  │ Managed MLflow │
     │ ↔ S3 연동  │  │  ckpt)    │  │ (실험 추적)    │
     └────────────┘  └───────────┘  └────────────────┘
```

---

## 스토리지 설계

### S3 Bucket 구조

```
s3://hyperpod-{userId}-{account}-{region}/
├── datasets/                  # 학습 데이터 (LeRobot v2, Open X-Embodiment)
│   ├── groot/
│   └── pi0/
├── checkpoints/               # 학습 체크포인트
│   ├── rl/{experiment}/{step}/
│   └── vla/{experiment}/{step}/
└── mlflow-artifacts/          # SageMaker MLflow artifact 자동 저장
```

### FSx for Lustre

```
/fsx/
├── datasets/    → S3 datasets/ (lazy load on read, auto-import)
├── checkpoints/ → S3 checkpoints/ (write-back, auto-export)
└── scratch/     # 임시 데이터 (시뮬 버퍼 등, S3 미동기화)
```

- 용량: 1.2TB (최소 단위, CDK context로 조절 가능)
- Throughput: 125 MB/s/TiB
- S3 Data Repository Association으로 자동 동기화
- Auto-import/export 정책 활성화

### 데이터 흐름

1. **VLA 학습:** S3에 데이터셋 업로드 → FSx에서 고속 읽기 → 학습 → 체크포인트 FSx → S3 write-back
2. **RL 학습:** sim에서 trajectory 생성 → FSx scratch 버퍼링 → train에서 학습 → 체크포인트 FSx → S3
3. **검증:** debug에서 FSx 체크포인트 로드 → Isaac Sim 실행

---

## 워크로드별 실행 방식

### VLA 학습 (GR00T / π0 fine-tuning)

```bash
sbatch finetune_groot.sbatch --dataset aloha --epochs 50
```

- train 파티션 g6e.12xlarge 할당 (4× L40S)
- Enroot로 NGC 컨테이너 실행 (`nvcr.io/nvidia/gr00t` 또는 커스텀 π0 이미지)
- torchrun --nproc_per_node=4 (DDP, 멀티노드 시 --nnodes 추가)
- MLflow에 loss, accuracy, learning_rate 기록
- 체크포인트 → /fsx/checkpoints/vla/{exp}/

### RL 학습 (Actor-Learner on Ray)

```bash
./run_rl.sh --env Cartpole --num-actors 8
```

1. sbatch learner.sbatch → train 파티션에 Ray head 시작
2. sbatch actor.sbatch --array=0-7 → sim 파티션에 Ray worker 8개
3. Ray Actor-Learner 연결 (같은 VPC, 저레이턴시)
4. MLflow에 reward, episode_length 자동 기록
5. 체크포인트 → /fsx/checkpoints/rl/{exp}/

컨테이너: `nvcr.io/nvidia/isaac-sim` + IsaacLab + Ray

### 시각화 검증 (DCV)

```bash
sbatch dcv_session.sbatch
```

1. debug 파티션 g5.4xlarge 할당
2. DCV 서버 시작, 접속 URL 출력
3. Isaac Sim GUI 실행
4. /fsx/checkpoints/에서 학습된 모델 로드
5. 시뮬레이션 환경에서 policy 실행 + 시각적 확인

접속: SSM Session Manager → 포트포워딩 → DCV 클라이언트

---

## 컨테이너 런타임

- **Enroot + Pyxis** (NVIDIA 표준, HyperPod 공식 지원)
- NGC 컨테이너를 SLURM job에서 네이티브 실행
- lifecycle script에서 자동 설치

```bash
# SLURM job 내 컨테이너 실행 예시
srun --partition=train \
  --container-image=nvcr.io/nvidia/gr00t:latest \
  --container-mounts=/fsx:/fsx \
  python train_groot.py
```

---

## 실험 추적: SageMaker Managed MLflow

- 별도 MLflow 서버 관리 불필요
- Artifact → S3 자동 저장
- IAM 인증 (별도 계정/패스워드 불필요)
- SageMaker Studio UI에서 확인
- 표준 MLflow SDK API 호환

VPC 내 접근: SageMaker VPC Endpoint 프로비저닝 (CDK에서 함께 생성)

```python
# 리서처 코드 (예시)
import mlflow

mlflow.set_tracking_uri(TRACKING_URI)  # CDK output에서 확인
mlflow.set_experiment("groot-finetune-aloha")

with mlflow.start_run():
    mlflow.log_param("dataset", "aloha")
    mlflow.log_metric("loss", loss, step=epoch)
    mlflow.log_artifact("checkpoint.pt")
```

---

## CDK 인프라 코드 구조

```
training/hyperpod/
├── cdk/                          # CDK 프로젝트 (TypeScript)
│   ├── bin/app.ts
│   ├── lib/
│   │   ├── hyperpod-stack.ts     # 메인 스택
│   │   ├── constructs/
│   │   │   ├── networking.ts     # VPC, Subnets, NAT, VPC Endpoints
│   │   │   ├── storage.ts        # FSx for Lustre + S3 연동
│   │   │   ├── hyperpod.ts       # HyperPod Cluster (CfnCluster)
│   │   │   └── mlflow.ts         # SageMaker MLflow Tracking Server
│   │   └── config/
│   │       └── cluster-config.ts # 인스턴스 그룹, 파티션 설정값
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
│
├── cluster-config/               # 수동 배포용 설정
│   ├── cluster-config.json       # HyperPod 클러스터 설정
│   ├── provisioning-params.json  # lifecycle script 파라미터
│   └── manual-setup.md           # CLI 수동 생성 가이드
│
├── lifecycle-scripts/            # HyperPod lifecycle scripts
│   ├── on_create.sh              # 노드 초기화 (Enroot, Pyxis, EFA)
│   ├── setup_slurm.sh            # SLURM 파티션/오토스케일링 설정
│   └── setup_fsx.sh              # FSx 마운트
│
├── slurm-templates/              # 리서처용 SLURM job 템플릿
│   ├── rl/
│   │   ├── actor.sbatch          # IsaacLab headless Actor
│   │   ├── learner.sbatch        # RL Learner (Ray)
│   │   └── run_rl.sh             # Actor-Learner 동시 제출 스크립트
│   ├── vla/
│   │   ├── finetune_groot.sbatch # GR00T fine-tuning
│   │   ├── finetune_pi0.sbatch   # π0 fine-tuning
│   │   └── run_vla.sh            # VLA 학습 실행 스크립트
│   └── debug/
│       └── dcv_session.sbatch    # DCV 시각화 세션
│
├── examples/                     # End-to-end 예시 코드
│   ├── vla/
│   │   ├── train_groot.py        # GR00T fine-tuning 최소 예시
│   │   ├── train_pi0.py          # π0 fine-tuning 최소 예시
│   │   └── verify_in_sim.py      # 학습 모델 → Isaac Sim 검증
│   ├── rl/
│   │   ├── train_isaaclab.py     # IsaacLab RL (Actor-Learner)
│   │   └── ray_config.yaml       # Ray on SLURM 설정
│   └── mlflow/
│       └── example_tracking.py   # MLflow 기록 예시 (RL + VLA)
│
├── mlflow/                       # MLflow 관련 설정
│   ├── setup.sh                  # SageMaker MLflow 초기 설정
│   └── example_usage.py          # 리서처용 사용 예시
│
└── docs/
    ├── researcher_guide.md       # 리서처 가이드
    └── architecture.md           # 아키텍처 설명 문서
```

### CDK Context 파라미터

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| userId | (필수) | 사용자 식별자 (스택/리소스 격리) |
| createVpc | true | false이면 UserId 태그로 기존 VPC 자동 탐색하여 재사용 |
| simMaxCount | 16 | sim 파티션 최대 인스턴스 수 |
| trainMaxCount | 4 | train 파티션 최대 인스턴스 수 |
| simInstanceType | ml.g5.12xlarge | sim 파티션 인스턴스 타입 |
| trainInstanceType | ml.g6e.12xlarge | train 파티션 인스턴스 타입 (직접 지정) |
| trainPreset | default | train 프리셋: default(g6e), heavy(p4d), max(p5) |
| fsxCapacityGiB | 1200 | FSx 용량 (GiB) |
| simUseSpot | true | sim 파티션 Spot 사용 여부 |

#### Train 인스턴스 프리셋

| 프리셋 | 인스턴스 | GPU | 적합한 작업 |
|--------|---------|-----|------------|
| default | ml.g6e.12xlarge | 4× L40S (48GB) | GR00T-3B LoRA/Full SFT |
| heavy | ml.p4d.24xlarge | 8× A100 (40GB) | 대규모 VLA, 멀티노드 |
| max | ml.p5.48xlarge | 8× H100 (80GB) | 큰 모델 full fine-tuning |

### CDK 스택 생성 리소스

1. **Networking** — VPC, Public/Private Subnets, NAT Gateway, S3/SageMaker VPC Endpoints
2. **Storage** — S3 bucket, FSx for Lustre (S3 Data Repository Association)
3. **HyperPod** — `AWS::SageMaker::Cluster` (4개 Instance Group, lifecycle script S3 업로드)
4. **MLflow** — SageMaker MLflow Tracking Server (artifact → S3)

---

## 보안 및 접근

| 접근 경로 | 방식 |
|----------|------|
| Head-node SSH | SSM Session Manager (IAM 인증, 퍼블릭 IP 불필요) |
| DCV 시각화 | SSM 포트포워딩 → localhost:8443 |
| MLflow UI | SageMaker Studio (IAM 인증) |
| S3 데이터 | IAM Role (클러스터에 자동 부여) |

---

## 비용 구조

| 항목 | 상시 비용 | 사용 시만 |
|------|----------|----------|
| Head-node (m5.xlarge) | ~$0.192/hr | - |
| FSx for Lustre (1.2TB) | ~$0.14/hr | - |
| sim (g5.12xlarge × N) | - | ~$5.67/hr × N (Spot ~70% 할인) |
| train (g6e.12xlarge × N) | - | ~$6.68/hr × N |
| debug (g5.4xlarge) | - | ~$1.62/hr |
| MLflow | ~$0.06/hr | - |

Idle 시: ~$0.39/hr (head + FSx + MLflow만)

---

## 리서처 온보딩

```
1. SSM으로 head-node 접속
   → aws ssm start-session --target <instance-id>

2. 환경 확인
   → sinfo (파티션 상태)
   → df -h /fsx (스토리지)

3. 데이터 업로드
   → aws s3 cp ./my_dataset s3://bucket/datasets/groot/ --recursive
   → ls /fsx/datasets/groot/ (자동 동기화 확인)

4. 학습 실행
   → sbatch slurm-templates/vla/finetune_groot.sbatch

5. 결과 확인
   → SageMaker Studio MLflow UI
   → sbatch slurm-templates/debug/dcv_session.sbatch (시각화)
```

---

## 리서처 명령어 요약

| 하고 싶은 일 | 명령어 |
|-------------|--------|
| RL 학습 시작 | `./run_rl.sh --env Humanoid --num-actors 16` |
| VLA fine-tuning | `sbatch finetune_groot.sbatch --dataset aloha` |
| 학습 모니터링 | SageMaker Studio → MLflow UI |
| 시각화 검증 | `sbatch dcv_session.sbatch` → DCV 접속 |
| 학습 취소 | `scancel <job_id>` |
| 상태 확인 | `squeue` |

---

## 참고 개념 (aws-samples/sample-physical-ai-scaffolding-kit)

참고한 것:
- FSx for Lustre ↔ S3 연동 방식
- Controller / Worker 노드 분리 구조
- SSM Session Manager 기반 접근 방식
- SLURM + Enroot 컨테이너 런타임 패턴

새로 구현하는 것:
- IsaacLab headless + DCV 검증 (SLURM interactive job)
- Online RL Actor-Learner (Ray on SLURM)
- SageMaker Managed MLflow 통합
- VLA fine-tuning SLURM 템플릿 (GR00T, π0)
- End-to-end 예시 (학습 → Isaac Sim 검증)
- 멀티유저 격리 (CDK context userId)
