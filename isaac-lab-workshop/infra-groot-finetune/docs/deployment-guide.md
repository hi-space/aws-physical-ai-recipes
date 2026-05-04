# GR00T Fine-tuning Infrastructure 배포 가이드

## 개요

이 가이드는 `infra-groot-finetune` CDK 스택을 배포하고, AWS Batch에서 NVIDIA GR00T VLA 모델을 fine-tuning하는 방법을 설명합니다.

### 아키텍처

```
┌────────────────────────────────────────────────┐
│  IsaacLab Stack (infra-multiuser-groot)        │
│  ├─ VPC + Private Subnet                       │
│  ├─ EFS (공유 파일 시스템)                      │
│  └─ DCV Instance (결과 확인용)                  │
└───────────────────┬────────────────────────────┘
                    │ 리소스 Import
┌───────────────────▼────────────────────────────┐
│  GrootFinetune Stack (이 프로젝트)              │
│  ├─ ECR Repository (컨테이너 이미지 저장)       │
│  ├─ CodeBuild (자동 이미지 빌드)               │
│  ├─ Batch Compute Environment (G6E GPU)        │
│  ├─ Batch Job Queue                            │
│  └─ Batch Job Definition (EFS 마운트 포함)     │
└────────────────────────────────────────────────┘
```

---

## 사전 조건

1. **infra-multiuser-groot 스택이 배포된 상태**여야 합니다
2. AWS CLI 및 CDK CLI 설치
3. Node.js 18+ 설치
4. CDK Bootstrap 완료 (`cdk bootstrap aws://ACCOUNT/REGION`)

---

## Step 1: 부모 스택 정보 확인

```bash
aws cloudformation describe-stacks \
  --stack-name IsaacLab-Latest-yoo \
  --region ap-northeast-2 \
  --query "Stacks[0].Outputs[?contains(OutputKey,'Vpc') || contains(OutputKey,'Efs') || contains(OutputKey,'Subnet')].{Key:OutputKey,Value:OutputValue}" \
  --output table
```

필요한 값:
| 파라미터 | 설명 | 예시 |
|----------|------|------|
| `vpcId` | VPC ID | `vpc-02f4c86c9ca8529ad` |
| `efsFileSystemId` | EFS 파일 시스템 ID | `fs-09ffa87abc4ce41d7` |
| `efsSecurityGroupId` | EFS 보안 그룹 ID | `sg-0b29c11ff70f93790` |
| `privateSubnetId` | Private Subnet ID | `subnet-0dd77da9679e9ec81` |
| `availabilityZone` | EFS Mount Target이 있는 AZ | `ap-northeast-2a` |

> **참고**: `efsSecurityGroupId`가 Stack Outputs에 없는 경우, 아래 명령으로 조회:
> ```bash
> aws ec2 describe-security-groups --region ap-northeast-2 \
>   --filters "Name=vpc-id,Values=<VPC_ID>" "Name=description,Values=*EFS*" \
>   --query "SecurityGroups[0].GroupId" --output text
> ```

---

## Step 2: CDK 배포

```bash
cd infra-groot-finetune
npm install

CDK_DEFAULT_REGION=ap-northeast-2 npx cdk deploy \
  -c vpcId=vpc-02f4c86c9ca8529ad \
  -c efsFileSystemId=fs-09ffa87abc4ce41d7 \
  -c efsSecurityGroupId=sg-0b29c11ff70f93790 \
  -c privateSubnetId=subnet-0dd77da9679e9ec81 \
  -c availabilityZone=ap-northeast-2a \
  -c userId=yoo \
  -c useStableGroot=true \
  -c region=ap-northeast-2
```

배포 완료 후 출력되는 Stack Outputs를 메모합니다.

---

## Step 3: CodeBuild 이미지 빌드 확인

스택 배포 시 CodeBuild가 자동으로 Docker 이미지 빌드를 시작합니다 (약 25-35분 소요).

```bash
# 빌드 상태 확인
aws codebuild list-builds-for-project \
  --project-name GrootFinetuneContainerBuild \
  --region ap-northeast-2 \
  --query "ids[0]" --output text | \
  xargs -I{} aws codebuild batch-get-builds --ids {} \
  --region ap-northeast-2 \
  --query "builds[0].{Status:buildStatus,Phase:currentPhase}" \
  --output table
```

`Status: SUCCEEDED`가 될 때까지 기다린 후 다음 단계로 진행합니다.

```bash
# ECR 이미지 확인
aws ecr describe-images \
  --repository-name gr00t-finetune-yoo \
  --region ap-northeast-2 \
  --query "imageDetails[0].{Tags:imageTags,PushedAt:imagePushedAt}" \
  --output table
```

---

## Step 4: Fine-tuning Job 제출

### 테스트 잡 (100 steps, ~10분)

```bash
aws batch submit-job \
  --job-name groot-finetune-test \
  --job-queue GrootFinetune-yoo-GrootFinetuneQueue \
  --job-definition GrootFinetune-yoo-GrootFinetuneJob \
  --region ap-northeast-2 \
  --container-overrides '{
    "environment": [
      {"name": "MAX_STEPS", "value": "100"},
      {"name": "SAVE_STEPS", "value": "50"}
    ]
  }'
```

### 본격 학습 잡 (6000 steps, ~2시간)

