# HyperPod 분산 학습 인프라 — 실습 가이드

AWS SageMaker HyperPod 기반 Physical AI (VLA/RL) 분산 학습 환경을 배포하고, 데이터 준비부터 학습 실행, MLflow 모니터링까지 전체 파이프라인을 실습합니다.

## 아키텍처 요약

```
┌─────────────────────────────────────────────────────────┐
│ HyperPod Cluster (SLURM Managed)                        │
│  ├─ head   (ml.m5.xlarge; workshop-studio 프로필은 ml.g5.2xlarge) — 컨트롤러, 상시 운영 │
│  ├─ gpu-g5-12x (ml.g5.12xlarge) — VLA/RL 학습 (0에서)    │
│  │     -c gpuGroups=extended: g6e/g6/p4d/p5 그룹 추가    │
│  │     (전부 노드 0에서 시작)                            │
│  └─ debug  (ml.g5.8xlarge)    — 디버깅/시각화 (0에서)    │
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
- 리전: `us-east-1` (배포 전 GPU 쿼터 확인 — 아래 참고)

---

## Step 1: CDK 프로젝트 설정

```bash
cd hyperpod-training/infra
npm install
```

CDK Bootstrap (최초 1회):
```bash
cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

## Step 2: 인프라 배포

### 기본 배포

```bash
npx cdk deploy -c region=us-east-1 --require-approval never
```

### 배포 파라미터 커스터마이즈

`bin/app.ts`가 읽는 CDK context 파라미터입니다.

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `region` | `CDK_DEFAULT_REGION` | 배포 리전 |
| `createVpc` | true | VPC를 새로 생성 (false면 기존 VPC 사용) |
| `vpcCidr` | 10.0.0.0/16 | 생성할 VPC의 CIDR |
| `gpuMaxCount` | 4 | GPU 인스턴스 타입별 그룹의 최대 노드 수 |
| `gpuGroups` | core | GPU 그룹 프로필. `core` = gpu-g5-12x 하나(Workshop Studio SageMaker 허용 목록 호환), `extended` = g6e/g6/p4d/p5 그룹 추가 |
| `profile` | personal | 배포 프로필. `workshop-studio` = Workshop Studio 이벤트 계정(head 노드 `ml.g5.2xlarge` — cluster 허용 타입 중 최소; SageMaker 증량 리전 us-east-1/us-west-2에서만) |
| `gpuCount` | 0 | 기본 학습 그룹(gpu-g5-12x, ml.g5.12xlarge)에서 기동할 노드 수 (배포 후에는 `scripts/scale-cluster.sh` 사용 권장) |
| `debugCount` | 0 | debug(DCV) 그룹에서 기동할 노드 수 (0 또는 1) |
| `gpuUseSpot` | false | GPU 그룹에 Spot 인스턴스 사용 |
| `fsxCapacityGiB` | 1200 | FSx 스토리지 용량 (GiB) |
| `enableMlflow` | false | (옵션) 관리형 MLflow 실험 추적 서버 생성 여부 |
| `amiUpdateSchedule` | `cron(00 18 ? * 1#2 *)` | AMI 보안 패치 스케줄 (`off`로 비활성화) |

예시 — 소규모 테스트:
```bash
npx cdk deploy \
  -c region=us-east-1 \
  -c gpuMaxCount=1 \
  -c fsxCapacityGiB=1200 \
  --require-approval never
```

> **GPU 쿼터 확인 필수.** GPU 인스턴스 그룹은 `lib/config/cluster-config.ts`의
> 프로필(`core`: g5-12x / `extended`: + g6e/g6/p4d/p5)대로 타입별로 하나씩 생성되며, 초기 노드 수는
> 모두 0입니다. 쿼터가 0인 타입은 job이 영구히 `PENDING`에 머무르므로 배포 전에 확인하세요.
>
> ```bash
> aws service-quotas list-service-quotas --service-code sagemaker --region us-east-1 \
>   --query "Quotas[?contains(QuotaName,'cluster usage') && Value>\`0\`].[QuotaName,Value]" --output text
> ```

### 배포 확인 (약 20분 소요)

```bash
# 스택 상태 확인
aws cloudformation describe-stacks \
  --stack-name HyperPod-<ACCOUNT_ID> \
  --region us-east-1 \
  --query "Stacks[0].StackStatus"

# 출력값 확인
aws cloudformation describe-stacks \
  --stack-name HyperPod-<ACCOUNT_ID> \
  --region us-east-1 \
  --query "Stacks[0].Outputs"
```

## GPU 노드 스케일 업/다운 (scale-cluster.sh)

