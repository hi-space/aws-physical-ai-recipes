# HyperPod 클러스터 아키텍처 문서

## 1. 개요

이 문서는 AWS SageMaker HyperPod 기반의 분산 로봇학습 인프라를 설명합니다. 이 클러스터는 다음 워크로드를 지원합니다:

- **VLA (Vision Language Action)**: GR00T-3B, π0 등 시각언어 모델 미세 조정
- **RL (Reinforcement Learning)**: IsaacLab 기반 로봇 시뮬레이션 및 정책 학습

### 주요 특징

- **멀티노드 분산 학습**: PyTorch DDP, NCCL, Ray 지원
- **FSx for Lustre 스토리지**: S3와 자동 동기화, 고성능 병렬 파일시스템
- **SLURM 워크로드 관리**: 작업 스케줄링 및 리소스 할당
- **컨테이너 런타임**: Enroot + Pyxis로 NVIDIA 컨테이너 최적화
- **오토스케일링**: 미사용 리소스 자동 축소, 비용 최적화
- **멀티유저 지원**: CDK context로 사용자별 격리된 VPC 생성 가능

## 2. 클러스터 구성

### 2.1 인스턴스 그룹 (4 파티션)

HyperPod 클러스터는 다음 4개 파티션으로 구성됩니다:

| 파티션 | 인스턴스 유형 | GPU | 역할 | 스케일링 | 상시 운영 |
|--------|---------------|-----|------|---------|---------|
| **head** | ml.m5.xlarge | - | SLURM 컨트롤러, NFS, 모니터링 | No | Yes |
| **sim** | ml.g5.12xlarge | 4× A10 (24GB) | IsaacLab 시뮬레이션 | Yes | No |
| **train** | ml.g6e.12xlarge* | 4× L40S (48GB) | VLA/RL 학습 | Yes | No |
| **debug** | ml.g5.4xlarge | 1× A10 (24GB) | DCV 시각화, 디버깅 | No | No |

*Train 인스턴스는 CDK context `trainInstanceType`으로 변경 가능 (기본값: ml.g6e.12xlarge)

### 2.2 인스턴스 그룹 세부 설정

#### Head Node

```json
{
  "InstanceGroupName": "head",
  "InstanceType": "ml.m5.xlarge",
  "InstanceCount": 1,
  "MaxCount": 1,
  "UseSpot": false
}
```

역할:
- SLURM 컨트롤러 (slurmctld, slurmd)
- NFS 서버 (shared home directory)
- MLflow 트래킹 서버
- 환경 설정 및 모니터링

#### Sim Partition

```json
{
  "InstanceGroupName": "sim",
  "InstanceType": "ml.g5.12xlarge",
  "InstanceCount": 0,
  "MaxCount": 16,
  "UseSpot": true
}
```

역할:
- IsaacLab 시뮬레이션 실행 (Ray actors)
- 고속 GPU 시뮬레이션
- 멀티 에이전트 병렬 환경 스텝

특징:
- Spot 인스턴스로 비용 절감
- 온디맨드로 변경 가능 (CDK context `simUseSpot=false`)

#### Train Partition (기본값)

```json
{
  "InstanceGroupName": "train",
  "InstanceType": "ml.g6e.12xlarge",
  "InstanceCount": 0,
  "MaxCount": 4,
  "UseSpot": false
}
```

역할:
- VLA 미세 조정 (GR00T, π0)
- RL 학습 (Ray learner)
- 고메모리 요구 모델 학습

#### Debug Partition

```json
{
  "InstanceGroupName": "debug",
  "InstanceType": "ml.g5.4xlarge",
  "InstanceCount": 0,
  "MaxCount": 1,
  "UseSpot": false
}
```

역할:
- DCV 세션으로 시각화
- 모델 검증 및 디버깅
- 프로토타이핑

### 2.3 Train 인스턴스 프리셋

CDK 배포 시 `trainInstanceType` context를 통해 인스턴스 타입을 선택합니다:

