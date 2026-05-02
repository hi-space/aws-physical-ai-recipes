# HyperPod 클러스터 리서처 가이드

이 가이드는 SageMaker HyperPod 클러스터를 사용하여 VLA(Vision Language Action) 및 RL 학습을 실행하는 방법을 설명합니다.

## 1. 클러스터 접속

### SSM Session Manager로 Head-Node 접속

```bash
# 클러스터 이름 확인
CLUSTER_NAME="hyperpod-robotics"

# Head-node 인스턴스 ID 확인
INSTANCE_ID=$(aws sagemaker list-cluster-nodes \
  --cluster-name ${CLUSTER_NAME} \
  --query "clusterNodeSummaries[?instanceGroupName=='head'].instanceId" \
  --output text)

# SSM Session Manager로 접속
aws ssm start-session --target ${INSTANCE_ID}
```

## 2. 환경 확인

Head-node에 접속한 후 다음 명령어로 클러스터 상태를 확인합니다:

```bash
# SLURM 파티션 및 노드 상태 확인
sinfo

# FSx 디스크 사용량 확인
df -h /fsx

# GPU 상태 확인
nvidia-smi

# SLURM 큐 상태
squeue

# 모든 노드 상태 상세 조회
scontrol show nodes
```

예상 출력:
```
$ sinfo
PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST
head*        up   infinite      1   idle head-node-001
sim          up   infinite      0  alloc sim-node-[001-004]
train        up   infinite      4   idle train-node-[001-004]
debug        up   infinite      1   idle debug-node-001
```

## 3. 데이터 업로드 및 FSx 동기화

### S3 업로드 → FSx 자동 동기화

HyperPod은 S3 버킷과 FSx for Lustre를 자동으로 동기화합니다:

```bash
# 로컬 데이터를 S3에 업로드
aws s3 cp ./my_dataset s3://hyperpod-data-ACCOUNT-REGION/datasets/groot/my_dataset --recursive

# 또는 ALOHA 데이터세트 다운로드 (예시)
cd /tmp
git clone https://github.com/example/aloha-dataset.git
aws s3 sync ./aloha-dataset s3://hyperpod-data-ACCOUNT-REGION/datasets/groot/aloha/
```

FSx는 다음 규칙에 따라 자동으로 동기화합니다:
- **ImportPath**: `s3://hyperpod-data/datasets/` → `/fsx/datasets/` (자동 동기화)
- **ExportPath**: `/fsx/checkpoints/` → `s3://hyperpod-data/checkpoints/` (자동 내보내기)
- **AutoImportPolicy**: `NEW_CHANGED_DELETED` (새 파일 및 변경사항 자동 감지)

### S3 경로 규칙

다음 경로 규칙을 준수하여 데이터를 구성합니다:

| 경로 | 용도 | 예시 |
|------|------|------|
| `datasets/groot/` | GR00T 학습 데이터 | `datasets/groot/aloha/`, `datasets/groot/bridge_v2/` |
| `datasets/pi0/` | π0 학습 데이터 | `datasets/pi0/bridge_v2/`, `datasets/pi0/oxe/` |
| `checkpoints/vla/` | VLA 체크포인트 | `checkpoints/vla/groot-aloha-20250501/` |
| `checkpoints/rl/` | RL 체크포인트 | `checkpoints/rl/isaac-humanoid-20250501/` |
| `mlflow-artifacts/` | MLflow 로그 및 메트릭 | (자동 생성) |

### FSx 동기화 확인

```bash
# FSx 마운트 포인트 확인
df -h /fsx

# 데이터세트 동기화 확인
ls -la /fsx/datasets/groot/

# 체크포인트 동기화 확인
ls -la /fsx/checkpoints/vla/

# S3 업로드 진행 상황 모니터링
aws s3 ls s3://hyperpod-data-ACCOUNT-REGION/checkpoints/vla/ --recursive --human-readable --summarize
```

## 4. VLA 학습 실행

### 4.1 GR00T 학습

#### 단일 노드

```bash
cd /fsx/scratch

# run_vla.sh 래퍼 사용
bash /path/to/run_vla.sh --model groot --dataset aloha --epochs 50

# 또는 sbatch 직접 제출
sbatch \
  --export=ALL,DATASET=aloha,EPOCHS=50 \
  /path/to/finetune_groot.sbatch
```