```bash
aws batch submit-job \
  --job-name groot-finetune-full \
  --job-queue GrootFinetune-yoo-GrootFinetuneQueue \
  --job-definition GrootFinetune-yoo-GrootFinetuneJob \
  --region ap-northeast-2 \
  --container-overrides '{
    "environment": [
      {"name": "MAX_STEPS", "value": "6000"},
      {"name": "SAVE_STEPS", "value": "2000"},
      {"name": "BATCH_SIZE", "value": "32"}
    ]
  }'
```

### Custom Dataset 사용 (HuggingFace)

```bash
aws batch submit-job \
  --job-name groot-finetune-custom \
  --job-queue GrootFinetune-yoo-GrootFinetuneQueue \
  --job-definition GrootFinetune-yoo-GrootFinetuneJob \
  --region ap-northeast-2 \
  --container-overrides '{
    "environment": [
      {"name": "HF_DATASET_ID", "value": "lerobot/aloha_mobile_cabinet"},
      {"name": "MAX_STEPS", "value": "6000"},
      {"name": "SAVE_STEPS", "value": "2000"}
    ]
  }'
```

---

## Step 5: Job 모니터링

```bash
# Job 상태 확인
JOB_ID=<submit-job에서 반환된 jobId>

aws batch describe-jobs \
  --jobs $JOB_ID \
  --region ap-northeast-2 \
  --query "jobs[0].{Status:status,Reason:statusReason,StartedAt:startedAt}" \
  --output table
```

```bash
# CloudWatch 로그 확인 (실시간)
aws logs tail /aws/batch/job --region ap-northeast-2 --follow
```

Job 상태 흐름: `SUBMITTED` → `PENDING` → `RUNNABLE` → `STARTING` → `RUNNING` → `SUCCEEDED`

---

## Step 6: DCV에서 결과 확인

DCV 인스턴스에 접속하여 EFS의 checkpoint를 확인합니다:

```bash
# DCV 접속 후
ls -la /home/ubuntu/environment/efs/gr00t/checkpoints/

# 최신 checkpoint 확인
ls -la /home/ubuntu/environment/efs/gr00t/checkpoints/checkpoint-*/
```

---

## 환경 변수 레퍼런스

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `MAX_STEPS` | 6000 | 총 학습 스텝 수 |
| `SAVE_STEPS` | 2000 | 체크포인트 저장 간격 |
| `NUM_GPUS` | 1 | 사용할 GPU 수 |
| `BATCH_SIZE` | 64 | 배치 크기 |
| `LEARNING_RATE` | 1e-4 | 학습률 |
| `DATA_CONFIG` | so100_dualcam | 데이터 설정 |
| `BASE_MODEL_PATH` | nvidia/GR00T-N1.7-3B | 베이스 모델 |
| `EMBODIMENT_TAG` | new_embodiment | 로봇 태그 |
| `TUNE_LLM` | false | LLM 레이어 학습 여부 |
| `TUNE_VISUAL` | false | Vision 레이어 학습 여부 |
| `TUNE_PROJECTOR` | true | Projector 학습 여부 |
| `TUNE_DIFFUSION_MODEL` | true | Diffusion 모델 학습 여부 |
| `LORA_RANK` | 0 | LoRA rank (0=비활성) |
| `UPLOAD_TARGET` | none | 업로드 대상 (none/s3/hf) |
| `REPORT_TO` | tensorboard | 로깅 백엔드 |
| `HF_DATASET_ID` | (없음) | HuggingFace 데이터셋 ID |
| `DATASET_S3_URI` | (없음) | S3 데이터셋 경로 |
| `DATASET_LOCAL_DIR` | /workspace/train | 로컬 데이터셋 경로 |

---

## 트러블슈팅

### Job이 RUNNABLE 상태에서 멈춤
- **원인**: G6E 인스턴스 용량 부족
- **해결**: 
  - 다른 AZ나 인스턴스 타입 시도
  - AWS 콘솔에서 Service Quotas 확인
  - 잠시 대기 후 재시도

### EFS 마운트 실패
- **원인**: 보안 그룹 규칙 누락
- **해결**: Batch SG → EFS SG로 TCP 2049 인바운드 허용 확인

### Container image not found
- **원인**: CodeBuild 빌드 미완료
- **해결**: CodeBuild 상태 확인 후 빌드 완료까지 대기

### Out of Memory (OOM)
- **원인**: PyTorch DataLoader shared memory 부족
- **해결**: `DATALOADER_NUM_WORKERS=2`로 줄여서 재시도

### 학습 Loss가 줄지 않음
- **원인**: 학습률 또는 배치 크기 부적절
- **해결**: `LEARNING_RATE=5e-5`, `BATCH_SIZE=16`으로 조정

---

## 스택 삭제

```bash
CDK_DEFAULT_REGION=ap-northeast-2 npx cdk destroy \
  -c vpcId=vpc-02f4c86c9ca8529ad \
  -c efsFileSystemId=fs-09ffa87abc4ce41d7 \
  -c efsSecurityGroupId=sg-0b29c11ff70f93790 \
  -c privateSubnetId=subnet-0dd77da9679e9ec81 \
  -c availabilityZone=ap-northeast-2a \
  -c userId=yoo \
  -c region=ap-northeast-2
```

> **참고**: ECR Repository는 `RETAIN` 정책으로 자동 삭제되지 않습니다. 수동 삭제 필요:
> ```bash
> aws ecr delete-repository --repository-name gr00t-finetune-yoo --region ap-northeast-2 --force
> ```
