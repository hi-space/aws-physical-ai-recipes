# GR00T-N1.6 SageMaker 파인튜닝 및 배포 가이드

## 개요

이 가이드는 NVIDIA GR00T-N1.6-3B Vision-Language-Action(VLA) 모델을 AWS SageMaker에서 파인튜닝하고 실시간 추론 엔드포인트로 서빙하는 전체 워크플로우를 단계별로 설명합니다.

GR00T-N1.6-3B는 RGB 이미지, 자연어 지시, 로봇 고유수용감각(proprioception) 벡터를 입력받아 연속 액션 벡터를 출력하는 3B 파라미터 로봇 제어 모델입니다.

### 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────────────┐
│  로컬 환경                                                           │
│                                                                     │
│  infra/deploy_stack.py ──────────────── AWS 리소스 생성              │
│  data/download_model.py ─────────────── HuggingFace → S3           │
│  data/upload_dataset.py ─────────────── 로컬 → S3                  │
│  scripts/trigger_build.py ──────────── CodeBuild 트리거             │
│  pipeline/run_pipeline.py ──────────── SageMaker Pipeline 실행      │
│  scripts/deploy_endpoint.py ────────── 엔드포인트 배포              │
│  scripts/invoke_endpoint.py ────────── 추론 요청                    │
└─────────────────────────────────────────────────────────────────────┘
         │                                │
         ▼                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AWS                                                                │
│                                                                     │
│  CloudFormation Stack                                               │
│  ├── S3 Bucket                                                      │
│  │   ├── models/groot-n16/           ← 베이스 모델                  │
│  │   ├── datasets/my-robot/          ← 학습 데이터셋                │
│  │   ├── output/                     ← 학습 결과                    │
│  │   └── checkpoints/               ← Spot Instance 체크포인트     │
│  │                                                                  │
│  ├── IAM Role (GR00TSageMakerRole)   ← 최소 권한                   │
│  │                                                                  │
│  ├── ECR Repositories                                               │
│  │   ├── groot-n16-training          ← 학습 컨테이너                │
│  │   └── groot-n16-inference         ← 추론 컨테이너                │
│  │                                                                  │
│  ├── CodeBuild Projects                                             │
│  │   ├── groot-n16-training-build    ← Docker 빌드 자동화           │
│  │   └── groot-n16-inference-build                                  │
│  │                                                                  │
│  └── SSM Parameters                                                 │
│      ├── /groot/hf-token             ← HuggingFace 토큰             │
│      └── /groot/wandb-key            ← W&B API 키                  │
│                                                                     │
│  SageMaker                                                          │
│  ├── Pipeline (groot-n16-finetuning)                                │
│  │   ├── Step 1: Training Job (Spot Instance)                       │
│  │   └── Step 2: Model Registry 등록                                │
│  │                                                                  │
│  ├── Model Registry (groot-n16-models)                              │
│  │   └── 학습된 모델 버전 관리 + 수동 승인                          │
│  │                                                                  │
│  └── Endpoint (groot-n16-endpoint)   ← 실시간 추론                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 사전 요구사항

### 로컬 환경

