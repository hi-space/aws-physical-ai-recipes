# OSMO on EKS Workshop Guide

NVIDIA OSMO를 AWS EKS에 배포하고, GR00T Fine-tuning과 Isaac Sim 검증 파이프라인을 실행하는 실습 가이드입니다.

---

## 실습 개요

| Step | 내용 | 소요 시간 |
|------|------|-----------|
| 1 | 인프라 배포 (CDK) | ~20분 |
| 2 | Post-deploy 설정 (kubectl/helm) | ~5분 |
| 3 | IRSA 및 ServiceAccount 구성 | ~5분 |
| 4 | 인프라 검증 (S3, GPU, Autoscaler) | ~10분 |
| 5 | OSMO Workflow 실행 | ~30분 |
| 6 | 정리 (Cleanup) | ~15분 |

---

## Step 1. 인프라 배포 (CDK)

### 1.1 사전 요구사항 확인

```bash
# AWS CLI 및 자격 증명
aws --version
aws sts get-caller-identity

# Node.js & CDK
node --version
cdk --version

# kubectl
kubectl version --client
```

### 1.2 CDK 배포

```bash
cd osmo/cdk
npm install
cdk deploy --require-approval never
```

배포 완료까지 약 20분 소요됩니다 (EKS 클러스터 ~10분, RDS ~8분).

### 1.3 배포 결과 확인

```bash
aws cloudformation describe-stacks --stack-name Osmo \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' \
  --output table
```

출력 예시:

| Key | Value |
|-----|-------|
| EksClusterName | osmo-eks |
| S3BucketName | osmo-data-osmo-ACCOUNT-REGION |
| VpcId | vpc-0xxxxxxxxx |
| OsmoDbEndpoint | osmo-postgres.xxx.rds.amazonaws.com |
| OsmoRedisEndpoint | osmo-redis.xxx.cache.amazonaws.com |

---

## Step 2. Post-deploy 설정

### 2.1 kubeconfig 설정

```bash
aws eks update-kubeconfig --name osmo-eks --region us-west-2
kubectl get nodes
```

예상 출력:
```
NAME                                       STATUS   ROLES    AGE   VERSION
ip-10-0-1-xxx.us-west-2.compute.internal   Ready    <none>   5m    v1.30.x
ip-10-0-3-xxx.us-west-2.compute.internal   Ready    <none>   5m    v1.30.x
```

### 2.2 NVIDIA Device Plugin 설치

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.14.5/nvidia-device-plugin.yml
```

### 2.3 gp3 StorageClass 설정

```bash
kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
EOF
```

### 2.4 osmo 네임스페이스 생성

```bash
kubectl create namespace osmo
```

### 2.5 Cluster Autoscaler 설치

```bash
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update autoscaler

helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  --namespace kube-system \
  --set autoDiscovery.clusterName=osmo-eks \
  --set awsRegion=us-west-2 \
  --set image.tag=v1.30.2 \
  --set rbac.serviceAccount.create=true \
  --set rbac.serviceAccount.name=cluster-autoscaler \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/osmo-cluster-autoscaler-role
```

---

## Step 3. IRSA 및 ServiceAccount 구성

### 3.1 OIDC Provider 등록

```bash
OIDC_URL=$(aws eks describe-cluster --name osmo-eks --query 'cluster.identity.oidc.issuer' --output text)
OIDC_ID=$(echo $OIDC_URL | cut -d '/' -f5)

THUMBPRINT=$(echo | openssl s_client -servername oidc.eks.us-west-2.amazonaws.com \
  -connect oidc.eks.us-west-2.amazonaws.com:443 2>/dev/null | \
  openssl x509 -fingerprint -noout | sed 's/://g' | cut -d= -f2 | tr '[:upper:]' '[:lower:]')

aws iam create-open-id-connect-provider \
  --url "$OIDC_URL" \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list "$THUMBPRINT"
```

### 3.2 Cluster Autoscaler IAM Role

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OIDC_PROVIDER=$(echo $OIDC_URL | sed 's|https://||')

cat > /tmp/ca-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_PROVIDER}:sub": "system:serviceaccount:kube-system:cluster-autoscaler",
        "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name osmo-cluster-autoscaler-role \
  --assume-role-policy-document file:///tmp/ca-trust-policy.json

aws iam put-role-policy \
  --role-name osmo-cluster-autoscaler-role \
  --policy-name cluster-autoscaler-policy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeScalingActivities",
        "autoscaling:DescribeTags",
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeImages",
        "ec2:GetInstanceTypesFromInstanceRequirements",
        "eks:DescribeNodegroup"
      ],
      "Resource": "*"
    }]
  }'
```

### 3.3 OSMO Workload IAM Role