#### 멀티노드

```bash
# 4개 노드에서 분산 학습
sbatch \
  --nodes=4 \
  --export=ALL,DATASET=aloha,EPOCHS=50 \
  /path/to/finetune_groot.sbatch
```

GR00T 작업 모니터링:

```bash
# 작업 상태 확인
squeue

# 특정 작업 로그 확인
tail -f /fsx/scratch/logs/groot-<JOB_ID>.out

# 작업 세부 정보 확인
scontrol show job <JOB_ID>
```

### 4.2 π0 학습

```bash
# run_vla.sh로 π0 학습 제출
bash /path/to/run_vla.sh --model pi0 --dataset bridge_v2 --epochs 100 --nodes 2

# 또는 직접 sbatch 제출
sbatch \
  --nodes=2 \
  --export=ALL,DATASET=bridge_v2,EPOCHS=100 \
  /path/to/finetune_pi0.sbatch
```

π0 학습 설정 (기본값):
- 배치 크기: 16 (GR00T보다 작음)
- 학습 속도: 5e-5 (GR00T보다 낮음)
- 시간 제한: 48시간 (GR00T 24시간보다 길음)
- 데이터세트: bridge_v2

## 5. RL 학습 실행

### Actor-Learner 아키텍처

RL 학습은 두 가지 작업으로 구성됩니다:
- **Learner**: Train 파티션에서 실행, Ray head로 정책 업데이트
- **Actor**: Sim 파티션에서 병렬 실행, 시뮬레이션 환경에서 경험 수집

### run_rl.sh 사용법

```bash
# 기본 설정으로 RL 학습 시작 (8개 actor)
bash /path/to/run_rl.sh --env Isaac-Humanoid-v0 --num-actors 8

# 16개 actor로 시뮬레이션 수행
bash /path/to/run_rl.sh --env Isaac-Cartpole-v0 --num-actors 16

# 커스텀 실험 이름 지정
bash /path/to/run_rl.sh \
  --env Isaac-Humanoid-v0 \
  --num-actors 12 \
  --experiment custom-run-20250501
```

### 작업 모니터링

```bash
# 모든 RL 작업 확인
squeue -u $USER

# Learner와 Actor 작업 각각 확인
squeue | grep learner
squeue | grep actor

# 특정 작업 상세 정보
scontrol show job <LEARNER_JOB_ID>

# Learner 로그 실시간 확인
tail -f /fsx/scratch/logs/learner-<JOB_ID>.out

# Actor 로그 (배열 작업이므로 각 actor 확인)
tail -f /fsx/scratch/logs/actor-<JOB_ID>-0.out
tail -f /fsx/scratch/logs/actor-<JOB_ID>-1.out
```

### Ray 클러스터 확인

```bash
# Learner 노드 확인
LEARNER_NODE=$(squeue -j <LEARNER_JOB_ID> -h -o %N)

# Ray status 확인 (Learner 노드에서)
srun --jobid=<LEARNER_JOB_ID> --nodelist=${LEARNER_NODE} ray status

# Ray 대시보드 접속 (포트포워딩 필요)
# 로컬 머신에서: ssh -L 8265:<LEARNER_IP>:8265 head-node
```

## 6. DCV 시각화 검증

### DCV 세션 시작

```bash
# debug 파티션에서 DCV 세션 시작
CHECKPOINT="/fsx/checkpoints/vla/groot-aloha-20250501"

sbatch \
  --export=ALL,CHECKPOINT=${CHECKPOINT} \
  /path/to/dcv_session.sbatch
```

### SSM 포트포워딩을 통한 접속

```bash
# 1. DCV 세션을 실행 중인 노드 확인
DCV_JOB_ID=$(squeue -u $USER | grep dcv | awk '{print $1}')
DCV_NODE=$(squeue -j ${DCV_JOB_ID} -h -o %N)

# 2. SSM 포트포워딩 시작 (로컬 머신에서)
aws ssm start-session \
  --target <INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=8443,localPortNumber=8443

# 3. 브라우저에서 접속
# https://localhost:8443
# (자체 서명 인증서 경고는 무시)
```

