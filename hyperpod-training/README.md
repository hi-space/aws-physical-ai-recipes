# HyperPod 분산 학습 인프라 — 실습 가이드

AWS SageMaker HyperPod 기반 Physical AI (VLA/RL) 분산 학습 환경을 배포하고, 데이터 준비부터 학습 실행, MLflow 모니터링까지 전체 파이프라인을 실습합니다.

## 아키텍처 요약

```
┌─────────────────────────────────────────────────────────┐
│ HyperPod Cluster (SLURM Managed)                        │
│  ├─ head   (ml.m5.xlarge)    — 컨트롤러, 상시 운영       │
│  ├─ sim    (ml.g5.12xlarge)  — IsaacLab 시뮬레이션       │
│  ├─ train  (ml.g6e.12xlarge) — VLA/RL 학습              │
│  └─ debug  (ml.g5.4xlarge)   — 디버깅/시각화            │
├─────────────────────────────────────────────────────────┤
│ Storage                                                  │
│  ├─ FSx for Lustre (1.2TB) ← /fsx 마운트               │
│  └─ S3 Data Bucket ↔ FSx 자동 동기화                    │
├─────────────────────────────────────────────────────────┤
│ MLflow Tracking Server (SageMaker Managed)              │
└─────────────────────────────────────────────────────────┘
```

## 사전 준비

- AWS CLI v2 + credentials 설정 완료
- Node.js 18+ / npm
- AWS CDK CLI (`npm install -g aws-cdk`)
- Session Manager Plugin ([설치 가이드](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html))
- 리전: `us-west-2` (HyperPod 지원 리전)

---

## Step 1: CDK 프로젝트 설정

```bash
cd hyperpod-training/infra
npm install
```

CDK Bootstrap (최초 1회):
```bash
cdk bootstrap aws://ACCOUNT_ID/us-west-2
```

## Step 2: 인프라 배포

### 기본 배포

```bash
npx cdk deploy -c userId=<your-name> -c region=us-west-2 --require-approval never
```

### 배포 파라미터 커스터마이즈

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `userId` | (필수) | 사용자 식별자 (영소문자, 숫자, 하이픈) |
| `region` | us-west-2 | 배포 리전 |
| `trainInstanceType` | ml.g6e.12xlarge | 학습 인스턴스 (L40S×4) |
| `trainPreset` | default | default/heavy/max |
| `simInstanceType` | ml.g5.12xlarge | 시뮬레이션 인스턴스 (A10×4) |
| `simMaxCount` | 16 | Sim 파티션 최대 노드 수 |
| `trainMaxCount` | 4 | Train 파티션 최대 노드 수 |
| `fsxCapacityGiB` | 1200 | FSx 스토리지 용량 (GiB) |
| `simUseSpot` | true | Sim 파티션 Spot 인스턴스 사용 |
| `enableMlflow` | true | MLflow 서버 생성 여부 |

예시 — 소규모 테스트:
```bash
npx cdk deploy \
  -c userId=researcher-a \
  -c region=us-west-2 \
  -c trainMaxCount=1 \
  -c simMaxCount=2 \
  -c fsxCapacityGiB=1200 \
  --require-approval never
```

### 배포 확인 (약 20분 소요)

```bash
# 스택 상태 확인
aws cloudformation describe-stacks \
  --stack-name HyperPod-<userId> \
  --region us-west-2 \
  --query "Stacks[0].StackStatus"

# 출력값 확인
aws cloudformation describe-stacks \
  --stack-name HyperPod-<userId> \
  --region us-west-2 \
  --query "Stacks[0].Outputs"
```

## Step 3: 클러스터 상태 확인

```bash
CLUSTER_NAME="hyperpod-<userId>"

# 클러스터 상태
aws sagemaker describe-cluster \
  --cluster-name ${CLUSTER_NAME} \
  --region us-west-2 \
  --query "{Status:ClusterStatus,Groups:InstanceGroups[*].{Name:InstanceGroupName,Count:CurrentCount,Status:Status}}"

# 노드 목록
aws sagemaker list-cluster-nodes \
  --cluster-name ${CLUSTER_NAME} \
  --region us-west-2
```

예상 결과:
```json
{
  "Status": "InService",
  "Groups": [
    { "Name": "head",  "Count": 1, "Status": "InService" },
    { "Name": "sim",   "Count": 0, "Status": "InService" },
    { "Name": "train", "Count": 0, "Status": "InService" },
    { "Name": "debug", "Count": 0, "Status": "InService" }
  ]
}
```

## Step 4: Head Node 접속 (SSH via Jump Host)

CDK 배포 시 Jump Host가 Public Subnet에 생성됩니다. 이를 경유하여 Head Node에 SSH 접속합니다.

### 4.1 SSH 키 다운로드

CDK 출력값의 `JumpKeyCommand`를 실행하여 Jump Host의 SSH 키를 다운로드합니다.