```bash
cat > /tmp/workload-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "${OIDC_PROVIDER}:sub": "system:serviceaccount:osmo:*",
        "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name osmo-workload-role \
  --assume-role-policy-document file:///tmp/workload-trust-policy.json

BUCKET=$(aws cloudformation describe-stacks --stack-name Osmo \
  --query 'Stacks[0].Outputs[?OutputKey==`S3BucketName`].OutputValue' --output text)

aws iam put-role-policy \
  --role-name osmo-workload-role \
  --policy-name osmo-s3-access \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\",\"s3:PutObject\",\"s3:ListBucket\",\"s3:DeleteObject\"],
        \"Resource\": [
          \"arn:aws:s3:::${BUCKET}\",
          \"arn:aws:s3:::${BUCKET}/*\"
        ]
      },
      {
        \"Effect\": \"Allow\",
        \"Action\": [\"secretsmanager:GetSecretValue\"],
        \"Resource\": \"arn:aws:secretsmanager:us-west-2:${ACCOUNT_ID}:secret:osmo-db-secret-*\"
      }
    ]
  }"
```

### 3.4 Kubernetes ServiceAccount 생성

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: osmo-workload
  namespace: osmo
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::${ACCOUNT_ID}:role/osmo-workload-role
EOF
```

---

## Step 4. 인프라 검증

### 4.1 S3 연결 테스트

```bash
kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: test-s3
  namespace: osmo
spec:
  template:
    spec:
      serviceAccountName: osmo-workload
      nodeSelector:
        node-role: system
      containers:
      - name: s3-test
        image: amazon/aws-cli:latest
        command:
        - /bin/sh
        - -c
        - |
          echo "hello-osmo" > /tmp/test.txt
          aws s3 cp /tmp/test.txt s3://${BUCKET}/test/hello.txt
          aws s3 ls s3://${BUCKET}/test/
          echo "S3 TEST PASSED!"
      restartPolicy: Never
  backoffLimit: 1
EOF

# 결과 확인 (30초 후)
kubectl logs -n osmo -l job-name=test-s3
```

예상 출력:
```
2026-05-03 10:25:47         12 hello.txt
S3 TEST PASSED!
```

### 4.2 Cluster Autoscaler 동작 확인

```bash
# CA 로그에서 ASG 발견 확인
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-cluster-autoscaler | grep "Refreshed ASG list"
```

예상 출력:
```
Refreshed ASG list, next refresh after ...
```

3개 ASG (system, gpu-sim, gpu-train)가 발견되면 정상입니다.

### 4.3 GPU 노드 Scale-up 테스트

```bash
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: test-gpu
  namespace: osmo
spec:
  template:
    spec:
      serviceAccountName: osmo-workload
      nodeSelector:
        node-role: gpu-sim
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      containers:
      - name: gpu-test
        image: nvidia/cuda:12.4.0-base-ubuntu22.04
        command: ["nvidia-smi"]
        resources:
          limits:
            nvidia.com/gpu: 1
      restartPolicy: Never
  backoffLimit: 1
EOF

# Pending 상태 확인 (CA가 scale-up 트리거)
kubectl get pods -n osmo -l job-name=test-gpu
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-cluster-autoscaler | grep "scale-up"
```

CA 로그에서 `Scale-up: setting group eks-gpu-sim-... size to 1` 메시지가 보이면 Autoscaler 정상입니다.

> **참고:** GPU 인스턴스 용량(capacity)이 부족한 경우 ASG에서 `InsufficientInstanceCapacity` 에러가 발생할 수 있습니다. 이는 AWS 리전의 재고 문제로, 인프라 설정의 문제가 아닙니다.

### 4.4 테스트 정리

```bash
kubectl delete job test-s3 test-gpu -n osmo
```

---

## Step 5. OSMO Workflow 실행

### 5.1 데이터셋 준비

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name Osmo \
  --query 'Stacks[0].Outputs[?OutputKey==`S3BucketName`].OutputValue' --output text)

# 예시: LeRobot ALOHA 형식 데이터셋 업로드
aws s3 sync ./my-aloha-dataset s3://$BUCKET/datasets/groot/aloha/
```

### 5.2 GR00T Fine-tuning + Isaac Sim 검증 파이프라인

```bash
osmo workflow submit workflows/groot-train-sim.yaml \
  --set OSMO_DATA_BUCKET=$BUCKET
```

이 워크플로는 2-stage 파이프라인입니다:

| Stage | 내용 | 리소스 |
|-------|------|--------|
| `finetune` | GR00T-N1 모델을 커스텀 데이터셋으로 학습 | gpu-train (4xL40S) |
| `verify-in-sim` | 학습된 policy를 Isaac Sim에서 자동 검증 | gpu-sim (1xL4) |