GPU 인스턴스 그룹은 배포 직후 노드 수 0으로 시작합니다 (비용 0). 학습 직전에
노드를 올리고, 끝나면 다시 0으로 내립니다. CDK 재배포 없이
`aws sagemaker update-cluster`를 감싼 스크립트를 사용하세요:

```bash
# 학습용 GPU 노드 1대 기동 (InService까지 대기, 10~20분)
./scripts/scale-cluster.sh gpu-g5-12x 1 --wait

# 학습 종료 후 0으로 축소
./scripts/scale-cluster.sh gpu-g5-12x 0

# DCV 디버그 노드 (시각화 검증)
./scripts/scale-cluster.sh debug 1 --wait
```

> 스크립트는 CloudFormation 밖에서 노드 수를 바꾸므로 CDK 스택과 드리프트가 생깁니다.
> 이후 `cdk deploy`를 다시 실행하면 노드 수가 context 값(기본 0)으로 되돌아가고,
> `cdk destroy`에는 영향이 없습니다. IaC로 일관되게 관리하고 싶다면
> `-c gpuCount=1` 재배포 방식도 유효합니다(이때 기존 배포에 사용한 다른 context
> 값들을 반드시 함께 지정).

## Step 3: 클러스터 상태 확인

```bash
CLUSTER_NAME="hyperpod-<ACCOUNT_ID>"

# 클러스터 상태
aws sagemaker describe-cluster \
  --cluster-name ${CLUSTER_NAME} \
  --region us-east-1 \
  --query "{Status:ClusterStatus,Groups:InstanceGroups[*].{Name:InstanceGroupName,Count:CurrentCount,Status:Status}}"

# 노드 목록
aws sagemaker list-cluster-nodes \
  --cluster-name ${CLUSTER_NAME} \
  --region us-east-1
```

예상 결과:
```json
{
  "Status": "InService",
  "Groups": [
    { "Name": "head",        "Count": 1, "Status": "InService" },
    { "Name": "gpu-g5-12x",  "Count": 0, "Status": "InService" },
    { "Name": "debug",       "Count": 0, "Status": "InService" }
  ]
}
```

## AMI 보안 패치 (Scheduled Update)

HyperPod AMI에는 커널·NVIDIA 드라이버·OpenSSL 등이 포함되고, AWS가 주기적으로 보안 패치 AMI를 릴리스합니다. 패치하지 않으면 노드는 생성 당시 AMI에 그대로 머무릅니다.

**CDK에 이미 예약 스케줄이 켜져 있습니다.** `DEFAULT_AMI_UPDATE_SCHEDULE`(`lib/config/cluster-config.ts`)이 모든 인스턴스 그룹의 `ScheduledUpdateConfig`에 적용되어, 매월 둘째 일요일 18:00 UTC(한국시간 월요일 오전 3시)에 자동 패치됩니다. 새 클러스터를 만들 때 별도 조치가 필요 없습니다.

```bash
# 스케줄 확인
aws sagemaker describe-cluster --cluster-name ${CLUSTER_NAME} --region us-east-1 \
  --query "InstanceGroups[].{Name:InstanceGroupName,Schedule:ScheduledUpdateConfig.ScheduleExpression}"

# 마지막 패치 시각 확인 (LaunchTime과 같으면 한 번도 패치되지 않은 것)
aws sagemaker list-cluster-nodes --cluster-name ${CLUSTER_NAME} --region us-east-1 \
  --query "ClusterNodeSummaries[].{Group:InstanceGroupName,Launch:LaunchTime,LastPatch:LastSoftwareUpdateTime}"

# 예약 시각을 기다리지 않고 즉시 패치 (아래 사전 조건을 먼저 확인)
aws sagemaker update-cluster-software --cluster-name ${CLUSTER_NAME} --region us-east-1
```

스케줄을 끄고 배포하려면 `-c amiUpdateSchedule=off`, 주기를 바꾸려면 `-c amiUpdateSchedule='cron(00 18 1 * ? *)'`를 씁니다.

### 패치 전 반드시 확인할 것

1. **라이프사이클 버킷이 살아 있어야 합니다.** 패치는 루트 볼륨을 새 AMI로 교체한 뒤 `LifeCycleConfig.SourceS3Uri`의 `on_create.sh`를 다시 실행합니다. 버킷이 없으면 패치가 실패하고 클러스터가 `Failed`로 떨어집니다.
   ```bash
   aws s3 ls s3://hyperpod-lifecycle-<account>-<region>/lifecycle-scripts/
   ```