| 프리셋 | 인스턴스 | GPU | 메모리/GPU | 적합한 작업 | 예상 비용 (시간당) |
|--------|---------|-----|-----------|-----------|-----------------|
| **default** | ml.g6e.12xlarge | 4× L40S (48GB) | 12GB | GR00T-3B LoRA/Full, 기본 VLA | ~$7.00 |
| **heavy** | ml.p4d.24xlarge | 8× A100 (40GB) | 5GB | 대규모 VLA, 멀티노드 학습 | ~$32.00 |
| **max** | ml.p5.48xlarge | 8× H100 (80GB) | 10GB | 큰 모델 full fine-tuning, 장시간 학습 | ~$98.00 |

선택 기준:
- **default**: 프로토타이핑, LoRA 미세 조정, 작은 배치 크기
- **heavy**: 프로덕션 VLA, 멀티노드 학습, 큰 배치 크기
- **max**: 대규모 모델, 고속 학습 필요

## 3. 스토리지 아키텍처

### 3.1 스토리지 계층

```
┌─────────────────────────────────────────┐
│         S3 Data Bucket                   │
│ s3://hyperpod-data-ACCOUNT-REGION/      │
│                                         │
│ ├─ datasets/                            │
│ │  ├─ groot/                            │
│ │  │  ├─ aloha/                         │
│ │  │  └─ bridge_v2/                     │
│ │  └─ pi0/                              │
│ │     └─ bridge_v2/                     │
│ │                                       │
│ ├─ checkpoints/                         │
│ │  ├─ vla/                              │
│ │  └─ rl/                               │
│ │                                       │
│ └─ mlflow-artifacts/                    │
└─────────────────────────────────────────┘
         ↑          (Export Path)
         │ (Auto-sync NEW_CHANGED_DELETED)
         ↓          (Import Path)
┌─────────────────────────────────────────┐
│   FSx for Lustre File System             │
│   /fsx (500GB ~ 12TB)                   │
│                                         │
│ ├─ datasets/                            │
│ │  ├─ groot/                            │
│ │  │  ├─ aloha/                         │
│ │  │  └─ bridge_v2/                     │
│ │  └─ pi0/                              │
│ │     └─ bridge_v2/                     │
│ │                                       │
│ ├─ checkpoints/                         │
│ │  ├─ vla/                              │
│ │  └─ rl/                               │
│ │                                       │
│ ├─ scratch/                             │
│ │  ├─ logs/                             │
│ │  ├─ train_groot.py                    │
│ │  ├─ train_pi0.py                      │
│ │  └─ train_isaaclab.py                 │
│ │                                       │
│ └─ mlflow-artifacts/                    │
└─────────────────────────────────────────┘
         ↓ (Mount at /fsx)
┌─────────────────────────────────────────┐
│    HyperPod Nodes (SLURM Workers)        │
│                                         │
│ ├─ Head-node: /fsx (read-write)         │
│ ├─ Sim-node: /fsx (read-only preferred) │
│ ├─ Train-node: /fsx (read-write)        │
│ └─ Debug-node: /fsx (read-write)        │
└─────────────────────────────────────────┘
```

### 3.2 FSx 동기화 설정

**FSx for Lustre Persistent_2 배포:**

```typescript
lustreConfiguration: {
  deploymentType: 'PERSISTENT_2',           // 지속적인 고성능 스토리지
  perUnitStorageThroughput: 125,            // MB/s per TiB (최대 성능)
  dataCompressionType: 'LZ4',               // 데이터 압축으로 전송 최적화
  importPath: 's3://bucket/datasets',      // S3 → FSx 자동 import
  exportPath: 's3://bucket/checkpoints',   // FSx → S3 자동 export
  autoImportPolicy: 'NEW_CHANGED_DELETED'   // 새 파일 및 변경사항 자동 감지
}
```

**동기화 흐름:**

1. **S3 → FSx (Import)**
   - 사용자가 S3에 데이터 업로드
   - FSx가 `s3://bucket/datasets/` 감시
   - 새 파일/변경사항 자동으로 FSx에 복사
   - 지연 시간: 수분 이내