| 도구 | 버전 | 설치 명령 |
|------|------|-----------|
| AWS CLI | v2 이상 | [공식 문서](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| Python | 3.10 이상 | `brew install python@3.10` 또는 `apt install python3.10` |
| Git | 최신 | `apt install git` |
| Git LFS | 최신 | `apt install git-lfs && git lfs install` |

AWS CLI 자격증명 구성:
```bash
aws configure
# AWS Access Key ID: <YOUR_ACCESS_KEY>
# AWS Secret Access Key: <YOUR_SECRET_KEY>
# Default region name: ap-northeast-2
# Default output format: json
```

### 로컬 Python 의존성 설치

```bash
cd sagemaker-vla/
pip install -r requirements-dev.txt
```

### 필요한 IAM 권한

AWS 자격증명에 다음 권한이 필요합니다:

| 서비스 | 권한 |
|--------|------|
| CloudFormation | CreateStack, UpdateStack, DescribeStacks |
| IAM | CreateRole, AttachRolePolicy, PutRolePolicy, PassRole |
| S3 | CreateBucket, PutObject, GetObject, ListBucket |
| ECR | CreateRepository, GetAuthorizationToken, PutImage |
| CodeBuild | CreateProject, StartBuild, BatchGetBuilds |
| SageMaker | 전체 (파이프라인, 학습, 배포) |
| SSM | PutParameter, GetParameter |

---

## Step 1: AWS 인프라 배포

CloudFormation 스택으로 모든 AWS 리소스를 한 번에 생성합니다.

```bash
python infra/deploy_stack.py \
    --stack-name groot-n16-stack \
    --bucket-name <전 세계 고유한 버킷 이름> \
    --region ap-northeast-2
```

> 버킷 이름은 전 세계에서 고유해야 합니다. 예: `groot-yourname-20240101`

생성되는 리소스:
- **S3 버킷**: 모델, 데이터셋, 학습 결과 저장 (versioning, 암호화 활성화)
- **IAM 역할** (`GR00TSageMakerRole`): 최소 권한 SageMaker 실행 역할
- **ECR 리포지토리** x2: 학습/추론 컨테이너 이미지
- **CodeBuild 프로젝트** x2: 컨테이너 빌드 자동화
- **SSM 파라미터**: HuggingFace 토큰, W&B 키 저장소

완료 후 `config.yaml`에 자동 기입됨:
```yaml
aws:
  account_id: "123456789012"
  bucket_name: "groot-yourname-20240101"
  role_arn: "arn:aws:iam::123456789012:role/GR00TSageMakerRole"
ecr:
  training_uri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/groot-n16-training:latest"
  inference_uri: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/groot-n16-inference:latest"
```

### (선택) 민감 정보 SSM 업데이트

```bash
# HuggingFace API 토큰 (게이트된 모델 다운로드 시 필요)
aws ssm put-parameter \
    --name /groot/hf-token \
    --value "hf_xxxxxxxxxxxxxxxxxxxx" \
    --type SecureString \
    --overwrite

# Weights & Biases API 키 (학습 추적 시 선택)
aws ssm put-parameter \
    --name /groot/wandb-key \
    --value "your_wandb_api_key" \
    --type SecureString \
    --overwrite
```

---

## Step 2: GR00T-N1.6-3B 모델 다운로드

HuggingFace에서 베이스 모델을 다운로드하고 S3에 업로드합니다. (약 6GB, 수 분 소요)

```bash
python data/download_model.py
```

HuggingFace 토큰이 SSM에 저장되어 있으면 자동으로 사용됩니다. 직접 지정하려면:

```bash
python data/download_model.py --hf-token hf_xxxx
```

완료 후 출력:
```
완료! 베이스 모델 S3 URI:
  s3://groot-yourname-20240101/models/groot-n16
```

---

## Step 3: 데이터셋 업로드

### 3.1 LeRobot v2 데이터셋 형식

GR00T 파인튜닝에는 LeRobot v2 형식의 데이터셋이 필요합니다:

```
my-dataset/
├── meta/
│   ├── info.json           # 로봇 타입, FPS, 특성 정의
│   ├── episodes.jsonl      # 에피소드 목록
│   └── stats.json          # 데이터 통계 (정규화용)
├── data/
│   └── chunk-000/
│       ├── episode_000000.parquet   # 상태 + 액션 데이터
│       └── episode_000001.parquet
└── videos/                 # (선택) 비디오 관측
    └── chunk-000/
        └── episode_000000.mp4
```

`meta/info.json` 예시:
```json
{
    "robot_type": "my_robot",
    "fps": 30,
    "features": {
        "observation.state": {"dtype": "float32", "shape": [7]},
        "action": {"dtype": "float32", "shape": [7]},
        "observation.images.webcam": {"dtype": "video"}
    }
}
```

참고: [Isaac-GR00T 데이터 형식 문서](https://github.com/NVIDIA/Isaac-GR00T)

### 3.2 데이터셋 업로드

```bash
python data/upload_dataset.py \
    --local-path ./my-robot-dataset \
    --prefix datasets/my-robot-v1
```

완료 후 출력:
```
완료! 데이터셋 S3 URI:
  s3://groot-yourname-20240101/datasets/my-robot-v1
```

---

## Step 4: 컨테이너 빌드 (CodeBuild)

AWS CodeBuild를 사용하여 Docker 이미지를 빌드하고 ECR에 푸시합니다.
로컬 Docker 설치가 불필요합니다.

```bash
python scripts/trigger_build.py --type all
```

진행 상황 확인:
- AWS 콘솔 → CodeBuild → 빌드 기록
- CloudWatch 로그: `/aws/codebuild/groot-n16-training-build`

> 빌드 시간: flash-attn 설치 포함 약 20~40분 소요

완료 후 `config.yaml`에 ECR URI 자동 기입됩니다.

### (대안) 로컬 Docker 빌드

로컬에 Docker가 설치된 경우:
```bash
bash scripts/build_local.sh --type all
```

---

## Step 5: 파인튜닝 실행

SageMaker Pipeline으로 학습을 시작합니다. **Spot Instance**를 기본으로 사용하여 비용을 최대 90% 절감합니다.

```bash
python pipeline/run_pipeline.py \
    --embodiment-tag my_robot \
    --dataset-s3-uri s3://groot-yourname-20240101/datasets/my-robot-v1
```

### 주요 하이퍼파라미터

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `--embodiment-tag` | `new_embodiment` | 로봇 식별자 (데이터셋 config와 일치해야 함) |
| `--max-steps` | 10000 | 최대 학습 스텝 수 |
| `--global-batch-size` | 32 | 글로벌 배치 크기 |
| `--instance-type` | `ml.p4d.24xlarge` | 학습 인스턴스 (최소 48GB VRAM) |
| `--no-spot` | - | Spot Instance 비활성화 (디버깅용) |

### 인스턴스 추천

| 티어 | 인스턴스 | GPU | VRAM | 시간당 비용 |
|------|---------|-----|------|-----------|
| 추천 | `ml.p4d.24xlarge` | 8x A100 40GB | 320GB | ~$32.77 |
| 고성능 | `ml.p5.48xlarge` | 8x H100 80GB | 640GB | ~$98.32 |
| 예산 | `ml.g5.12xlarge` | 4x A10G 24GB | 96GB | ~$7.09 |

> Spot Instance 사용 시 실제 비용은 최대 90% 절감됩니다.

### 진행 상황 모니터링

```bash
# AWS 콘솔에서 확인:
# SageMaker → Pipelines → groot-n16-finetuning → 실행 목록
```

또는 단독 Training Job 실행 (파이프라인 없이):

```bash
python scripts/run_training.py \
    --embodiment-tag my_robot \
    --dataset-s3-uri s3://groot-yourname-20240101/datasets/my-robot-v1
```

---

## Step 6: 모델 승인

파이프라인 완료 후, 학습된 모델은 **수동 승인 대기(PendingManualApproval)** 상태로 Model Registry에 등록됩니다. 배포 전에 승인이 필요합니다.

```
AWS 콘솔 → SageMaker → Model Registry → groot-n16-models
→ 최신 버전 클릭 → "Update Status" → Approved 선택
```

또는 AWS CLI:
```bash
aws sagemaker update-model-package \
    --model-package-arn <ARN> \
    --model-approval-status Approved
```

---

## Step 7: 엔드포인트 배포

승인된 모델을 SageMaker Endpoint로 배포합니다.

```bash
python scripts/deploy_endpoint.py
```

특정 인스턴스 타입 지정:
```bash
python scripts/deploy_endpoint.py \
    --instance-type ml.g5.2xlarge \
    --endpoint-name groot-n16-endpoint
```

### 추론 인스턴스 추천

| 티어 | 인스턴스 | GPU | VRAM | 시간당 비용 |
|------|---------|-----|------|-----------|
| 추천 | `ml.g5.2xlarge` | 1x A10G 24GB | 24GB | ~$1.52 |
| 예산 | `ml.g5.xlarge` | 1x A10G 24GB | 24GB | ~$1.01 |
| 고성능 | `ml.p4d.24xlarge` | 8x A100 40GB | 320GB | ~$32.77 |

> 엔드포인트 생성에는 약 5~10분이 소요됩니다.

---

## Step 8: 추론 테스트

배포된 엔드포인트에 추론 요청을 전송합니다.

```bash
python scripts/invoke_endpoint.py \
    --image-path ./test_image.png \
    --proprioception 0.1,0.2,0.3,0.4,0.5,0.6,0.7 \
    --instruction "pick up the red block"
```

요청 형식 (JSON):
```json
{
    "image": "<base64 인코딩된 RGB 이미지>",
    "proprioception": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
    "instruction": "pick up the red block"
}
```

응답 형식 (JSON):
```json
{
    "actions": [[0.05, -0.12, 0.33, 0.01, 0.0, -0.08, 0.15]],
    "timestamp": "2024-01-15T10:30:00.000000+00:00"
}
```

Python에서 직접 호출 예시:
```python
import boto3, base64, json

runtime = boto3.client("sagemaker-runtime", region_name="ap-northeast-2")

with open("test_image.png", "rb") as f:
    image_b64 = base64.b64encode(f.read()).decode()

response = runtime.invoke_endpoint(
    EndpointName="groot-n16-endpoint",
    ContentType="application/json",
    Body=json.dumps({
        "image": image_b64,
        "proprioception": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
        "instruction": "pick up the red block",
    }),
)

result = json.loads(response["Body"].read())
print(result["actions"])  # [[0.05, -0.12, ...]]
```

---

## Step 9: 리소스 정리

사용 완료 후 불필요한 비용 발생을 방지하기 위해 엔드포인트를 삭제합니다.

```bash
# 엔드포인트 삭제 (엔드포인트 설정 및 모델도 함께 삭제)
python scripts/deploy_endpoint.py --action delete
```

전체 인프라 삭제:
```bash
# 주의: S3 버킷 내 모든 데이터가 삭제됩니다
aws s3 rm s3://<버킷 이름> --recursive
aws cloudformation delete-stack --stack-name groot-n16-stack
```

---

## 트러블슈팅

### ECR 인증 실패

```
Error: An error occurred (AuthorizationException)
```

```bash
# 자격증명 확인
aws sts get-caller-identity

# ECR 재인증
aws ecr get-login-password --region ap-northeast-2 \
    | docker login --username AWS --password-stdin \
    <account>.dkr.ecr.ap-northeast-2.amazonaws.com
```

### CodeBuild 실패

```
BUILD_FAILED
```

1. CloudWatch 로그 확인: `AWS 콘솔 → CloudWatch → 로그 그룹 → /aws/codebuild/groot-n16-training-build`
2. Docker 메모리 부족 시: CodeBuild 컴퓨팅 타입을 `BUILD_GENERAL1_2XLARGE`로 변경
3. flash-attn 다운로드 실패: GitHub 연결 문제 - 재시도

### SageMaker Training Job 실패

```
Error: ResourceLimitExceeded
```

1. **클라우드워치 로그**: `SageMaker 콘솔 → Training Jobs → 해당 작업 → View logs`
2. **서비스 쿼터 초과**: `AWS 콘솔 → Service Quotas → SageMaker → ml.p4d.24xlarge` 증가 요청
3. **S3 접근 오류**: IAM 역할에 S3 읽기 권한 확인
4. **Spot 중단**: 체크포인트에서 자동 재시작됨 (정상 동작)

### 엔드포인트 배포 실패

```
Error: ModelError: Received client error (500)
```

1. **모델 로드 실패**: `inference_metadata.json`이 model.tar.gz에 포함되었는지 확인
2. **CUDA 오류**: 인스턴스 타입이 24GB 이상 VRAM을 갖는지 확인 (`ml.g5.2xlarge` 이상)
3. **컨테이너 시작 실패**: CloudWatch 로그 `/aws/sagemaker/Endpoints/groot-n16-endpoint` 확인

### 추론 에러

```
{"detail": "Field 'image' contains invalid base64 data."}
```

이미지를 올바르게 base64 인코딩했는지 확인:
```python
import base64
with open("image.png", "rb") as f:
    b64 = base64.b64encode(f.read()).decode("utf-8")
# b64 문자열을 그대로 "image" 필드에 사용
```

---

## 프로젝트 구조

```
sagemaker-vla/
├── infra/
│   ├── cloudformation.yaml      # IAM, S3, ECR, CodeBuild, SSM
│   └── deploy_stack.py          # CloudFormation 스택 배포
├── container/
│   ├── training/
│   │   ├── Dockerfile           # CUDA 12.4 + GR00T 학습 환경
│   │   ├── train.py             # SageMaker 학습 엔트리포인트
│   │   └── buildspec.yml        # CodeBuild 빌드 스펙
│   └── inference/
│       ├── Dockerfile           # CUDA 12.4 runtime + FastAPI
│       ├── serve.py             # FastAPI 추론 서버 (/ping, /invocations)
│       └── buildspec.yml        # CodeBuild 빌드 스펙
├── data/
│   ├── download_model.py        # HuggingFace → S3 모델 다운로드
│   └── upload_dataset.py        # LeRobot 데이터셋 검증 + S3 업로드
├── pipeline/
│   └── run_pipeline.py          # SageMaker Pipeline (학습 + 모델 등록)
├── scripts/
│   ├── trigger_build.py         # CodeBuild 빌드 트리거
│   ├── build_local.sh           # 로컬 Docker 빌드 (CodeBuild 대안)
│   ├── run_training.py          # 단독 Training Job 실행
│   ├── deploy_endpoint.py       # Model Registry → Endpoint 배포/삭제
│   └── invoke_endpoint.py       # Endpoint 추론 호출 테스트
├── config.yaml                  # 중앙 설정 (deploy_stack.py가 자동 기입)
├── requirements-dev.txt         # 로컬 개발 의존성
└── GUIDE.md                     # 이 가이드
```