2. **루트 볼륨은 초기화됩니다.** `/fsx`(FSx Lustre)는 유지되지만 `/home/ubuntu`, Slurm accounting DB(mariadb) 등 루트 볼륨 데이터는 사라집니다. 필요하면 AWS 제공 [`patching-backup.sh`](https://github.com/aws-samples/awsome-distributed-training/blob/main/1.architectures/5.sagemaker-hyperpod/patching-backup.sh)로 S3에 백업합니다.
   ```bash
   sudo bash patching-backup.sh --create s3://<backup-bucket-path>   # 패치 전
   sudo bash patching-backup.sh --restore s3://<backup-bucket-path>  # 패치 후
   ```
3. **실행 중인 작업이 없어야 합니다.** Slurm 클러스터는 인스턴스 그룹이 한꺼번에 교체되므로 진행 중인 job은 중단됩니다(`squeue`로 확인).

### Slurm 클러스터의 제약

| 기능 | Slurm | 비고 |
|---|---|---|
| `ScheduledUpdateConfig` (cron 예약) | ✅ | 이 프로젝트에서 사용 |
| `AutoPatchConfig` (유휴 노드 자동 패치, 워크로드 무중단) | ❌ | **EKS 전용** |
| `DeploymentConfig` (배치 롤링 교체 + CloudWatch 자동 롤백) | ❌ | **EKS 전용** |
| 콘솔에서 Update AMI | ❌ | **EKS 전용**, API/CLI만 가능 |

즉 Slurm에서는 워크로드를 피해가는 패치가 불가능하므로, 예약 시각을 학습이 없는 시간대로 잡는 것이 중요합니다.
참고: [AMI 업데이트 문서](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-release-ami-update.html) · [자동 패치 문서](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-ami-auto-patching.html)

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
  --region us-east-1 > ~/.ssh/hyperpod-jump.pem

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
  -i <(aws s3 cp s3://hyperpod-lifecycle-<ACCOUNT_ID>-us-east-1/ssh/cluster_access_key -) \
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
> aws s3 cp s3://hyperpod-lifecycle-<ACCOUNT_ID>-us-east-1/ssh/cluster_access_key ~/.ssh/cluster_access_key
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
BUCKET="hyperpod-data-<ACCOUNT_ID>-us-east-1"

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
sbatch --partition=dev --gres=gpu:4 --nodes=1 <<'EOF'
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
export MLFLOW_TRACKING_URI="https://us-east-1.experiments.sagemaker.aws/mlflow/hyperpod-<ACCOUNT_ID>-mlflow"
```

### MLflow UI 접근

SageMaker Managed MLflow UI는 CDK 배포 시 출력되는 `MLflowTrackingUri`로 접근합니다:
```
https://us-east-1.experiments.sagemaker.aws/mlflow/hyperpod-<ACCOUNT_ID>-mlflow
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
npx cdk destroy -c region=us-east-1 --force

# 삭제 실패 시 (S3 버킷 비어있지 않음):
aws s3 rm s3://hyperpod-lifecycle-<ACCOUNT_ID>-us-east-1 --recursive
aws cloudformation delete-stack --stack-name HyperPod-<ACCOUNT_ID> --region us-east-1
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

### 패치 실패: "The lifecycle configuration bucket ... was not found or does not exist"
- 라이프사이클 스크립트 버킷이 삭제된 상태에서 `update-cluster-software`를 호출한 경우
- 클러스터가 `SystemUpdating` → `RollingBack` → `Failed`로 떨어짐 (노드는 교체 전에 중단되므로 데이터는 보존됨)
- 복구: 같은 이름으로 버킷을 다시 만들고 스크립트를 올린 뒤 패치를 재시도
  ```bash
  B=hyperpod-lifecycle-<account>-us-east-1
  aws s3api create-bucket --bucket $B --region us-east-1 \
    --create-bucket-configuration LocationConstraint=us-east-1
  aws s3 cp lifecycle-scripts/ s3://$B/lifecycle-scripts/ --recursive --exclude "*" --include "*.sh"
  printf '%s' "$B" | aws s3 cp - s3://$B/lifecycle-scripts/bucket.conf
  aws sagemaker update-cluster-software --cluster-name <cluster> --region us-east-1
  ```
- 예방: 버킷에 삭제 방지를 걸거나, 패치 전 사전 점검 항목으로 버킷 존재를 확인

### S3 버킷 삭제 실패
- 버킷이 비어있지 않으면 삭제 불가
- `aws s3 rm s3://<bucket-name> --recursive` 후 스택 삭제 재시도

---

## 비용 참고

| 컴포넌트 | 시간당 비용 | 비고 |
|---------|------------|------|
| Head Node (ml.m5.xlarge) | ~$0.20 | 상시 운영 |
| Head Node (workshop-studio 프로필, ml.g5.2xlarge) | ~$1.21 | 위 행을 대체 |
| Train (gpu-g5-12x, ml.g5.12xlarge) | ~$7.00 | 학습 시에만 |
| Debug (ml.g5.8xlarge) | ~$3.00 | 시각 검증 시에만 |
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