2. **FSx → S3 (Export)**
   - 학습 완료 후 `/fsx/checkpoints/` 기록
   - FSx가 자동으로 S3에 export
   - 지연 시간: 수분 이내

**주의사항:**
- Import/Export 중복 방지: S3 경로와 FSx 경로 분리
- `autoImportPolicy: 'NEW_CHANGED_DELETED'`: 모든 변경사항 감시하므로 주의
- 대용량 파일 업로드 시 S3 multipart upload 사용 권장

## 4. 네트워크 아키텍처

### 4.1 VPC 구성

```
┌──────────────────────────────────────────────────────┐
│                    VPC (10.0.0.0/16)                  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Public Subnet (10.0.0.0/24)                 │   │
│  │                                              │   │
│  │  ┌─────────────────────────────────────┐    │   │
│  │  │  NAT Gateway                        │    │   │
│  │  │  (Internet ↔ Private Subnet)        │    │   │
│  │  └─────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────┘   │
│                     ↑                                 │
│         Internet Gateway                             │
│                     ↓                                 │
│  ┌──────────────────────────────────────────────┐   │
│  │  Private Subnet (10.0.1.0/24)                │   │
│  │                                              │   │
│  │  ┌─────────────────────────────────────┐    │   │
│  │  │ HyperPod Nodes                      │    │   │
│  │  │ - head-node (SLURM controller)     │    │   │
│  │  │ - sim-nodes (Ray actors)           │    │   │
│  │  │ - train-nodes (Training)           │    │   │
│  │  │ - debug-node (DCV)                 │    │   │
│  │  └─────────────────────────────────────┘    │   │
│  │                                              │   │
│  │  ┌─────────────────────────────────────┐    │   │
│  │  │ FSx for Lustre                      │    │   │
│  │  │ (Shared storage /fsx)               │    │   │
│  │  └─────────────────────────────────────┘    │   │
│  │                                              │   │
│  │  ┌─────────────────────────────────────┐    │   │
│  │  │ VPC Endpoints                       │    │   │
│  │  │ - S3 Gateway Endpoint (S3 접속)     │    │   │
│  │  │ - SageMaker API Endpoint (MLflow)   │    │   │
│  │  └─────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### 4.2 보안 그룹 (Security Groups)

#### 클러스터 보안 그룹 (HyperPod-Cluster-SG)

```typescript
// 인그레스: 자기 참조 (Inter-node 통신)
SecurityGroupIngress: {
  IpProtocol: '-1',                    // 모든 프로토콜
  SourceSecurityGroupId: this.ref      // 같은 SG에서만 허용
}

// 설명: NCCL, Ray, SLURM, SSH 등 노드 간 모든 통신 허용
```

역할:
- SLURM 통신: slurmctld (6817), slurmd (6818)
- NCCL 통신: NVIDIA GPU Collective Communications
- Ray 통신: Ray head (6379), worker ports (6380-6384)
- SSH: 노드 간 SSH 접근

#### FSx 보안 그룹 (FSx-SG)

```typescript
// 인그레스: HyperPod 클러스터에서
SecurityGroupIngress: [
  { IpProtocol: 'tcp', FromPort: 988, ToPort: 988 },           // Lustre
  { IpProtocol: 'tcp', FromPort: 1021, ToPort: 1023 }          // Lustre
]