```bash
# Jump Host SSH 키 다운로드
aws ssm get-parameter \
  --name /ec2/keypair/<KEY_PAIR_ID> \
  --with-decryption \
  --query Parameter.Value \
  --output text \
  --region us-west-2 > ~/.ssh/hyperpod-jump.pem

chmod 600 ~/.ssh/hyperpod-jump.pem
```

> `<KEY_PAIR_ID>`는 CDK 출력의 `JumpKeyCommand`에서 확인할 수 있습니다.

### 4.2 Jump Host 접속

```bash
JUMP_IP="<CDK 출력의 JumpHostIp>"

ssh -i ~/.ssh/hyperpod-jump.pem ec2-user@${JUMP_IP}
```

### 4.3 Head Node 접속

Jump Host에는 Head Node 접속용 키(`~/.ssh/cluster_access_key`)가 자동으로 배포되어 있습니다.

```bash
# Jump Host에서 실행
HEAD_IP="<head node private IP>"  # describe-cluster-node으로 확인

ssh -i ~/.ssh/cluster_access_key ubuntu@${HEAD_IP}
```

또는 로컬에서 ProxyJump로 한 번에 접속:
```bash
ssh -i ~/.ssh/hyperpod-jump.pem -o ProxyCommand="ssh -i ~/.ssh/hyperpod-jump.pem -W %h:%p ec2-user@${JUMP_IP}" \
  -i <(aws s3 cp s3://hyperpod-lifecycle-hyperpod-<userId>-<ACCOUNT_ID>-us-west-2/ssh/cluster_access_key -) \
  ubuntu@${HEAD_IP}
```

### 4.4 SSH Config 설정 (권장)

`~/.ssh/config`에 아래를 추가하면 `ssh hyperpod`로 바로 접속 가능합니다:

```
Host hyperpod-jump
    HostName <JUMP_IP>
    User ec2-user
    IdentityFile ~/.ssh/hyperpod-jump.pem

Host hyperpod
    HostName <HEAD_NODE_PRIVATE_IP>
    User ubuntu
    IdentityFile ~/.ssh/cluster_access_key
    ProxyJump hyperpod-jump
```

> `cluster_access_key`는 Jump Host의 `~/.ssh/cluster_access_key`를 로컬로 복사하거나, S3에서 다운로드합니다:
> ```bash
> aws s3 cp s3://hyperpod-lifecycle-hyperpod-<userId>-<ACCOUNT_ID>-us-west-2/ssh/cluster_access_key ~/.ssh/cluster_access_key
> chmod 600 ~/.ssh/cluster_access_key
> ```

### 4.5 접속 후 확인

```bash
sinfo                  # SLURM 파티션 상태
df -h /fsx             # FSx 마운트 확인
ls /fsx/               # datasets, checkpoints, scratch 디렉토리
```

## Step 5: 데이터셋 업로드 (S3 → FSx 자동 동기화)

S3에 데이터를 업로드하면 FSx `/fsx/datasets/`에 자동으로 동기화됩니다.

```bash
# 로컬에서 S3로 데이터 업로드
BUCKET="hyperpod-data-hyperpod-<userId>-913524902871-us-west-2"

aws s3 cp ./my-dataset/ s3://${BUCKET}/datasets/groot/my-robot/ --recursive

# 수분 후 head node에서 확인
ls /fsx/datasets/groot/my-robot/
```

### LeRobot v2 형식 데이터셋 구조

```
/fsx/datasets/groot/aloha/
├── meta/
│   ├── info.json
│   ├── episodes.jsonl
│   └── tasks.jsonl
├── data/
│   ├── chunk-000/
│   │   └── episode_000000.parquet
│   └── ...
└── videos/
    ├── chunk-000/
    │   └── observation.images.top/
    │       └── episode_000000.mp4
    └── ...
```

## Step 6: VLA 학습 실행 (GR00T Fine-tuning)

### SLURM 작업 제출

```bash
# head node에서 실행
cd /fsx/scratch

# 학습 스크립트 복사 (S3에서 자동 동기화되었거나 직접 복사)
cp /path/to/examples/vla/train_groot.py .

# SLURM 템플릿으로 제출
/path/to/slurm-templates/vla/run_vla.sh \
  --model groot \
  --dataset /fsx/datasets/groot/aloha \
  --epochs 50 \
  --nodes 1
```

### 직접 sbatch 제출

```bash
sbatch --partition=train --gres=gpu:4 --nodes=1 <<'EOF'
#!/bin/bash
#SBATCH --job-name=groot-finetune
#SBATCH --output=/fsx/scratch/logs/groot-%j.out

srun --container-image=nvcr.io/nvidia/gr00t:1.6.0 \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       /fsx/scratch/train_groot.py \
       --dataset-path /fsx/datasets/groot/aloha \
       --modality-config aloha \
       --output-dir /fsx/checkpoints/vla/groot-aloha \
       --max-steps 5000
EOF
```

### 작업 모니터링

