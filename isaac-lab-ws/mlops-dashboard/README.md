# MLOps Dashboard — IsaacLab Fleet Monitor

AWS EC2 Batch 환경에서 구동되는 다수의 **IsaacLab 기반 강화학습(RL) 인스턴스**를 통합 모니터링하기 위한 웹 대시보드입니다.

각 EC2 워커는 IsaacLab 학습을 실행하며, AWS Batch를 통해 병렬(parallel) 실행되고, `torch.distributed` (DDP)로 분산학습됩니다. 이 대시보드는 전체 학습 과정을 하나의 화면에서 모니터링하고 시각화합니다.

## System Boundaries & Assumptions

- **통합 Dashboard**: 웹 애플리케이션으로, 여러 워커의 상태를 관리하고 사용자가 선택한 워커의 Rerun 스트림을 브라우저 내에서 렌더링
- **AWS 기반**: EC2 인스턴스는 AWS Batch로 오케스트레이션되며, 리소스 태그 기반으로 필터링
- **분산학습**: PyTorch DDP (NCCL backend)를 사용하여 multi-node GPU 학습

## Key Features

### 0. TensorBoard 학습 메트릭 확인
- 각 워커의 TensorBoard를 브라우저 내 iframe으로 임베딩
- Reward, Policy Loss, Value Loss, Learning Rate 등 학습 곡선 실시간 확인
- 워커 상세 페이지(`/worker/[workerId]`)에서 개별 워커의 TensorBoard 접근

### 1. Fleet Monitoring View (전체 인스턴스 목록)
- AWS 특정 리전의 **태그 기반**으로 실행 중인 EC2 인스턴스 및 Batch Job 정보 수집
- Fleet Summary: 전체/실행중/대기/실패 워커 수, 평균 GPU 사용률, 총 GPU 수, Best Reward
- **DDP Topology 시각화**: 실험별 Master(Rank 0) ↔ Worker(Rank N) 연결 토폴로지를 SVG로 렌더링
- Region 필터링 및 워커 테이블 (정렬 가능)

### 2. Native Rerun Visualization View (실시간 3D 뷰어 임베딩)
- Fleet Monitoring View에서 특정 워커를 클릭하면, 해당 워커의 **Rerun Web Viewer**를 iframe으로 임베딩
- Rerun의 공식 Web Viewer(WASM)를 활용하여 브라우저 안에서 Rerun UI가 그대로 렌더링
- 각 워커의 `rerunPort`(9090)로 Web Viewer UI, `rerunDataPort`(9876)로 데이터 스트림 연결
- 워커가 RUNNING 상태가 아니거나 publicIp가 없으면 unavailable 표시

### 3. Experiment Comparison View
- 실험 카드: 알고리즘, 워커 수, 진행률, Best Reward 한눈에 확인
- **Reward Comparison Chart**: 선택한 실험들의 학습 곡선을 오버레이하여 비교
- **Hyperparameter Diff Table**: 실험 간 하이퍼파라미터 차이를 하이라이트

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Next.js)                     │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Fleet   │  │  Experiment  │  │  Worker Detail     │  │
│  │ Overview │  │  Comparison  │  │  + Rerun + TB      │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬──────────┘  │
│       │               │                   │              │
│       └───────────┬───┘───────────────────┘              │
│                   │                                      │
│          useWorkers() hook                               │
│          (polling + metrics jitter)                      │
└───────────────────┬──────────────────────────────────────┘
                    │ fetch
        ┌───────────┼───────────┐
        ▼           ▼           ▼
  /api/workers  /api/batch-jobs  /api/experiments
  (EC2 SDK)     (Batch SDK)      (mock / metadata store)
        │           │
        ▼           ▼
   ┌─────────────────────┐
   │   AWS Account        │
   │  ┌────────────────┐  │
   │  │ EC2 Instances   │  │  ← tag: Project=IsaacLab-RL
   │  │ (GPU workers)   │  │
   │  └────────────────┘  │
   │  ┌────────────────┐  │
   │  │ AWS Batch Jobs  │  │  ← project tag filtering
   │  └────────────────┘  │
   └─────────────────────┘

  EC2 Worker (each instance)
  ┌────────────────────────────────┐
  │  IsaacLab Training Process     │
  │  ├── torch.distributed (DDP)   │
  │  ├── Rerun SDK → :9876 (data)  │
  │  ├── Rerun Web Viewer → :9090  │
  │  └── TensorBoard → :6006       │
  └────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS (custom AWS theme) |
| AWS SDK | `@aws-sdk/client-ec2`, `@aws-sdk/client-batch` |
| Charts | Hand-built SVG (no charting library) |
| 3D Viewer | Rerun Web Viewer (WASM, iframe embed) |
| Metrics | TensorBoard (iframe embed) |

## Pages

| Route | Description |
|---|---|
| `/` | Fleet Overview — summary cards, DDP topology, worker table |
| `/experiments` | Experiment comparison — cards, reward chart, hyperparam diff |
| `/worker/[workerId]` | Worker detail — info panel, training metrics, Rerun viewer, TensorBoard |

