# 워크숍 관리자 사전 체크리스트

멀티 사용자 워크숍 진행 전 관리자가 확인해야 할 항목.

## 1. CDK Bootstrap (필수, 계정+리전당 1회)

CDK가 사용하는 공유 인프라(`CDKToolkit` 스택: S3 버킷, ECR, IAM 역할)를 생성한다.
계정+리전 조합당 1개만 존재하며, 이후 모든 사용자의 `cdk deploy`가 이를 공유한다.

- 관리자가 워크숍 전에 1회 실행 (참가자는 실행 불필요)
- 여러 명이 동시에 실행하면 CloudFormation 충돌 발생
- 멀티리전 배포 시 각 리전마다 1회씩 실행

```bash
# 계정 ID 확인
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# us-east-1에 배포하는 경우 (1회)
cdk bootstrap aws://$ACCOUNT_ID/us-east-1

# 멀티리전 시 추가 리전도 각각 1회
cdk bootstrap aws://$ACCOUNT_ID/us-west-2
cdk bootstrap aws://$ACCOUNT_ID/ap-northeast-2

# 이미 bootstrap된 리전에서 다시 실행해도 안전 (업데이트만 수행)
```

> bootstrap 완료 후 참가자들이 각자 `cdk deploy -c userId=xxx`를 실행하면 된다.

## 2. 서비스 할당량 확인 및 증가 요청

참가자 수에 맞게 할당량을 사전 확인하고, 부족하면 증가 요청한다. 승인에 1~3일 소요될 수 있으므로 워크숍 최소 1주 전에 요청한다.

### 필요 할당량 계산

| 할당량 | 기본값 | 참가자당 사용량 | 10명 기준 필요량 |
|--------|:------:|:--------------:|:---------------:|
| Running On-Demand G and VT instances (vCPU) | 64 | g6.4xlarge=16, g6.12xlarge=48 | 160 (g6.4xlarge 기준) |
| VPCs per Region | 5 | 1 | 10 |
| EC2 Security Groups per Region | 2,500 | 4 | 40 |
| EFS File Systems per Region | 1,000 | 1 | 10 |

### 할당량 확인 명령어

```bash
REGION=us-east-1

# GPU 인스턴스 vCPU (가장 중요)
aws service-quotas get-service-quota \
  --service-code ec2 \
  --quota-code L-DB2E81BA \
  --region $REGION \
  --query 'Quota.Value' --output text

# VPC 수
aws service-quotas get-service-quota \
  --service-code vpc \
  --quota-code L-F678F1CE \
  --region $REGION \
  --query 'Quota.Value' --output text
```

### 할당량 증가 요청

```bash
# GPU vCPU 할당량 증가 (예: 10명 × g6.4xlarge 16 vCPU = 160)
aws service-quotas request-service-quota-increase \
  --service-code ec2 \
  --quota-code L-DB2E81BA \
  --desired-value 160 \
  --region $REGION

# VPC 할당량 증가
aws service-quotas request-service-quota-increase \
  --service-code vpc \
  --quota-code L-F678F1CE \
  --desired-value 20 \
  --region $REGION
```

또는 AWS 콘솔에서: Service Quotas → EC2 / VPC → 해당 항목 → Request increase

## 3. IAM 사용자/역할 준비

참가자별 IAM 사용자 또는 역할을 사전 생성한다. 필요 권한:

- `AdministratorAccess` (가장 간단) 또는
- 최소 권한: EC2, VPC, EFS, ECS, ECR, IAM, Secrets Manager, CloudFormation, Lambda, CloudWatch Logs, S3 (CDK asset 업로드)

```bash
# 참가자별 IAM 사용자 생성 예시
for USER in alice bob charlie; do
  aws iam create-user --user-name workshop-$USER
  aws iam attach-user-policy --user-name workshop-$USER \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
  aws iam create-access-key --user-name workshop-$USER > keys-$USER.json
done
```

## 4. 참가자 배포 가이드

### 로컬 환경에서 배포

```bash
# 의존성 설치
npm install

# 배포 (userId와 vpcCidr을 참가자별로 지정)
cdk deploy -c userId=<본인이름> -c vpcCidr=10.<번호>.0.0/16

# 예시
cdk deploy -c userId=alice -c vpcCidr=10.1.0.0/16
cdk deploy -c userId=bob -c vpcCidr=10.2.0.0/16
```

### CloudShell에서 배포