### Isaac Sim에서 모델 검증

DCV 세션이 활성화되면:

```bash
# Isaac Sim GUI에서 학습된 모델 로드
python /fsx/scratch/verify_in_sim.py --checkpoint ${CHECKPOINT}

# 모델 정추론 및 시각화
# - 학습된 policy 실행
# - 로봇 동작 시각화
# - 센서 데이터 확인
```

## 7. MLflow UI 접속

### 7.1 SageMaker Studio에서 확인

```bash
# SageMaker Studio 노트북에서
import sagemaker
session = sagemaker.Session()

# MLflow 추적 URI
mlflow_uri = f"s3://{session.default_bucket()}/mlflow-artifacts"
print(f"MLflow Tracking URI: {mlflow_uri}")
```

### 7.2 클러스터에서 코드로 조회

```bash
# Head-node에서 MLflow CLI 사용
mlflow experiments search --output-format json

# 특정 실험의 메트릭 조회
mlflow runs search --experiment-name "groot-aloha" --output-format json
```

### 7.3 학습 스크립트에서 MLflow 사용

```python
import mlflow

# MLflow 추적 시작
mlflow.set_tracking_uri(os.environ['MLFLOW_TRACKING_URI'])
mlflow.set_experiment("groot-aloha")

with mlflow.start_run():
    mlflow.log_param("epochs", 50)
    mlflow.log_param("batch_size", 32)
    
    for epoch in range(epochs):
        loss = train_epoch()
        mlflow.log_metric("train_loss", loss, step=epoch)
```

## 8. SLURM 자주 쓰는 명령어

### 클러스터 상태 확인

```bash
# 파티션 및 노드 상태
sinfo

# 노드 세부 정보 (메모리, GPU, 상태)
sinfo -N -l

# 특정 파티션 상태
sinfo -p train

# 모든 노드 상세 정보
scontrol show nodes
```

### 작업 제출 및 모니터링

```bash
# 작업 제출
sbatch job.sbatch

# 작업 ID 포함 제출 (파싱 가능)
JOB_ID=$(sbatch --parsable job.sbatch)

# 대기 중인 작업 확인
squeue

# 특정 사용자의 작업 확인
squeue -u $USER

# 특정 작업 상태
squeue -j <JOB_ID>

# 작업 상세 정보
scontrol show job <JOB_ID>

# 작업 상태 필터링 (RUNNING만 표시)
squeue -t RUNNING
```

### 작업 취소 및 관리

```bash
# 특정 작업 취소
scancel <JOB_ID>

# 사용자의 모든 작업 취소
scancel -u $USER

# 작업 배열의 특정 원소 취소
scancel <JOB_ID>_2

# 작업의 시간 제한 수정
scontrol update job=<JOB_ID> TimeLimit=10:00:00

# 작업의 우선순위 변경
scontrol update job=<JOB_ID> Priority=100
```

### 작업 이력 조회

```bash
# 완료된 작업 이력
sacct

# 특정 기간의 작업 이력
sacct --starttime=2025-05-01 --endtime=2025-05-02

# 작업 세부 통계
sacct -j <JOB_ID> --format=JobID,JobName,State,Elapsed,MaxRSS

# 완료된 작업의 리소스 사용량
sacct -j <JOB_ID> --format=JobID,MaxVMSize,MaxRSS,TotalCPU,Elapsed
```

### 인터랙티브 세션

```bash
# 인터랙티브 bash 세션 시작 (train 파티션, 4 GPU)
srun --partition=train --gpus=4 --pty bash

# Python 인터랙티브 세션
srun --partition=train --gpus=2 python

# 시간 지정 (10시간)
srun --partition=train --gpus=4 --time=10:00:00 --pty bash
```

### 컨테이너 이미지로 작업 실행

```bash
# 특정 컨테이너 이미지로 작업 실행
srun --container-image=nvcr.io/nvidia/gr00t:1.6.0 \
     --container-mounts=/fsx:/fsx \
     python /fsx/script.py

# 여러 컨테이너 마운트
srun --container-image=nvcr.io/nvidia/pytorch:24.09 \
     --container-mounts=/fsx:/fsx,/data:/data \
     python /fsx/train.py
```

