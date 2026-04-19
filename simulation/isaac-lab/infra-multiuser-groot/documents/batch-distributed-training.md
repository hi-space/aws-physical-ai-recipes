# AWS Batch 분산 학습 가이드

Isaac Lab 환경에서 AWS Batch를 이용한 PyTorch DDP 분산 학습 참고 문서.

## 분산 학습 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                   AWS Batch                          │
│                                                     │
│  노드 0 (rank 0)           노드 1 (rank 1)          │
│  ┌───────────────┐         ┌───────────────┐        │
│  │ 모델 사본 (동일)│         │ 모델 사본 (동일)│        │
│  │ 데이터 배치 A  │         │ 데이터 배치 B  │        │
│  │               │         │               │        │
│  │ Forward→Loss  │         │ Forward→Loss  │        │
│  │ Backward→Grad │         │ Backward→Grad │        │
│  └───────┬───────┘         └───────┬───────┘        │
│          │                         │                │
│          └─── AllReduce (NCCL) ────┘                │
│              그래디언트 평균 동기화                     │
│          ┌─────────────────────────┐                │
│          │ 모델 가중치 항상 동일     │                │
│          └────────────┬────────────┘                │
│                       │                             │
│              rank 0만 체크포인트 저장                  │
│                       ↓                             │
│              ┌─────────────────┐                    │
│              │ EFS (공유 스토리지)│                    │
│              │ /efs/checkpoints │                    │
│              └─────────────────┘                    │
└─────────────────────────────────────────────────────┘
```

## PyTorch DDP 동작 원리

1. 각 노드가 **동일한 모델 복사본**을 보유
2. 학습 데이터를 노드 수만큼 분할하여 각 노드가 **다른 배치**를 처리 (데이터 병렬)
3. 매 스텝마다 `AllReduce`로 **그래디언트를 평균**하여 모든 노드에 동기화
4. 동기화 후 모든 노드의 모델 가중치가 **항상 동일**
5. 따라서 체크포인트는 **rank 0 한 대만 저장**하면 됨 (합치는 작업 없음)

```python
# 체크포인트 저장 (rank 0만)
if dist.get_rank() == 0:
    torch.save(model.state_dict(), "/efs/checkpoints/agent_72000.pt")

# 체크포인트 로드 (모든 노드)
model.load_state_dict(torch.load("/efs/checkpoints/agent_72000.pt"))
```

## 체크포인트 공유 스토리지 옵션

| 방식 | 지연시간 | 처리량 | 멀티 AZ | 비용 | 적합한 경우 |
|------|---------|--------|:-------:|------|------------|
| **EFS** (현재) | 수 ms | 보통 | ✅ | 사용량 기반 | 체크포인트 크기 작음, 빈도 낮음 |
| **S3** | 수십~수백 ms | 높음 | ✅ | 매우 저렴 | 비동기 공유, AZ 제약 우회 |
| **FSx for Lustre** | sub-ms | 매우 높음 | ❌ 단일 AZ | 용량 기반 (비쌈) | 대규모 체크포인트, 높은 I/O |

### EFS (현재 구조, 권장)

- rank 0이 EFS에 체크포인트 1개를 저장, 재개 시 모든 노드가 같은 경로에서 로드
- Isaac Lab의 `agent_*.pt` 파일은 수십~수백 MB 수준이라 EFS 처리량으로 충분
- 체크포인트 저장은 에포크 단위(수 분~수십 분 간격)이므로 지연시간 무관

### S3 (멀티 AZ 필요 시 대안)

- Batch의 단일 AZ 제약이 문제될 때 가장 간단한 대안
- 인프라 변경 없이 학습 스크립트에서 S3 경로만 지정

```python
import boto3

s3 = boto3.client('s3')

# 체크포인트 저장 (rank 0)
if dist.get_rank() == 0:
    torch.save(model.state_dict(), "/tmp/checkpoint.pt")
    s3.upload_file("/tmp/checkpoint.pt", "my-bucket", "checkpoints/agent_72000.pt")

# 체크포인트 로드 (모든 노드)
s3.download_file("my-bucket", "checkpoints/agent_72000.pt", "/tmp/checkpoint.pt")
model.load_state_dict(torch.load("/tmp/checkpoint.pt"))
```

### FSx for Lustre (대규모 학습)

- 최소 1.2TB 단위 프로비저닝, 비용이 높음
- 수천 노드에서 수 GB 체크포인트를 초 단위로 공유해야 하는 경우에 적합
- 워크숍 규모에서는 오버스펙

## Batch 분산 학습 실행

### 전제 조건

- CDK 스택 배포 완료 (CfnOutput 값 확보)
- Batch CE, JQ, JD 콘솔에서 수동 생성 완료 (README 참조)
- ECR에 Isaac Lab Docker 이미지 푸시 완료

### distributed_run.bash

`assets/workshop/distributed_run.bash`가 `torchrun`을 사용하여 멀티 노드 DDP를 실행한다.

```bash
torchrun \
  --nnodes=$AWS_BATCH_JOB_NUM_NODES \
  --nproc_per_node=$NUM_GPUS \
  --rdzv_backend=c10d \
  --rdzv_endpoint=$MASTER_ADDR:5555 \
  train.py
```

- `--nnodes`: Batch Job의 노드 수 (Multi-node parallel)
- `--nproc_per_node`: 노드당 GPU 수 (g6.12xlarge=4, g6.4xlarge=1)
- `--rdzv_endpoint`: rank 0 노드의 IP (Batch가 `AWS_BATCH_JOB_MAIN_NODE_PRIVATE_IPV4_ADDRESS`로 제공)

### 노드 간 통신

- NCCL이 AllReduce에 사용하는 통신은 Batch SG의 자기 참조 인그레스 규칙으로 허용됨
- `torchrun`의 rendezvous(포트 5555)도 같은 규칙으로 허용됨
- 이 규칙이 없으면 `RendezvousTimeoutError` 발생

## 알려진 제한 사항

### 단일 AZ 제약

현재 구조는 프라이빗 서브넷과 EFS Mount Target이 단일 AZ에만 존재한다.

- DCV 인스턴스: 배포 시점에 AZ Selector가 capacity 확인 → 문제 없음
- Batch Job: 실행 시점에 해당 AZ에 GPU capacity가 없으면 Job이 RUNNABLE 상태에서 대기
- 다른 AZ에 capacity가 있어도 서브넷/Mount Target이 없어 fallback 불가

대응 방안:
1. 시간을 두고 재시도 (capacity는 유동적)
2. 체크포인트를 S3로 전환하고 멀티 AZ 서브넷 구성 (인프라 변경 필요)
3. 다른 리전에 스택 재배포

### 인스턴스 타입과 GPU 수

| 인스턴스 | GPU | GPU당 VRAM | 분산 학습 |
|----------|:---:|:---------:|:---------:|
| g6.4xlarge | 1 (L4) | 24GB | 멀티 노드만 가능 |
| g6e.4xlarge | 1 (L40S) | 48GB | 멀티 노드만 가능 |
| g6.12xlarge | 4 (L4) | 24GB × 4 | 노드 내 + 노드 간 |
| g6e.12xlarge | 4 (L40S) | 48GB × 4 | 노드 내 + 노드 간 |

- 4xlarge(GPU 1개): 노드 간 분산만 가능 (`--nproc_per_node=1`)
- 12xlarge(GPU 4개): 노드 내 4 GPU + 노드 간 분산 가능 (`--nproc_per_node=4`)
