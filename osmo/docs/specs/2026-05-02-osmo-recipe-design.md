# OSMO 레시피 설계 문서

## 개요

NVIDIA OSMO를 활용한 Physical AI 워크로드 배포 레시피를 추가 옵션으로 제공한다.
기존 HyperPod/SageMaker 레시피와 병행하여, Kubernetes 기반 NVIDIA 스택 오케스트레이션이 필요한 사용자에게 대안을 제시한다.

## 배경

### NVIDIA OSMO란?

OSMO는 NVIDIA의 Physical AI 워크플로 오케스트레이터다.
Training, Simulation, Edge 세 가지 컴퓨팅 환경을 단일 YAML 워크플로로 정의하고 Kubernetes 위에서 실행한다.

- Kubernetes-native (EKS, AKS, GKE 지원)
- Isaac Sim, Isaac Lab, GR00T 등 NVIDIA 스택 통합 관리
- 파이프라인 DAG, 분산 실행, content-addressable 데이터셋
- Apache 2.0 오픈소스

### 왜 추가 레시피인가?

| | HyperPod (SLURM) | OSMO (Kubernetes) |
|---|---|---|
| 오케스트레이터 | SLURM | OSMO (K8s native) |
| 인프라 | SageMaker Managed | Self-managed EKS |
| 스케줄링 | sbatch/squeue | OSMO workflow YAML |
| 장점 | AWS 관리형, 오토스케일링 내장 | NVIDIA 스택 통합, 파이프라인 DAG, 멀티클라우드 |
| 적합한 경우 | 단일 학습 job 중심 | Train→Sim→Deploy 파이프라인, 대규모 분산 Sim |

## 범위

- CDK TypeScript로 인프라 프로비저닝 (OSMO 공식 Terraform 예제를 CDK로 포팅)
- OSMO workflow YAML 예시 2개 포함
- end-to-end 가이드가 아닌, "이런 방법도 있다"는 선택지 수준

## 디렉토리 구조

```
osmo/
├── README.md                          # 개요, 비교, Prerequisites, Quick Start
├── cdk/
│   ├── bin/app.ts                     # CDK App entrypoint
│   ├── lib/
│   │   ├── osmo-stack.ts             # 메인 스택 (construct 조합)
│   │   └── constructs/
│   │       ├── networking.ts          # VPC, 멀티AZ Subnet, NAT
│   │       ├── eks-cluster.ts         # EKS + Managed Node Groups (GPU)
│   │       ├── data-stores.ts         # RDS PostgreSQL + ElastiCache Redis
│   │       └── osmo-install.ts        # OSMO Helm chart 설치
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
│
└── workflows/
    ├── groot-train-sim.yaml           # GR00T fine-tune → Isaac Sim 검증
    └── sim-datagen.yaml               # Isaac Sim 대규모 synthetic data 생성
```

## 인프라 아키텍처

### Networking

- VPC: 2~3 AZ, Public/Private Subnet, NAT Gateway
- EKS 서브넷 태깅 (`kubernetes.io/role/internal-elb` 등)
- S3 Gateway Endpoint, ECR/STS Interface Endpoint

### EKS Cluster

- Kubernetes 1.30+
- Node Groups:
  - `system`: m5.xlarge × 2 (OSMO control plane 등)
  - `gpu-sim`: g5.12xlarge (4×L4), 0~8대 오토스케일링 (Sim 워크로드)
  - `gpu-train`: g6e.12xlarge (4×L40S), 0~4대 오토스케일링 (Training 워크로드)
- NVIDIA Device Plugin + Cluster Autoscaler (또는 Karpenter)
- OIDC Provider (IRSA로 Pod에서 S3/ECR 접근)

### Data Stores

- RDS PostgreSQL (db.t3.medium): OSMO 메타데이터, workflow 상태
- ElastiCache Redis (cache.t3.medium): Job queue, 캐싱
- Private Subnet 배치, EKS 클러스터 SG에서만 접근 허용

### OSMO 설치

- CDK `HelmChart` construct로 OSMO Helm chart 배포
- RDS/Redis 엔드포인트를 Helm values로 주입
- S3 버킷(데이터셋/체크포인트) 생성 후 OSMO config에 연결
- 단일 `cdk deploy`로 인프라 + OSMO 모두 프로비저닝

