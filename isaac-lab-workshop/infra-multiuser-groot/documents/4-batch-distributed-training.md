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

## 체크포인트 공유 스토리지

현재 구조에서는 EFS를 사용한다. rank 0이 EFS에 체크포인트를 저장하고, 재개 시 모든 노드가 같은 경로에서 로드한다. Isaac Lab의 `agent_*.pt` 파일은 수십~수백 MB 수준이라 EFS 처리량으로 충분하다.

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