## Data Flow

### API Routes

| Endpoint | Source | Description |
|---|---|---|
| `/api/workers` | EC2 `DescribeInstances` | 태그 필터로 워커 인스턴스 조회, GPU/DDP 메타데이터 매핑 |
| `/api/batch-jobs` | Batch `ListJobs`/`DescribeJobs` | 모든 큐에서 프로젝트 태그로 필터링한 Batch Job 조회 |
| `/api/experiments` | Mock (→ metadata store) | 실험 메타데이터 및 학습 메트릭 (현재 mock, 추후 DynamoDB/S3) |

### Client-Side State (`useWorkers` hook)

1. 마운트 시 3개 API 엔드포인트 fetch
2. `/api/workers`, `/api/batch-jobs`를 **30초 간격**으로 폴링
3. `regions`, `filteredWorkers`, `summary` (FleetSummary)를 memo로 파생

## Quick Start

```bash
# Install dependencies
yarn install

# Run with mock data (default)
yarn dev

# Run with live AWS data
# Configure .env.local first (see below)
USE_MOCK_DATA=false yarn dev
```

## Environment Variables

`.env.local` 파일에 설정:

```env
# AWS credentials (server-side only, API routes에서 사용)
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret

# Resource tag filter (EC2/Batch 인스턴스 디스커버리)
AWS_RESOURCE_TAG_KEY=Project
AWS_RESOURCE_TAG_VALUE=IsaacLab-RL

# Mock data mode (default: true, 로컬 개발용)
USE_MOCK_DATA=true
```

## Data Sources & Accuracy

대시보드에 표시되는 데이터는 소스에 따라 정확도가 다릅니다.

### EC2 API에서 직접 가져오는 정보 (정확)

`DescribeInstances` API로 가져오며 항상 실시간 상태를 반영합니다:

| Field | Source |
|---|---|
| Instance ID | `InstanceId` |
| Status (RUNNING/PENDING/STOPPED/FAILED) | `State.Name` |
| Public/Private IP | `PublicIpAddress` / `PrivateIpAddress` |
| Instance Type | `InstanceType` |
| Region | `Placement.AvailabilityZone` |
| Uptime | `LaunchTime`으로부터 계산 |

### EC2 태그에서 읽는 정보 (워커가 업데이트해야 정확)

EC2 인스턴스 태그에서 파싱하며, **워커 프로세스가 주기적으로 자기 인스턴스 태그를 업데이트해야** 실시간 값이 됩니다. 태그가 없으면 기본값(`0`, `-`)이 표시됩니다:

| Field | Tag Key | Default |
|---|---|---|
| Task Name | `TaskName` / `IsaacLabTask` | `-` |
| Experiment Name | `ExperimentName` / `TrainingRun` | `-` |
| DDP Rank / World Size | `DDPRank` / `DDPWorldSize` | `0` / `1` |
| Training Progress | `CurrentStep` / `TotalSteps` | `0` / `10000` |
| Current Reward | `CurrentReward` | `0` |

> **참고**: 학습 진행률(step, reward)을 실시간으로 반영하려면 워커의 학습 스크립트에서 주기적으로 `ec2:CreateTags` API를 호출하여 자기 인스턴스 태그를 업데이트해야 합니다.

### EC2 API로 가져올 수 없는 정보 (미지원)

다음 메트릭은 EC2 `DescribeInstances` API로 가져올 수 없어 대시보드에서 **표시하지 않습니다**:

- GPU Utilization / GPU Memory Utilization / GPU Temperature
- CPU Utilization / Memory Utilization

> **EC2 API의 한계**: `DescribeInstances`는 인스턴스 메타데이터(ID, 상태, IP, 태그 등)만 반환합니다. GPU/CPU 사용률 같은 하드웨어 메트릭은 인스턴스 내부에서 수집하여 CloudWatch로 전송하거나, DCGM Exporter / Prometheus 등 별도 모니터링 파이프라인이 필요합니다. 향후 CloudWatch 연동 시 이 메트릭들을 추가할 수 있습니다.

## IAM Permissions

### Dashboard Server (API Routes)

대시보드 서버가 AWS API를 호출하기 위해 필요한 최소 IAM 권한입니다. EC2 인스턴스에서 실행하는 경우 IAM Role을, 로컬에서 실행하는 경우 IAM User의 Access Key를 사용합니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2ReadOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances"
      ],
      "Resource": "*"
    },
    {
      "Sid": "BatchReadOnly",
      "Effect": "Allow",
      "Action": [
        "batch:DescribeJobQueues",
        "batch:ListJobs",
        "batch:DescribeJobs"
      ],
      "Resource": "*"
    }
  ]
}
```

> **권한 적용 방법**:
> - **EC2 Instance Profile**: EC2에서 대시보드를 실행하는 경우, 위 정책을 IAM Role에 연결하고 해당 Role을 인스턴스 프로파일로 설정합니다. `.env.local`에서 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`를 설정하지 않으면 SDK가 자동으로 인스턴스 프로파일을 사용합니다.
> - **IAM User (로컬 개발)**: IAM User를 생성하고 위 정책을 연결한 후, Access Key를 `.env.local`에 설정합니다.