```bash
squeue                              # 작업 큐 확인
squeue -j <JOB_ID>                  # 특정 작업 상태
tail -f /fsx/scratch/logs/groot-<JOB_ID>.out  # 실시간 로그
scancel <JOB_ID>                    # 작업 취소
```

## Step 7: RL 학습 실행 (IsaacLab + Ray)

Actor-Learner 패턴으로 시뮬레이션과 학습을 동시 실행합니다.

```bash
# head node에서 실행
/path/to/slurm-templates/rl/run_rl.sh \
  --env Isaac-Cartpole-v0 \
  --num-actors 8

# 출력 예시:
# === RL Training: Isaac-Cartpole-v0 ===
#   Actors: 8
#   Learner job: 123
#   Actor jobs: 124 (array 0-7)
```

## Step 8: MLflow로 실험 추적

### MLflow 설정

```bash
# head node에서 MLflow 클라이언트 설치
pip install mlflow sagemaker-mlflow boto3

# 트래킹 URI 설정 (CDK 출력값 사용)
export MLFLOW_TRACKING_URI="https://us-west-2.experiments.sagemaker.aws/mlflow/hyperpod-<userId>-mlflow"
```

### MLflow UI 접근

SageMaker Managed MLflow UI는 CDK 배포 시 출력되는 `MLflowTrackingUri`로 접근합니다:
```
https://us-west-2.experiments.sagemaker.aws/mlflow/hyperpod-<userId>-mlflow
```

### 학습 코드에서 MLflow 사용

```python
import mlflow

mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
mlflow.set_experiment("groot-finetune")

with mlflow.start_run():
    mlflow.log_params({"lr": 2e-5, "batch_size": 32})
    # ... 학습 루프 ...
    mlflow.log_metrics({"loss": 0.01, "accuracy": 0.95}, step=1000)
```

## Step 9: 체크포인트 확인 (FSx → S3 자동 익스포트)

학습 결과가 `/fsx/checkpoints/`에 저장되면 S3로 자동 익스포트됩니다.

```bash
# FSx에서 확인
ls /fsx/checkpoints/vla/groot-aloha/

# S3에서 확인 (수분 후 동기화)
aws s3 ls s3://${BUCKET}/checkpoints/vla/groot-aloha/
```

## Step 10: 리소스 정리

```bash
# 스택 삭제 (20분 소요)
cd hyperpod-training/infra
npx cdk destroy -c userId=<your-name> -c region=us-west-2 --force

# 삭제 실패 시 (S3 버킷 비어있지 않음):
aws s3 rm s3://hyperpod-lifecycle-hyperpod-<userId>-913524902871-us-west-2 --recursive
aws cloudformation delete-stack --stack-name HyperPod-<userId> --region us-west-2
```

---

## 트러블슈팅

### 배포 실패: "Unable to retrieve subnets"
- Execution Role에 EC2 VPC 권한 필요 → CDK에 이미 포함됨

### 배포 실패: "InstanceGroups must have a SlurmConfig with Controller node type"
- head 그룹에 `SlurmConfig: { NodeType: Controller }` 필요 → CDK에 이미 포함됨

### SSM 접속 안 됨
- AWS Console에서 접속하세요 (SageMaker > HyperPod > Clusters > Connect)
- CLI 접속에는 session-manager-plugin 설치 필요

### FSx 마운트 안 됨
- Lifecycle script의 FSX_DNS_NAME/FSX_MOUNT_NAME이 설정되어야 함
- 클러스터 생성 후 FSx 정보를 lifecycle script에 설정 필요

### MLflow "already exists" 에러
- 이전 배포에서 MLflow 서버가 남아있음
- `aws sagemaker delete-mlflow-tracking-server --tracking-server-name <name>` 후 재배포

### S3 버킷 삭제 실패
- 버킷이 비어있지 않으면 삭제 불가
- `aws s3 rm s3://<bucket-name> --recursive` 후 스택 삭제 재시도

---

## 비용 참고

| 컴포넌트 | 시간당 비용 | 비고 |
|---------|------------|------|
| Head Node (ml.m5.xlarge) | ~$0.20 | 상시 운영 |
| Train (ml.g6e.12xlarge) | ~$7.00 | 학습 시에만 |
| Sim (ml.g5.12xlarge, Spot) | ~$2.00 | 시뮬레이션 시에만 |
| FSx (1.2TB) | ~$0.55 | 상시 |
| MLflow | ~$0.10 | 상시 |
| **실습 중 (head only)** | **~$0.85/hr** | |
| **학습 실행 시** | **~$8-10/hr** | |

실습 후 반드시 `cdk destroy`로 정리하세요.

---

## 다음 단계

- [아키텍처 상세 문서](./docs/architecture.md)
- [리서처 가이드](./docs/researcher_guide.md)
- [VLA 학습 예제](./examples/vla/)
- [RL 학습 예제](./examples/rl/)
- [SLURM 템플릿](./slurm-templates/)