### S3 스토리지

- 데이터셋 버킷: `osmo-data-{account}-{region}`
- 경로 규칙:
  - `datasets/groot/` — GR00T 학습 데이터
  - `datasets/synthetic/` — Sim 생성 데이터
  - `checkpoints/` — 학습 체크포인트

## Workflow 설계

### Workflow 1: GR00T Train → Sim 검증 (`groot-train-sim.yaml`)

2-stage 파이프라인:

1. **finetune** — GR00T-N1.6-3B fine-tuning (gpu-train 노드, 4×L40S)
2. **verify-in-sim** — Isaac Sim에서 학습된 policy 검증 (gpu-sim 노드, depends_on: finetune)

```yaml
name: groot-finetune-and-verify
stages:
  - name: finetune
    image: nvcr.io/nvidia/gr00t:1.6.0
    resources:
      gpu: 4
      node_pool: gpu-train
    command: |
      torchrun --nproc_per_node=4 train_groot.py \
        --dataset /data/datasets/groot/aloha \
        --output-dir /data/checkpoints/groot-aloha \
        --epochs 50
    volumes:
      - s3://bucket/datasets → /data/datasets
      - s3://bucket/checkpoints → /data/checkpoints

  - name: verify-in-sim
    depends_on: [finetune]
    image: nvcr.io/nvidia/isaac-sim:4.5.0
    resources:
      gpu: 1
      node_pool: gpu-sim
    command: |
      python verify_in_sim.py \
        --checkpoint /data/checkpoints/groot-aloha/model_final.pt \
        --env Isaac-Lift-Franka-v0 \
        --num-episodes 20
    volumes:
      - s3://bucket/checkpoints → /data/checkpoints
```

### Workflow 2: Isaac Sim 대규모 데이터 생성 (`sim-datagen.yaml`)

병렬 시뮬레이션으로 synthetic 데이터 대량 생성:

```yaml
name: isaac-sim-datagen
stages:
  - name: generate
    image: nvcr.io/nvidia/isaac-sim:4.5.0
    resources:
      gpu: 4
      node_pool: gpu-sim
    parallelism: 8
    command: |
      python generate_data.py \
        --env Isaac-Lift-Franka-v0 \
        --num-episodes 10000 \
        --output-dir /data/datasets/synthetic/lift-franka \
        --shard-id ${OSMO_TASK_INDEX}
    volumes:
      - s3://bucket/datasets → /data/datasets
```

OSMO의 `parallelism`으로 8개 Pod 병렬 실행 (총 32 GPU), 각 Pod에 `OSMO_TASK_INDEX` 자동 주입.

## README 구성

1. **OSMO란?** — 한 문단 소개 + 공식 링크
2. **왜 OSMO인가?** — HyperPod vs OSMO 비교표, 선택 가이드라인
3. **Prerequisites** — AWS CLI, CDK, kubectl, OSMO CLI, NGC API Key
4. **Quick Start** — `cdk deploy` → `osmo workflow run` (5단계 이내)
5. **아키텍처 다이어그램** — Mermaid (VPC/EKS/OSMO/Workflow 관계)
6. **Workflow 설명** — 각 YAML의 목적과 실행 방법
7. **비용 참고** — EKS + GPU 노드 예상 비용 범위
8. **Cleanup** — `cdk destroy`

## 설계 원칙

- CDK construct는 기존 `infra-multiuser-groot` 패턴을 따름 (namePrefix, 태깅, L1/L2)
- OSMO YAML은 예시임을 명시하고 공식 문서로 링크 (OSMO 스펙 변경 대비)
- GPU 노드그룹은 0대 시작 오토스케일링 (비용 최적화)
- 레포 최상위 README.md의 Recipes 테이블에 OSMO 행 추가

## 제약 사항

- OSMO는 아직 초기 프로젝트이므로 workflow YAML 스펙이 변경될 수 있음
- 실제 OSMO Helm chart 버전/values는 배포 시점의 공식 문서를 참고해야 함
- GPU 인스턴스 가용성은 리전/계정 quota에 따라 다름
