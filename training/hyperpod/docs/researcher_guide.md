# HyperPod 클러스터 리서처 가이드

SageMaker HyperPod 클러스터에서 GR00T VLA 모델을 fine-tuning하는 방법을 설명합니다.

## 1. 클러스터 접속

### Jump Host를 통한 SSH 접속

CDK 배포 시 Jump Host가 생성됩니다. Jump Host를 통해 Head Node에 접속합니다.

```bash
# Jump Host IP 확인 (CloudFormation Output)
JUMP_HOST_IP=$(aws cloudformation describe-stacks \
  --stack-name HyperPod \
  --query "Stacks[0].Outputs[?OutputKey=='JumpHostPublicIp'].OutputValue" \
  --output text)

# Jump Host → Head Node SSH
ssh -i ~/.ssh/hyperpod-key.pem ubuntu@${JUMP_HOST_IP}
ssh head-node
```

### SSM Session Manager로 직접 접속

```bash
# 클러스터 이름 확인
CLUSTER_NAME=$(aws cloudformation describe-stacks \
  --stack-name HyperPod \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" \
  --output text)

# Head-node 인스턴스 ID 확인
INSTANCE_ID=$(aws sagemaker list-cluster-nodes \
  --cluster-name ${CLUSTER_NAME} \
  --query "clusterNodeSummaries[?instanceGroupName=='head'].instanceId" \
  --output text)

# SSM Session Manager로 접속
aws ssm start-session --target sagemaker-cluster:${CLUSTER_NAME}_${INSTANCE_ID}
```

## 2. 환경 확인

```bash
# SLURM 클러스터 상태 (단일 dev 파티션)
sinfo

# FSx 마운트 확인
df -h /fsx

# GPU 상태
nvidia-smi

# 작업 큐
squeue
```

예상 출력:
```
$ sinfo
PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST
dev*         up   infinite      1   idle ip-10-0-...
```

> **참고**: HyperPod Managed SLURM 모드에서는 단일 `dev` 파티션이 자동 생성됩니다.

## 3. 환경 설정 (최초 1회)

Head Node에 접속 후 환경 설정 스크립트를 실행합니다:

```bash
bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_environment.sh
```

이 스크립트는:
1. 레포지토리를 FSx에 clone
2. GR00T 학습 컨테이너를 빌드하여 ECR → Enroot로 import
3. Head node에 Python 패키지 설치 (mlflow, boto3 등)
4. FSx에 디렉토리 구조 생성

컨테이너 빌드에 20-30분 소요됩니다. 완료 후 `/fsx/enroot/data/gr00t-train+latest.sqsh` 파일이 생성됩니다.

### 수동 컨테이너 빌드 (선택)

setup_environment.sh 대신 단계별로 실행할 수도 있습니다:

```bash
REPO_DIR="/fsx/scratch/aws-physical-ai-recipes/training/hyperpod"

# 1. Docker 빌드 → ECR 푸시
bash ${REPO_DIR}/container/build_and_push_ecr.sh

# 2. ECR → Enroot import
bash ${REPO_DIR}/container/import_container.sh
```

## 4. 데이터 준비

### S3 → FSx 자동 동기화

HyperPod은 S3 Data Repository Association을 통해 자동 동기화합니다:
- S3 업로드 → FSx에 자동 반영 (AutoImportPolicy: NEW_CHANGED_DELETED)

```bash
# 로컬 데이터를 S3에 업로드
aws s3 cp ./my_dataset s3://<DATA_BUCKET>/datasets/groot/my_dataset --recursive

# FSx에서 확인
ls /fsx/datasets/groot/my_dataset
```

### 데이터셋 형식 (LeRobot v2)

GR00T fine-tuning은 LeRobot v2 형식 데이터를 사용합니다:

```
/fsx/datasets/groot/<dataset_name>/
├── episodes/
│   ├── episode_000000/
│   │   ├── data.parquet       # 상태/액션 데이터
│   │   └── video_*.mp4        # 카메라 영상
│   └── ...
├── tasks.parquet              # 태스크 메타데이터
└── file-000.parquet           # 글로벌 인덱스
```

### 샘플 데이터 다운로드

```bash
python /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/examples/vla/download_dataset.py
```

## 5. VLA 학습 실행

### 기본 학습 (1 GPU)

```bash
sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot.sbatch
```

### 파라미터 커스터마이징

환경변수로 학습 설정을 변경할 수 있습니다:

```bash
# 커스텀 데이터셋, 4GPU, 5000 steps
NUM_GPUS=4 \
DATASET=aloha \
EMBODIMENT_TAG=aloha \
MAX_STEPS=5000 \
GLOBAL_BATCH_SIZE=64 \
sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot.sbatch
```