## 9. 트러블슈팅

### 9.1 작업이 PENDING 상태에서 진행 안 됨

```bash
# 작업 상태 확인
scontrol show job <JOB_ID>

# 예상되는 원인:
# 1. 리소스 부족 (GPU 사용 가능 여부 확인)
sinfo

# 2. 파티션이 비활성화됨
sinfo -p <PARTITION>

# 3. 노드 에러 상태
scontrol show node <NODE_NAME>

# 해결 방법:
# - 작업 요구사항 조정 (GPU 수, 시간 등)
# - 다른 파티션에 작업 제출
# - 노드가 에러 상태면 관리자에 연락
```

### 9.2 Out of Memory (OOM) 에러

```bash
# 메모리 요구사항 확인
grep -i "memory" /fsx/scratch/logs/<JOB>.out

# 배치 크기 감소하여 재제출
sbatch \
  --export=ALL,BATCH_SIZE=16 \
  /path/to/training.sbatch

# 노드의 메모리 확인
free -h

# GPU 메모리 확인
nvidia-smi

# 데이터로더 workers 수 감소
# train_script.py에서:
# DataLoader(dataset, num_workers=0)  # 기본값 4 → 0
```

### 9.3 FSx 동기화 이슈

```bash
# FSx 마운트 확인
df -h /fsx
mount | grep fsx

# FSx에 데이터가 없으면 재마운트 필요
sudo umount /fsx
sudo mount -t lustre <FSX_DNS>@tcp:/<FSX_MOUNT> /fsx

# S3에서 FSx로 수동 동기화 (필요한 경우)
aws s3 sync s3://hyperpod-data-ACCOUNT-REGION/datasets/groot/ /fsx/datasets/groot/

# FSx 상태 및 용량 확인
df -h /fsx
lfs df /fsx
```

### 9.4 컨테이너 이미지 풀 실패

```bash
# 컨테이너 레지스트리 연결 확인
srun --container-image=nvcr.io/nvidia/gr00t:1.6.0 echo "test"

# 이미지 풀 문제 진단
# - NGC 레지스트리 인증 정보 확인
# - 이미지 tag 버전 확인
# - 인터넷 연결 확인

# 문제 발생 시 로그 확인
tail -100 /fsx/scratch/logs/<JOB>.err

# 대체 이미지 사용
sbatch \
  --container-image=docker://pytorch/pytorch:2.0 \
  /path/to/training.sbatch
```

### 9.5 NCCL 통신 에러 (멀티노드)

```bash
# 멀티노드 작업 로그 확인
tail -f /fsx/scratch/logs/groot-<JOB>.out

# 노드 간 네트워크 연결 테스트
srun -N 2 ping -c 3 <OTHER_NODE_IP>

# NCCL 디버깅 활성화
export NCCL_DEBUG=INFO

# 작업 다시 제출
sbatch \
  --export=ALL,NCCL_DEBUG=INFO \
  /path/to/training.sbatch
```

### 9.6 Enroot 컨테이너 마운트 이슈

```bash
# Pyxis 상태 확인
srun --container-image=nvcr.io/nvidia/pytorch:24.09 echo "ok"

# 컨테이너 마운트 포인트 확인
srun --container-image=nvcr.io/nvidia/pytorch:24.09 mount

# 마운트 경로가 /fsx 외부면 에러 발생 가능
# 해결: 스크립트를 /fsx/scratch로 복사

# 컨테이너 캐시 초기화 (문제 해결 후)
find ~/.cache -name "*container*" -type d -exec rm -rf {} + 2>/dev/null
```

## 참고

- **공식 문서**: [AWS SageMaker HyperPod](https://docs.aws.amazon.com/sagemaker/latest/dg/hyperpod-overview.html)
- **SLURM**: [SLURM Documentation](https://slurm.schedmd.com/)
- **Enroot/Pyxis**: [NVIDIA Enroot](https://github.com/NVIDIA/enroot)
- **MLflow**: [MLflow Documentation](https://mlflow.org/docs/)
- **클러스터 로그**: `/fsx/scratch/logs/`에서 모든 작업 로그 확인 가능