### Worker Instances (Self-Tag Update)

워커 인스턴스가 학습 진행률을 태그로 업데이트하려면 추가 권한이 필요합니다:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SelfTagUpdate",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateTags"
      ],
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/Project": "IsaacLab-RL"
        }
      }
    }
  ]
}
```

워커의 학습 스크립트에서 다음과 같이 태그를 업데이트할 수 있습니다:

```python
# Worker-side tag update example (Python / boto3)
import boto3, requests

instance_id = requests.get(
    "http://169.254.169.254/latest/meta-data/instance-id"
).text
ec2 = boto3.client("ec2")

ec2.create_tags(
    Resources=[instance_id],
    Tags=[
        {"Key": "CurrentStep",  "Value": str(current_step)},
        {"Key": "TotalSteps",   "Value": str(total_steps)},
        {"Key": "CurrentReward","Value": f"{reward:.2f}"},
    ],
)
```

### GPU Metrics Collection (Optional, Future)

실제 GPU 메트릭을 수집하려면 워커에 CloudWatch Agent + NVIDIA DCGM Exporter를 설치하고, 대시보드에서 CloudWatch 메트릭을 조회해야 합니다. 이 경우 추가 IAM 권한이 필요합니다:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchMetricsRead",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics"
      ],
      "Resource": "*"
    }
  ]
}
```

워커 인스턴스에는 메트릭을 publish하는 권한이 추가로 필요합니다:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchMetricsPublish",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricData"
      ],
      "Resource": "*"
    }
  ]
}
```

## EC2 Worker Requirements

대시보드가 워커에 연결하려면 각 EC2 인스턴스에 다음이 필요합니다:

### Security Group Ports
| Port | Service | Purpose |
|---|---|---|
| 9090 | Rerun Web Viewer | 브라우저에서 3D 시뮬레이션 렌더링 |
| 9876 | Rerun Data Port | Rerun 데이터 스트림 (WebSocket proxy) |
| 6006 | TensorBoard | 학습 메트릭 시각화 |

### EC2 Instance Tags
워커가 대시보드에 인식되려면 다음 태그들이 설정되어야 합니다:

| Tag Key | Example | Required |
|---|---|---|
| `Project` | `IsaacLab-RL` | Yes (디스커버리 필터) |
| `TaskName` | `Isaac-Velocity-Flat-Anymal-D-v0` | Recommended |
| `ExperimentName` | `anymal-d-flat-v3` | Recommended |
| `DDPRank` | `0` | For DDP topology |
| `DDPWorldSize` | `16` | For DDP topology |
| `DDPBackend` | `nccl` | For DDP topology |
| `RerunPort` | `9090` | For Rerun embed |
| `RerunDataPort` | `9876` | For Rerun embed |
| `TensorBoardPort` | `6006` | For TensorBoard embed |

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── workers/route.ts      # EC2 DescribeInstances API
│   │   ├── batch-jobs/route.ts   # AWS Batch API
│   │   └── experiments/route.ts  # Experiment metadata (mock)
│   ├── worker/[workerId]/page.tsx # Worker detail page
│   ├── experiments/page.tsx       # Experiment comparison page
│   ├── page.tsx                   # Fleet overview (home)
│   ├── DashboardShell.tsx         # Layout shell (useWorkers + Sidebar)
│   ├── layout.tsx                 # Root layout
│   └── globals.css                # Tailwind base styles
├── components/
│   ├── FleetSummaryCards.tsx      # Summary metric cards
│   ├── DdpTopologyView.tsx        # DDP topology SVG visualization
│   ├── WorkerTable.tsx            # Sortable worker instance table
│   ├── RegionFilter.tsx           # Region dropdown filter
│   ├── StatusBadge.tsx            # Worker/experiment status badge
│   ├── WorkerInfoPanel.tsx        # Worker detail info panel
│   ├── TrainingMetricsChart.tsx   # Training curve charts (SVG)
│   ├── RerunViewer.tsx            # Rerun Web Viewer iframe embed
│   └── TensorBoardEmbed.tsx       # TensorBoard iframe embed
├── hooks/
│   └── useWorkers.ts              # Central state manager (fetch + polling)
├── lib/
│   └── aws-clients.ts             # Shared AWS SDK clients & config
├── data/
│   └── mockWorkers.ts             # Mock data for local development
└── types/
    └── worker.ts                  # Domain types (Worker, Experiment, BatchJob, etc.)
```

## Roadmap

- [ ] `/api/experiments` — DynamoDB/S3 메타데이터 스토어 연동 (현재 mock-only)
- [ ] GPU 메트릭 — CloudWatch 또는 DCGM exporter 연동으로 실제 GPU 사용률 수집
- [ ] Rerun Web Viewer — WASM 직접 임베딩 방식 검토 (현재 iframe 기반)
- [ ] 알림 — 워커 실패/OOM 시 Slack/SNS 알림 연동
- [ ] 인증 — AWS Cognito 또는 IAM Identity Center 기반 접근 제어