AWS CloudShell에는 Node.js, AWS CLI, IAM 자격 증명이 사전 설정되어 있어 별도 환경 구성 없이 바로 배포할 수 있다.

```bash
# 1. 리포지토리 클론 및 의존성 설치
git clone <리포지토리 URL>
cd isaac-lab-infra-templates-multiuser
npm install

# 2. 배포 (nohup으로 세션 끊김 방지)
nohup npx cdk deploy -c userId=alice -c vpcCidr=10.1.0.0/16 --require-approval never > deploy.log 2>&1 &

# 3. 배포 진행 상황 확인
tail -f deploy.log
```

> **주의: CloudShell은 20분 비활성 시 세션이 종료된다.** `cdk deploy`는 UserData 완료까지 최대 60분 대기하므로, 반드시 `nohup &`으로 백그라운드 실행해야 한다. 세션이 끊겨도 배포는 계속 진행되며, 재접속 후 `tail -f deploy.log`로 확인하거나 CloudFormation 콘솔에서 스택 상태를 확인할 수 있다.

CloudShell 배포 완료 후 결과 확인:

```bash
# 배포 완료 확인
cat deploy.log | grep -E 'Outputs|DcvUrl|SecretArn'

# 또는 CloudFormation에서 직접 조회
aws cloudformation describe-stacks \
  --stack-name IsaacLab-Stable-alice \
  --query 'Stacks[0].Outputs' --output table
```

### 참가자별 VPC CIDR 할당표 예시

| 참가자 | userId | vpcCidr |
|--------|--------|---------|
| Alice | alice | 10.1.0.0/16 |
| Bob | bob | 10.2.0.0/16 |
| Charlie | charlie | 10.3.0.0/16 |
| ... | ... | 10.N.0.0/16 |

> vpcCidr의 두 번째 옥텟을 참가자 번호로 사용하면 간단하다. 미지정 시 기본값 10.0.0.0/16.

## 5. 워크숍 종료 후 정리

### 참가자 개별 정리

```bash
cdk destroy -c userId=<본인이름>
```

### 관리자 일괄 정리

```bash
# 모든 워크숍 스택 삭제
for USER in alice bob charlie; do
  echo "Deleting stack for $USER..."
  aws cloudformation delete-stack --stack-name IsaacLab-Stable-$USER --region $REGION
done

# 삭제 완료 대기
for USER in alice bob charlie; do
  aws cloudformation wait stack-delete-complete --stack-name IsaacLab-Stable-$USER --region $REGION
  echo "Deleted: IsaacLab-Stable-$USER"
done

# ECR 리포지토리 정리 (이미지 포함 강제 삭제)
for USER in alice bob charlie; do
  aws ecr delete-repository --repository-name isaaclab-batch-$USER --force --region $REGION 2>/dev/null
done

# IAM 사용자 정리
for USER in alice bob charlie; do
  KEY_ID=$(aws iam list-access-keys --user-name workshop-$USER --query 'AccessKeyMetadata[0].AccessKeyId' --output text)
  aws iam delete-access-key --user-name workshop-$USER --access-key-id $KEY_ID
  aws iam detach-user-policy --user-name workshop-$USER \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
  aws iam delete-user --user-name workshop-$USER
done
```

## 6. 트러블슈팅

### 배포 실패: "Resource limit exceeded"
→ 서비스 할당량 부족. 위 2번 항목 참조.

### 배포 실패: "Stack [IsaacLab-Stable] already exists"
→ userId를 지정하지 않아 다른 참가자의 스택과 충돌. `-c userId=<이름>` 추가.

### 배포 실패: "InsufficientInstanceCapacity"
→ 해당 리전의 모든 AZ에서 GPU capacity 부족. 다른 인스턴스 타입 또는 리전 시도:
```bash
cdk deploy -c userId=alice -c inferenceInstanceType=g6e.4xlarge
cdk deploy -c userId=alice -c region=us-west-2
```

### 배포가 오래 걸림 (30분+)
→ 정상. UserData에서 Docker 빌드 등이 진행 중. SSM Session Manager로 접속하여 확인:
```bash
sudo tail -f /var/log/user-data.log
```

### ECR 리포지토리 삭제 안 됨
→ 이미지가 남아있으면 `--force` 옵션 필요:
```bash
aws ecr delete-repository --repository-name isaaclab-batch-alice --force --region $REGION
```