### 주요 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `NUM_GPUS` | 1 | GPU 수 |
| `DATASET` | demo_data | 데이터셋 이름 (/fsx/datasets/groot/ 하위) |
| `DATASET_PATH` | (DATASET으로 계산) | 전체 데이터셋 경로 (직접 지정 시) |
| `BASE_MODEL` | nvidia/GR00T-N1.6-3B | 기본 모델 |
| `EMBODIMENT_TAG` | new_embodiment | 로봇 embodiment 태그 |
| `MAX_STEPS` | 2000 | 총 학습 스텝 |
| `GLOBAL_BATCH_SIZE` | 32 | 전체 배치 크기 |
| `SAVE_STEPS` | 2000 | 체크포인트 저장 간격 |
| `OUTPUT_DIR` | /fsx/checkpoints/vla/groot-<DATASET> | 체크포인트 저장 경로 |

### 작업 모니터링

```bash
# 작업 상태
squeue

# 로그 실시간 확인
tail -f /fsx/scratch/logs/groot-<JOB_ID>.out

# 작업 상세
scontrol show job <JOB_ID>

# 작업 취소
scancel <JOB_ID>
```

## 6. MLflow 추적

CDK 배포 시 SageMaker Managed MLflow가 자동 생성됩니다.

### MLflow URI 확인

```bash
# AWS Console → SageMaker → MLflow Tracking Servers
# 또는 CloudFormation Output에서 확인

export MLFLOW_TRACKING_URI="arn:aws:sagemaker:<REGION>:<ACCOUNT>:mlflow-tracking-server/HyperPod-mlflow"
```

### MLflow 통합 학습

`train_groot.py`를 사용하면 MLflow가 자동으로 연동됩니다:

```bash
MLFLOW_TRACKING_URI="<ARN>" \
sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/vla/finetune_groot.sbatch
```

### MLflow UI 접속

SageMaker Console → MLflow Tracking Servers → Open UI 에서 확인 가능합니다.

## 7. SLURM 자주 쓰는 명령어

```bash
# 클러스터 상태
sinfo
sinfo -N -l

# 작업 제출
sbatch job.sbatch
JOB_ID=$(sbatch --parsable job.sbatch)

# 작업 모니터링
squeue
squeue -u $USER
scontrol show job <JOB_ID>

# 인터랙티브 세션 (GPU 1개)
srun --partition=dev --gres=gpu:1 --pty bash

# 컨테이너 안에서 인터랙티브
srun --partition=dev --gres=gpu:1 \
  --container-image=/fsx/enroot/data/gr00t-train+latest.sqsh \
  --container-mounts=/fsx:/fsx \
  --pty bash

# 작업 취소
scancel <JOB_ID>
scancel -u $USER

# 이력 조회
sacct -j <JOB_ID> --format=JobID,JobName,State,Elapsed,MaxRSS
```

## 8. 트러블슈팅

### 컨테이너 not found

```bash
# 확인
ls -lh /fsx/enroot/data/gr00t-train+latest.sqsh

# 없으면 다시 빌드
bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/container/build_and_push_ecr.sh
bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/container/import_container.sh
```

### 작업이 PENDING 상태

```bash
# 리소스 부족인지 확인
sinfo
scontrol show job <JOB_ID> | grep Reason

# Compute 노드가 부족하면 HyperPod Auto-scaling이 노드를 추가합니다 (수 분 소요)
```

### GPU OOM

```bash
# 배치 크기를 줄여서 재실행
GLOBAL_BATCH_SIZE=16 sbatch finetune_groot.sbatch
```

### FSx에 데이터가 보이지 않음

```bash
# FSx 마운트 확인
df -h /fsx

# S3에 데이터가 있는지 확인
aws s3 ls s3://<DATA_BUCKET>/datasets/groot/

# HSM restore (lazy loading 시)
lfs hsm_restore /fsx/datasets/groot/<file>
```

## 9. 인스턴스 타입 참고

HyperPod는 `ml.*` 접두사 인스턴스만 사용 가능합니다 (일반 EC2 인스턴스 불가).

| 프리셋 | 인스턴스 | GPU | 용도 |
|--------|----------|-----|------|
| default | ml.g5.12xlarge | 4× A10G (24GB) | GR00T-3B fine-tuning |
| light | ml.g5.4xlarge | 1× A10G (24GB) | 소규모 테스트 |
| perf | ml.g6e.12xlarge | 4× L40S (48GB) | 큰 배치, 빠른 학습 |
| heavy | ml.p4d.24xlarge | 8× A100 (40GB) | 대규모 분산 학습 |

> **참고**: 사용 전 해당 리전의 ml 인스턴스 Service Quota를 확인하세요.
> AWS Console → Service Quotas → Amazon SageMaker에서 조회/요청 가능합니다.

## 참고 문서

- [AWS SageMaker HyperPod](https://docs.aws.amazon.com/sagemaker/latest/dg/hyperpod-overview.html)
- [SLURM Documentation](https://slurm.schedmd.com/)
- [NVIDIA Isaac-GR00T](https://github.com/NVIDIA/Isaac-GR00T)
- [NVIDIA Enroot](https://github.com/NVIDIA/enroot)