// 출력: 모든 트래픽 허용
SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }]
```

역할:
- Lustre 클라이언트 ↔ FSx 통신
- POSIX 호환 파일 접근

#### VPC 엔드포인트 보안 그룹

S3 Gateway Endpoint:
- 자동으로 VPC 내부 라우팅
- 보안 그룹 추가 설정 불필요
- 비용 절감: S3 NAT gateway 트래픽 제거

SageMaker API Interface Endpoint:
- Private DNS 활성화
- VPC 내부에서 `sagemaker.*.amazonaws.com` 접속 가능
- MLflow S3 backend 접근

### 4.3 라우팅

**공개 서브넷 (Public Subnet):**
- 대상: 0.0.0.0/0 → IGW (Internet Gateway)
- NAT Gateway는 공개 서브넷에 배치

**프라이빗 서브넷 (Private Subnet):**
- 대상: 0.0.0.0/0 → NAT Gateway
- S3 Gateway Endpoint로 S3 트래픽 우회 (비용 절감)

## 5. 보안 (Security)

### 5.1 접근 제어

**SSM Session Manager**
- 기반: IAM 역할 + VPC 내부
- 보안 이점:
  - SSH 키 관리 불필요
  - 감사 로그 (CloudTrail)
  - 일회용 임시 자격증명
  - 포트 개방 불필요
  
```bash
# 접속
aws ssm start-session --target <INSTANCE_ID>
```

**IAM 역할 (HyperPod Execution Role)**

```json
{
  "AssumeRolePolicyDocument": {
    "Service": "sagemaker.amazonaws.com"
  },
  "ManagedPolicyArns": [
    "arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy",
    "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    "arn:aws:iam::aws:policy/AmazonFSxFullAccess",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  ]
}
```

권한:
- HyperPod 클러스터 관리
- S3 데이터 접근 (import/export)
- FSx 작업
- SSM 세션 매니저

### 5.2 VPC 내부 통신

- **인터넷 접근**: NAT Gateway (제한된 아웃바운드 접근)
- **S3 접근**: Gateway Endpoint (비용 절감, 보안 강화)
- **SageMaker API**: Interface Endpoint (private DNS)
- **노드 간 통신**: 자기참조 보안 그룹 (격리)

### 5.3 데이터 보안

**저장소 암호화:**
- S3: 기본적으로 SSE-S3 암호화
- FSx: 암호화 설정 가능 (CDK에서 기본값 비활성)
- EBS: 시스템 볼륨 암호화

**전송 중 암호화:**
- VPC 내부 통신: 공개 인터넷 불가
- S3 업로드: HTTPS (자동)
- MLflow: S3 backend 사용

## 6. 컨테이너 런타임

### 6.1 Enroot + Pyxis 스택

```
SLURM Job Request
       ↓
Pyxis Plugin (SLURM 플러그인)
       ↓
Enroot (컨테이너 번들러)
  - 이미지 가져오기 (OCI, Docker Hub, NGC)
  - 계층 언팩 (Read-write union filesystem)
  - 마운트 설정 (/fsx 바인드)
       ↓
컨테이너 실행 (root 권한 없음)
       ↓
작업 완료 (자동 정리)
```

### 6.2 지원하는 이미지 레지스트리

| 레지스트리 | 형식 | 예시 |
|-----------|------|------|
| Docker Hub | `docker://` | `docker://pytorch/pytorch:2.0` |
| NGC (NVIDIA) | `nvcr.io/` | `nvcr.io/nvidia/gr00t:1.6.0` |
| GitHub | `ghcr.io/` | `ghcr.io/physical-intelligence/openpi:latest` |
| ECR | `ACCOUNT.dkr.ecr.REGION.amazonaws.com/` | - |

### 6.3 컨테이너 마운트

```bash
# FSx 마운트
srun --container-image=nvcr.io/nvidia/pytorch:24.09 \
     --container-mounts=/fsx:/fsx \
     python /fsx/train.py

# 여러 마운트
srun --container-image=nvcr.io/nvidia/pytorch:24.09 \
     --container-mounts=/fsx:/fsx,/root/.ssh:/ssh \
     bash
```

**마운트 점 제약:**
- 컨테이너 내부 경로는 호스트와 같아야 함 (또는 심볼릭 링크)
- `/fsx` 외부 마운트는 제한적 (보안 정책)

### 6.4 컨테이너 최적화

**NCCL (NVIDIA Collective Communications Library):**
- 자동으로 GPU 친화적 라이브러리 사용
- 멀티노드 NCCL ring topology 자동 구성

**PyTorch DDP (Distributed Data Parallel):**
```bash
srun --container-image=nvcr.io/nvidia/pytorch:24.09 \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       train.py
```

## 7. 오토스케일링

### 7.1 SLURM Power Saving 모드

```
Head Node 설정:
  SuspendTime=300 (5분)
  ResumeTimeout=120 (2분)
  PowerSaveInterval=30
```

**동작:**
1. 작업 없는 노드 → IDLE 상태로 대기
2. 5분 후 → 자동 중지 (Spot 인스턴스 리턴)
3. 새 작업 제출 → 자동 재시작 (ResumeTimeout 내)
4. 레이턴시: ~2분 (인스턴스 재시작 + Lustre 클라이언트 재연결)

### 7.2 스케일링 그룹별

| 파티션 | 스케일링 | 최대 인스턴스 | 비용 영향 |
|--------|---------|-------------|---------|
| **head** | No | 1 | 상시 비용 (고정) |
| **sim** | Yes (Spot) | 16 | 변수 비용 (저) |
| **train** | Yes | 4 | 변수 비용 (고) |
| **debug** | No | 1 | 온디맨드 (저) |

### 7.3 Power Saving 특성

**장점:**
- 미사용 노드 자동 중지 → 80% 비용 절감
- Spot 인스턴스 활용 → 추가 70% 절감 가능
- 클러스터 크기 자동 조정 → 관리 최소화

**단점:**
- 새 작업 시작 지연 (~2분)
- 노드 재부팅 오버헤드
- 인터랙티브 작업에는 부적합

**권장사항:**
- 배치 작업: Power Saving 활용
- 디버깅: 인터랙티브 파티션 사용

## 8. 비용 최적화 전략

### 8.1 계층별 비용 구조

| 컴포넌트 | 예상 비용 (월) | 최적화 방법 |
|----------|-------------|----------|
| **Head Node** (m5.xlarge, 24h) | $150 | 필수, 상시 운영 |
| **Sim Nodes** (g5.12xlarge × 4, Spot) | $350 | Spot 사용 → -70% |
| **Train Nodes** (g6e.12xlarge × 4) | $1,300 | 필요할 때만 |
| **FSx** (1TB, PERSISTENT_2) | $400 | 필요한 용량만 할당 |
| **S3** (100GB) | $20 | Intelligent-Tiering |
| **NAT Gateway** | $50 | VPC Endpoint로 절감 |
| **Data Transfer** | $50 | Private Subnet로 절감 |

**총 월 비용**: ~$2,300 (개발 환경)

### 8.2 비용 절감 기법

**1. Spot 인스턴스 (Sim 파티션)**
```typescript
// CDK
simUseSpot: true  // Spot 활용
// 또는
simUseSpot: false  // 온디맨드 (안정성 우선)
```

**2. FSx 용량 최적화**
```typescript
fsxCapacityGiB: 500  // 최소값 (필요에 따라 확대)
```

데이터 크기 예측:
- 데이터셋: 100-200GB
- 체크포인트: 50-100GB (모델당 10-50GB)
- 메타데이터/로그: 10-20GB

**3. S3 Intelligent-Tiering**
```typescript
// Storage class transition
lifecycleConfiguration: {
  rules: [{
    status: 'Enabled',
    transitions: [{
      storageClass: 'INTELLIGENT_TIERING',
      transitionInDays: 30
    }]
  }]
}
```

**4. VPC Endpoint로 NAT 비용 제거**
- S3 Gateway Endpoint: 무료 (사용료만 발생)
- 월 $50 절감

**5. 사용하지 않는 파티션 비활성화**
```bash
# Debug 파티션이 필요 없으면 maxCount=0으로 설정
```

### 8.3 비용 모니터링

```bash
# AWS Cost Explorer에서 모니터링
# - SageMaker HyperPod 비용
# - EC2 (On-demand vs Spot 분석)
# - FSx 비용
# - S3 + Data Transfer

# 태그별 비용 분석
CLUSTER_NAME=hyperpod-robotics
# CDK 배포 시 자동 태그됨
```

## 9. 멀티유저 설정

### 9.1 사용자별 격리

**시나리오:** 여러 연구자가 별도의 VPC에서 독립적인 학습 실행

```bash
# 사용자 A
cdk deploy \
  -c userId=researcher-a \
  -c createVpc=true \
  -c vpcCidr="10.0.0.0/16"

# 사용자 B (같은 account, 다른 VPC)
cdk deploy \
  -c userId=researcher-b \
  -c createVpc=true \
  -c vpcCidr="10.1.0.0/16"
```

### 9.2 VPC 재사용

여러 클러스터가 같은 VPC를 공유할 수 있습니다:

```bash
# 첫 번째 배포: VPC 생성
cdk deploy \
  -c userId=team-a \
  -c createVpc=true

# 두 번째 배포: VPC 재사용
cdk deploy \
  -c userId=team-b \
  -c createVpc=false \
  # (userId=team-b 태그로 VPC 자동 검색)
```

### 9.3 격리 메커니즘

| 격리 수준 | 메커니즘 | 보안 강도 |
|---------|---------|---------|
| 같은 VPC | 보안 그룹 + IAM | 중간 |
| 다른 VPC | 네트워크 격리 | 높음 |
| 다른 Account | AWS 계정 격리 | 매우 높음 |

## 10. 배포 구조

### 10.1 CDK 스택 구성

```
HyperPodStack (최상위)
├── NetworkingConstruct
│   ├── VPC (또는 lookup)
│   ├── Public Subnet + NAT
│   ├── Private Subnet
│   ├── Route Tables
│   ├── VPC Endpoints (S3, SageMaker)
│   └── Flow Logs
├── StorageConstruct
│   ├── S3 Data Bucket
│   ├── FSx for Lustre
│   └── FSx Security Group
├── HyperPodClusterConstruct
│   ├── Cluster Execution Role
│   ├── Cluster Security Group
│   ├── SLURM Cluster (AWS::SageMaker::Cluster)
│   │   ├── Head Instance Group
│   │   ├── Sim Instance Group
│   │   ├── Train Instance Group
│   │   └── Debug Instance Group
│   └── Lifecycle Scripts Bucket
└── MlflowConstruct
    ├── MLflow Tracking Server
    └── S3 Artifact Backend
```

### 10.2 라이프사이클 스크립트

**on_create.sh** (모든 인스턴스):
- 기본 패키지 설치
- SLURM 클라이언트 설정
- Lustre 클라이언트 설정
- FSx 마운트

**setup_fsx.sh** (FSx 마운트):
- Lustre 커널 모듈 설치
- `/fsx` 디렉토리 생성 및 마운트
- 디렉토리 구조 초기화

## 11. 모니터링 및 로깅

### 11.1 로그 위치

```
/fsx/scratch/logs/
├── groot-<JOB_ID>.out           # GR00T 학습 로그
├── pi0-<JOB_ID>.out             # π0 학습 로그
├── learner-<JOB_ID>.out         # RL Learner 로그
├── actor-<JOB_ID>-*.out         # RL Actor 배열 로그
└── dcv-<JOB_ID>.out             # DCV 시각화 로그
```

### 11.2 모니터링 명령어

```bash
# SLURM 통계
sinfo                      # 파티션 상태
squeue                     # 작업 큐
sacct                      # 작업 이력

# 시스템 모니터링
nvidia-smi                 # GPU 상태
df -h /fsx                 # FSx 용량
free -h                    # 메모리
top                        # 프로세스 사용량

# NCCL 성능 (멀티노드 학습)
export NCCL_DEBUG=INFO     # NCCL 디버깅 활성화
sbatch job.sbatch
```

### 11.3 CloudWatch 통합

- VPC Flow Logs: 7일 보관
- CloudTrail: API 호출 감시
- SSM Session Logs: 접근 감사

## 참고 자료

- [AWS SageMaker HyperPod 문서](https://docs.aws.amazon.com/sagemaker/latest/dg/hyperpod-overview.html)
- [SLURM 설정 문서](https://slurm.schedmd.com/slurm.conf.html)
- [AWS FSx for Lustre](https://docs.aws.amazon.com/fsx/latest/LustreGuide/)
- [NVIDIA Enroot](https://github.com/NVIDIA/enroot)
- [Pyxis Container Integration](https://github.com/NVIDIA/pyxis)
- [AWS VPC 아키텍처](https://docs.aws.amazon.com/vpc/latest/userguide/)