### 5.3 대규모 Synthetic Data 생성

```bash
osmo workflow submit workflows/sim-datagen.yaml \
  --set OSMO_DATA_BUCKET=$BUCKET
```

8개 Pod가 병렬로 실행되어 총 32 GPU로 synthetic 데이터를 생성합니다.

### 5.4 모니터링

```bash
# 워크플로 상태 확인
osmo workflow query <workflow-id>

# 특정 task 로그 확인
osmo workflow logs <workflow-id> --task finetune

# 실행 중인 Pod 확인
kubectl get pods -n osmo -w
```

### 5.5 결과 확인

```bash
# 체크포인트 확인
aws s3 ls s3://$BUCKET/checkpoints/groot-aloha/

# Synthetic 데이터 확인
aws s3 ls s3://$BUCKET/datasets/synthetic/lift-franka/
```

---

## Step 6. 정리 (Cleanup)

### 6.1 Kubernetes 리소스 정리

```bash
# Helm 릴리스 삭제
helm uninstall cluster-autoscaler -n kube-system

# 네임스페이스 삭제
kubectl delete namespace osmo
```

### 6.2 IAM 리소스 정리

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Inline policy 삭제
aws iam delete-role-policy --role-name osmo-workload-role --policy-name osmo-s3-access
aws iam delete-role-policy --role-name osmo-cluster-autoscaler-role --policy-name cluster-autoscaler-policy

# Role 삭제
aws iam delete-role --role-name osmo-workload-role
aws iam delete-role --role-name osmo-cluster-autoscaler-role

# OIDC Provider 삭제
OIDC_ARN=$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[*].Arn' --output text | grep osmo-eks || true)
if [ -n "$OIDC_ARN" ]; then
  aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN"
fi
```

### 6.3 CDK 스택 삭제

```bash
cd osmo/cdk
cdk destroy
```

### 6.4 S3 데이터 삭제 (선택)

```bash
# 버킷 비우기 (주의: 모든 데이터 삭제)
aws s3 rm s3://$BUCKET --recursive
```

---

## Troubleshooting

| 증상 | 원인 | 해결 |
|------|------|------|
| `InsufficientInstanceCapacity` | GPU 인스턴스 리전 재고 부족 | 다른 AZ 또는 인스턴스 타입 시도 |
| `Unable to locate credentials` (Pod 내) | IRSA 미설정 | ServiceAccount에 `eks.amazonaws.com/role-arn` annotation 확인 |
| CA가 ASG를 찾지 못함 | IRSA 권한 부족 | CA ServiceAccount에 IAM role 연결 확인 |
| CA leader lease 획득 실패 | 이전 Pod의 stale lease | `kubectl delete lease cluster-autoscaler -n kube-system` |
| RDS 연결 실패 | Security Group | EKS cluster SG에서 5432 포트 허용 확인 |
| CDK deploy 시 Secret 충돌 | 이전 스택의 잔여 리소스 | `aws secretsmanager delete-secret --secret-id osmo-db-secret --force-delete-without-recovery` |

---

## 아키텍처 요약

```
                    ┌─────────────────────────────────────────┐
                    │               VPC (10.0.0.0/16)          │
                    │                                         │
                    │  ┌─ Public Subnets ──────────────────┐  │
                    │  │  NAT Gateway    Internet Gateway   │  │
                    │  └───────────────────────────────────┘  │
                    │                                         │
                    │  ┌─ Private Subnets ─────────────────┐  │
                    │  │                                   │  │
                    │  │  ┌─ EKS Cluster (osmo-eks) ────┐  │  │
                    │  │  │  System (m5.xlarge x2)      │  │  │
                    │  │  │  GPU-Sim (g5.12xlarge 0~8)  │  │  │
                    │  │  │  GPU-Train (g6e.12xlarge 0~4)│  │  │
                    │  │  └─────────────────────────────┘  │  │
                    │  │                                   │  │
                    │  │  RDS PostgreSQL    ElastiCache     │  │
                    │  └───────────────────────────────────┘  │
                    └─────────────────────────────────────────┘
                                        │
                                   S3 Bucket
                            (datasets / checkpoints)
```

배포되는 리소스 (44개):
- VPC, 2x Public Subnet, 2x Private Subnet, NAT Gateway, Internet Gateway
- EKS Cluster, 3x Node Group (system, gpu-sim, gpu-train)
- EKS Addons (EBS CSI, Secrets Store CSI)
- RDS PostgreSQL (db.t3.medium)
- ElastiCache Redis (cache.t3.medium)
- S3 Bucket (Intelligent Tiering)
- Security Groups, Route Tables, VPC Endpoints (S3, ECR, STS)
