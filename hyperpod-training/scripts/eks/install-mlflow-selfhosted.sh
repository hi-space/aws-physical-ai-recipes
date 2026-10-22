#!/usr/bin/env bash
# =============================================================================
# install-mlflow-selfhosted.sh — 클러스터 안에서 도는 MLflow 추적 서버 + TensorBoard 를
#                                install-dashboard-public.sh 가 만든 ALB/CloudFront 에 붙인다.
#
#   인터넷
#     └─ CloudFront (install-dashboard-public.sh 가 만든 배포 1개)
#          └─ ALB (IngressGroup hyperpod-dashboard, 리스너 규칙 3개)
#               ├─ /mlflow      → MLflow 3.16 (basic auth)
#               │                   ├─ backend store : Postgres 17 (StatefulSet, gp3 EBS 20Gi)
#               │                   └─ artifact store: s3://<데이터 버킷>/mlflow-artifacts
#               ├─ /tensorboard → TensorBoard (FSx /fsx/checkpoints 읽기 전용)
#               └─ /            → Grafana (install-dashboard-public.sh 가 설치)
#
#   SageMaker 관리형 MLflow(`-c enableMlflow=true`) 대신 이걸 쓰는 이유:
#     1. 관리형 서버 UI 는 presigned URL 로만 열린다. URL 유효기간이 짧고 사람마다 다시
#        발급해야 해서 워크샵에서 "이 주소 보세요" 한 줄로 끝나지 않는다.
#     2. 여기는 CloudFront 한 주소 아래 Grafana·MLflow·TensorBoard 가 같이 붙는다.
#     3. basic auth 라 학습 파드가 pod identity 없이도 추적 서버에 쓸 수 있다.
#   단점은 Postgres·아티팩트 수명주기를 직접 챈다는 것, 그리고 상시 비용이다
#   (gp3 20Gi 약 $1.8/월 + 파드가 쓰는 시스템 노드 자원. ALB·WAF 비용은 대시보드 쪽에 이미 포함).
#
# ─── 이 스크립트를 쓰는 전제 ───
#   install-dashboard-public.sh 를 먼저 돌려 ALB·WAF·CloudFront 가 있어야 한다.
#   그쪽 스크립트와 같은 이유(인터넷 공개 + 상시 비용)로 서울 리전 전용 보조 경로다.
#   관리형 MLflow 를 쓸 수 있는 리전이면 `-c enableMlflow=true` 쪽이 운영 부담이 적다.
#
# 사용법:
#   ./scripts/eks/install-mlflow-selfhosted.sh [--cluster <eks-cluster-name>] [--yes]
#
# 사전 조건:
#   - install-dashboard-public.sh 완료 (ALB IngressGroup hyperpod-dashboard + CloudFront)
#   - kubectl 이 해당 클러스터를 가리킴 (./scripts/eks/kubeconfig.sh)
#   - FSx for Lustre 파일시스템 (HyperPodEks 스택 Output) — TensorBoard 가 체크포인트를 읽는다
#   - kubectl / helm / jq / aws / openssl, 그리고 IAM·EKS 애드온 생성 권한
#
# 설치 후 학습 Job 연결:
#   k8s-templates/render.sh 가 `svc/mlflow -n mlflow` 존재를 보고 MLFLOW_TRACKING_URI 를
#   http://mlflow.mlflow.svc.cluster.local/mlflow 로 채우고, mlflow-credentials Secret 을
#   Job 네임스페이스로 복사한다. 추가 설정은 없다.
#
# 제거: ./scripts/eks/delete-mlflow-selfhosted.sh
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
NAMESPACE="mlflow"
MLFLOW_CHART_VERSION="1.11.7"          # community-charts/mlflow — appVersion 3.16.0
EBS_CSI_ADDON_VERSION="v1.67.0-eksbuild.1"
POSTGRES_IMAGE="public.ecr.aws/docker/library/postgres:17.9-alpine3.23"
TENSORBOARD_IMAGE="public.ecr.aws/docker/library/python:3.12-slim"
TENSORBOARD_VERSION="2.21.0"
SYSTEM_INSTANCE_TYPE="ml.c5.4xlarge"
CF_PREFIX_LIST="pl-22a6434b"           # com.amazonaws.global.cloudfront.origin-facing (ap-northeast-2)
# 학습 Job 이 쓰는 실험 이름. Job 템플릿의 MLFLOW_EXPERIMENT_NAME 과
# examples/{rl/mlflow_isaaclab.py,vla/eval_closed_loop.py,vla/register_groot_model.py}
# 의 기본값을 합친 집합이며, 아래 [4/6] 에서 미리 만들어 trainer 에게 쓰기를 준다.
MLFLOW_EXPERIMENTS="isaaclab-rl vla-finetune vla-eval"
INGRESS_GROUP="hyperpod-dashboard"     # install-dashboard-public.sh 가 만든 그룹에 합류한다
# rl 과 vla 를 모두 담는 공통 상위 디렉터리다. isaaclab-train-job 의 --log_dir
# (/fsx/checkpoints/rl) 만 가리키면 GR00T 파인튜닝 산출물
# (/fsx/checkpoints/vla/groot-*) 이 범위 밖이라 TensorBoard 에 나타나지 않는다.
TRAINING_LOG_DIR="/fsx/checkpoints"

CLUSTER_NAME=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

for tool in kubectl helm jq aws openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"

aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 || {
  echo "EKS 클러스터 '${CLUSTER_NAME}' 을 ${REGION} 에서 찾지 못했습니다." >&2
  exit 1
}

# ALB 가 이미 있어야 한다. serverAllowedHosts 에 ALB·CloudFront 도메인을 넣어야 하는데
# MLflow 3.x 는 Host 헤더가 목록에 없으면 400 을 돌려준다.
ALB_DNS="$(kubectl get ingress -A \
  -o jsonpath="{range .items[?(@.metadata.annotations['alb\.ingress\.kubernetes\.io/group\.name']=='${INGRESS_GROUP}')]}{.status.loadBalancer.ingress[0].hostname}{'\n'}{end}" \
  2>/dev/null | grep -m1 . || true)"
[[ -n "$ALB_DNS" ]] || {
  echo "IngressGroup '${INGRESS_GROUP}' 의 ALB 를 찾지 못했습니다." >&2
  echo "먼저 ./scripts/eks/install-dashboard-public.sh 를 실행하세요." >&2
  exit 1
}
CF_DOMAIN="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CLUSTER_NAME}-dashboard'].DomainName | [0]" \
  --output text 2>/dev/null || true)"
[[ -n "$CF_DOMAIN" && "$CF_DOMAIN" != "None" ]] || {
  echo "CloudFront 배포(Comment=${CLUSTER_NAME}-dashboard)를 찾지 못했습니다." >&2
  echo "먼저 ./scripts/eks/install-dashboard-public.sh 를 실행하세요." >&2
  exit 1
}

# 아티팩트 버킷과 FSx 는 HyperPodEks 스택 Output 에서 읽는다.
OUT="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='S3BucketName' || OutputKey=='FsxFileSystemId' || OutputKey=='FsxDnsName' || OutputKey=='FsxMountName'].[OutputKey,OutputValue]" \
  --output text 2>/dev/null || true)"
S3_BUCKET="${S3_BUCKET:-$(awk '$1=="S3BucketName"{print $2}' <<<"$OUT")}"
FSX_ID="${FSX_ID:-$(awk '$1=="FsxFileSystemId"{print $2}' <<<"$OUT")}"
FSX_DNS="${FSX_DNS:-$(awk '$1=="FsxDnsName"{print $2}' <<<"$OUT")}"
FSX_MOUNT="${FSX_MOUNT:-$(awk '$1=="FsxMountName"{print $2}' <<<"$OUT")}"
FSX_GIB="${FSX_GIB:-1200}"
[[ -n "$S3_BUCKET" ]] || { echo "스택 ${STACK} 의 S3BucketName Output 을 읽지 못했습니다." >&2; exit 1; }
[[ -n "$FSX_ID" && -n "$FSX_DNS" && -n "$FSX_MOUNT" ]] || {
  echo "스택 ${STACK} 의 FSx Output 을 읽지 못했습니다. FSX_ID/FSX_DNS/FSX_MOUNT 로 직접 넘기세요." >&2
  exit 1
}

# EBS CSI 드라이버가 HyperPod 노드에 볼륨을 붙이려면 HyperPod 클러스터 ARN 이 필요하다.
# 이 EKS 클러스터를 orchestrator 로 쓰는 HyperPod 클러스터를 찾는다.
HP_CLUSTER_ARN=""
for arn in $(aws sagemaker list-clusters --region "$REGION" \
             --query 'ClusterSummaries[].ClusterArn' --output text 2>/dev/null | tr '\t' '\n'); do
  [[ -z "$arn" ]] && continue
  eks_arn="$(aws sagemaker describe-cluster --cluster-name "$arn" --region "$REGION" \
    --query 'Orchestrator.Eks.ClusterArn' --output text 2>/dev/null || true)"
  if [[ "$eks_arn" == *":cluster/${CLUSTER_NAME}" ]]; then HP_CLUSTER_ARN="$arn"; break; fi
done
[[ -n "$HP_CLUSTER_ARN" ]] || {
  echo "EKS ${CLUSTER_NAME} 을 쓰는 HyperPod 클러스터를 찾지 못했습니다." >&2
  exit 1
}

EBS_ROLE="${CLUSTER_NAME}-ebs-csi"
MLFLOW_ROLE="${CLUSTER_NAME}-mlflow"

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION})
붙는 곳    : https://${CF_DOMAIN}/mlflow , https://${CF_DOMAIN}/tensorboard
생성 대상  : aws-ebs-csi-driver 애드온 + IAM 역할 ${EBS_ROLE}
             gp3 StorageClass
             Postgres 17 StatefulSet (gp3 20Gi) — namespace ${NAMESPACE}
             MLflow 차트 ${MLFLOW_CHART_VERSION} (basic auth, 아티팩트 s3://${S3_BUCKET}/mlflow-artifacts)
             IAM 역할 ${MLFLOW_ROLE} + pod identity (${NAMESPACE}/mlflow)
             TensorBoard (FSx ${FSX_ID} 읽기 전용, logdir ${TRAINING_LOG_DIR})
             Ingress 2개 (IngressGroup ${INGRESS_GROUP} 에 합류)
상시 비용  : gp3 20Gi 약 \$1.8/월 (ALB·WAF 는 install-dashboard-public.sh 쪽에 이미 포함)
기존 리소스는 변경하지 않습니다.

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

POD_TRUST='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "pods.eks.amazonaws.com" },
    "Action": ["sts:AssumeRole", "sts:TagSession"]
  }]
}'

# -----------------------------------------------------------------------------
# 1. EBS CSI 드라이버
#    HyperPod EKS 클러스터에는 기본으로 없다. Postgres 가 PVC 를 쓰려면 필요하다.
#    HyperPod 노드는 일반 EC2 가 아니라 SageMaker 가 관리하므로, 표준
#    AmazonEBSCSIDriverPolicy 만으로는 볼륨을 붙이지 못한다.
#    sagemaker:AttachClusterNodeVolume / DetachClusterNodeVolume 을 따로 줘야 한다.
# -----------------------------------------------------------------------------
echo "[1/6] EBS CSI 드라이버"
if ! aws iam get-role --role-name "$EBS_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$EBS_ROLE" \
    --assume-role-policy-document "$POD_TRUST" >/dev/null
  echo "  IAM 역할 생성: ${EBS_ROLE}"
fi
aws iam attach-role-policy --role-name "$EBS_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy
aws iam put-role-policy --role-name "$EBS_ROLE" --policy-name hyperpod-node-volume \
  --policy-document "$(jq -nc --arg hp "$HP_CLUSTER_ARN" \
      --arg eks "arn:aws:eks:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}" '{
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow",
        Action: ["sagemaker:AttachClusterNodeVolume", "sagemaker:DetachClusterNodeVolume"],
        Resource: $hp },
      { Effect: "Allow", Action: "eks:DescribeCluster", Resource: $eks }
    ]
  }')"

if ! aws eks describe-addon --cluster-name "$CLUSTER_NAME" --region "$REGION" \
     --addon-name aws-ebs-csi-driver >/dev/null 2>&1; then
  aws eks create-addon --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --addon-name aws-ebs-csi-driver \
    --addon-version "$EBS_CSI_ADDON_VERSION" \
    --pod-identity-associations "serviceAccount=ebs-csi-controller-sa,roleArn=arn:aws:iam::${ACCOUNT_ID}:role/${EBS_ROLE}" \
    >/dev/null
  echo "  애드온 생성 대기"
  aws eks wait addon-active --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --addon-name aws-ebs-csi-driver
fi

# reclaimPolicy=Retain: 실수로 PVC 를 지워도 실험 기록이 담긴 EBS 는 남는다.
kubectl apply -f - >/dev/null <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
EOF
echo "  gp3 StorageClass 적용"

# -----------------------------------------------------------------------------
# 2. 자격증명
#    admin  : MLflow UI 로그인 (사람)
#    trainer: 학습 파드가 쓰는 비관리자 계정. render.sh 가 이 Secret 을 Job
#             네임스페이스로 복사해 MLFLOW_TRACKING_USERNAME/_PASSWORD 로 넣는다.
#    기존 Secret 이 있으면 그대로 둔다 — 비밀번호를 새로 만들면 Postgres 안의
#    auth DB 와 틀어지고, Postgres 쪽은 initdb 때 정한 값을 바꾸지 않는다.
# -----------------------------------------------------------------------------
echo "[2/6] 자격증명 Secret"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
for spec in "mlflow-postgres:mlflow" "mlflow-admin:admin" "mlflow-credentials:trainer"; do
  name="${spec%%:*}"; user="${spec##*:}"
  if ! kubectl get secret "$name" -n "$NAMESPACE" >/dev/null 2>&1; then
    kubectl create secret generic "$name" -n "$NAMESPACE" \
      --from-literal=username="$user" \
      --from-literal=password="$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)" >/dev/null
    echo "  생성: ${name} (${user})"
  else
    echo "  기존 사용: ${name}"
  fi
done

# -----------------------------------------------------------------------------
# 3. Postgres backend store
#    MLflow 의 기본 SQLite 는 동시 쓰기에서 database-is-locked 로 깨진다. 학습 Job 여러
#    개가 같은 서버에 metric 을 배치로 밀어넣으므로 Postgres 가 필요하다.
#    헤드리스 Service + StatefulSet 이라 파드가 재생성돼도 같은 PVC 를 다시 쓴다.
# -----------------------------------------------------------------------------
echo "[3/6] Postgres"
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Service
metadata:
  name: mlflow-postgres
  namespace: ${NAMESPACE}
spec:
  clusterIP: None
  selector:
    app: mlflow-postgres
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mlflow-postgres
  namespace: ${NAMESPACE}
spec:
  serviceName: mlflow-postgres
  replicas: 1
  selector:
    matchLabels:
      app: mlflow-postgres
  template:
    metadata:
      labels:
        app: mlflow-postgres
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: ${SYSTEM_INSTANCE_TYPE}
      securityContext:
        fsGroup: 999
      containers:
        - name: postgres
          image: ${POSTGRES_IMAGE}
          ports:
            - name: postgres
              containerPort: 5432
          env:
            - name: POSTGRES_DB
              value: mlflow
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: mlflow-postgres
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mlflow-postgres
                  key: password
            # 마운트 루트가 비어 있지 않아서(lost+found) initdb 가 하위 디렉터리를 요구한다.
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "mlflow", "-d", "mlflow"]
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            exec:
              command: ["pg_isready", "-U", "mlflow", "-d", "mlflow"]
            initialDelaySeconds: 30
            periodSeconds: 30
          resources:
            requests:
              cpu: 200m
              memory: 512Mi
            limits:
              memory: 2Gi
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 20Gi
EOF
kubectl rollout status statefulset/mlflow-postgres -n "$NAMESPACE" --timeout 10m

# -----------------------------------------------------------------------------
# 4. MLflow
#    - staticPrefix=/mlflow : ALB 가 경로로 라우팅하므로 앱도 같은 prefix 를 알아야
#      정적 리소스 URL 이 맞는다. 헬스체크 경로도 /mlflow/health 로 옮겨간다.
#    - serverAllowedHosts  : MLflow 3.x 는 Host 헤더가 목록에 없으면 400 을 낸다.
#      CloudFront 도메인, ALB 도메인, 클러스터 내부 Service 이름(포트 유무 모두),
#      그리고 ALB 헬스체크가 Host 로 쓰는 파드 IP 대역을 전부 넣어야 한다.
#    - artifactRoot.s3     : pod identity 로 받은 자격증명으로 쓴다. 파드가 IMDS 를
#      못 쓰므로 아래 IAM 역할이 유일한 경로다.
# -----------------------------------------------------------------------------
echo "[4/6] MLflow"
if ! aws iam get-role --role-name "$MLFLOW_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$MLFLOW_ROLE" \
    --assume-role-policy-document "$POD_TRUST" >/dev/null
  echo "  IAM 역할 생성: ${MLFLOW_ROLE}"
fi
# 두 번째 statement 가 체크포인트를 읽기 전용으로 추가한다. Model Registry 에
# 등록된 model version 의 source 는 s3://<버킷>/checkpoints/... 이고, UI 의
# /model-versions/get-artifact 는 그 경로를 서버 자격증명으로 직접 읽는다. 이
# 권한이 없으면 목록은 떠도(ListBucket 은 버킷 단위라 이미 허용) 파일을 누르는
# 순간 S3 403 이 INTERNAL_ERROR 로 올라온다.
# GetObject 만 준다 — 쓰기를 주면 추적 서버가 학습 산출물을 지울 수 있게 된다.
aws iam put-role-policy --role-name "$MLFLOW_ROLE" --policy-name s3-artifacts \
  --policy-document "$(jq -nc --arg b "$S3_BUCKET" '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket","s3:GetBucketLocation"],
      Resource: ["arn:aws:s3:::\($b)", "arn:aws:s3:::\($b)/mlflow-artifacts/*"]
    },{
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: ["arn:aws:s3:::\($b)/checkpoints/*"]
    }]
  }')"
if ! aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
     --namespace "$NAMESPACE" --service-account mlflow \
     --query 'associations[0].associationId' --output text 2>/dev/null | grep -qv '^None$'; then
  aws eks create-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --namespace "$NAMESPACE" --service-account mlflow \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${MLFLOW_ROLE}" >/dev/null
  echo "  pod identity 연결: ${NAMESPACE}/mlflow"
fi

# 파드 CIDR 와일드카드. ALB 는 target-type=ip 라 헬스체크의 Host 가 파드 IP 다.
POD_CIDR_PREFIX="$(kubectl get pods -n "$NAMESPACE" -l app=mlflow-postgres \
  -o jsonpath='{.items[0].status.podIP}' 2>/dev/null | cut -d. -f1-2 || true)"
[[ -n "$POD_CIDR_PREFIX" ]] || { echo "Postgres 파드 IP 를 읽지 못했습니다." >&2; exit 1; }

helm repo add community-charts https://community-charts.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

MLFLOW_VALUES="$(mktemp)"
trap 'rm -f "$MLFLOW_VALUES"' EXIT
cat > "$MLFLOW_VALUES" <<EOF
serviceAccount:
  create: true
  name: mlflow
nodeSelector:
  node.kubernetes.io/instance-type: ${SYSTEM_INSTANCE_TYPE}
extraArgs:
  staticPrefix: /mlflow
serverAllowedHosts:
  - ${CF_DOMAIN}
  - ${ALB_DNS}
  - mlflow.${NAMESPACE}.svc.cluster.local
  - mlflow.${NAMESPACE}.svc.cluster.local:80
  - mlflow.${NAMESPACE}.svc
  - mlflow.${NAMESPACE}.svc:80
  - mlflow
  - mlflow:80
  - localhost
  - localhost:5000
  - ${POD_CIDR_PREFIX}.*
corsAllowedOrigins:
  - https://${CF_DOMAIN}
livenessProbe:
  httpGet:
    path: /mlflow/health
    port: mlflow
readinessProbe:
  httpGet:
    path: /mlflow/health
    port: mlflow
backendStore:
  databaseMigration: true
  databaseConnectionCheck: true
  existingDatabaseSecret:
    name: mlflow-postgres
  postgres:
    enabled: true
    host: mlflow-postgres.${NAMESPACE}.svc.cluster.local
    port: 5432
    database: mlflow
    driver: psycopg2
artifactRoot:
  # proxiedArtifactStorage 를 켜면 아티팩트 URI 가 mlflow-artifacts:/ 가 되어 클라이언트는
  # 서버로 업로드하고 서버가 pod identity 자격증명으로 S3 에 쓴다. 끄면 클라이언트가 S3 에
  # 직접 써야 하는데 학습 파드에는 S3 자격증명이 없어 log_artifacts() 가 NoCredentialsError
  # 로 죽는다 (mlflow_isaaclab.py 의 finalize() 가 체크포인트를 올리는 지점).
  proxiedArtifactStorage: true
  s3:
    enabled: true
    bucket: ${S3_BUCKET}
    path: mlflow-artifacts
auth:
  enabled: true
  existingAdminSecret:
    name: mlflow-admin
  postgres:
    enabled: true
    host: mlflow-postgres.${NAMESPACE}.svc.cluster.local
    port: 5432
    database: mlflow
    driver: psycopg2
    existingSecret:
      name: mlflow-postgres
EOF

helm upgrade --install mlflow community-charts/mlflow \
  --version "$MLFLOW_CHART_VERSION" \
  --namespace "$NAMESPACE" \
  -f "$MLFLOW_VALUES" \
  --wait --timeout 10m

# 학습 파드용 비관리자 계정. 차트는 admin 만 만들므로 auth REST API 로 추가한다.
ADMIN_USER="$(kubectl get secret mlflow-admin -n "$NAMESPACE" -o jsonpath='{.data.username}' | base64 -d)"
ADMIN_PASS="$(kubectl get secret mlflow-admin -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)"
TRAINER_USER="$(kubectl get secret mlflow-credentials -n "$NAMESPACE" -o jsonpath='{.data.username}' | base64 -d)"
TRAINER_PASS="$(kubectl get secret mlflow-credentials -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)"
kubectl exec -n "$NAMESPACE" deploy/mlflow -- env \
  AU="$ADMIN_USER" AP="$ADMIN_PASS" TU="$TRAINER_USER" TP="$TRAINER_PASS" \
  EXPERIMENTS="$MLFLOW_EXPERIMENTS" python - <<'PY'
import base64, json, os, urllib.error, urllib.request

host = "http://localhost:5000/mlflow"
auth = base64.b64encode(f"{os.environ['AU']}:{os.environ['AP']}".encode()).decode()
trainer = os.environ["TU"]


def call(path, body=None, method="GET"):
    req = urllib.request.Request(
        host + path, data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json", "Authorization": "Basic " + auth},
        method=method)
    try:
        return 200, json.loads(urllib.request.urlopen(req, timeout=30).read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200].decode(errors="replace")


users = "/api/2.0/mlflow/users"
code, _ = call(users + "/create", {"username": trainer, "password": os.environ["TP"]}, "POST")
if code == 200:
    print(f"  {trainer} 계정 생성")
else:
    # 이미 있으면 비밀번호를 Secret 값으로 되돌린다.
    call(users + "/update-password", {"username": trainer, "password": os.environ["TP"]}, "POST")
    print(f"  {trainer} 계정 기존 사용 (비밀번호 동기화)")

# basic_auth.ini 의 default_permission 은 READ 다. 실험을 만든 사용자만 그 실험에
# MANAGE 를 자동으로 받으므로, admin 이 UI 에서 먼저 만든 실험에는 trainer 가 run 을
# 못 만들고 runs/create 가 403 Permission denied 로 떨어진다. 학습 Job 은 그 403 을
# 경고로 삼키고 추적 없이 계속 돌기 때문에, Argo 에서는 성공인데 MLflow 에만 run 이
# 없는 상태가 된다. 실험을 여기서 미리 만들고 trainer 에게 EDIT 를 명시적으로 주어
# 누가 먼저 만들었는지에 결과가 달라지지 않게 한다.
#
# EDIT 는 run 생성/기록까지다 — 실험 삭제와 권한 변경은 admin 에게 남겨둔다.
# 권한 API 는 3.x 에서 role 기반으로 바뀌었다: /api/3.0/mlflow/users/permissions/grant
# 가 resource_type + resource_id 를 받고, 2.x 의 experiments/permissions/* 는 없다.
perms = "/api/3.0/mlflow/users/permissions"


def ensure_edit(exp_id: str) -> str:
    """trainer 가 이 실험에 쓰기 권한을 갖도록 맞춘다.

    grant 는 이미 권한이 있으면 RESOURCE_ALREADY_EXISTS 로 거절하고 갱신용
    엔드포인트는 없다. 그래서 먼저 현재 권한을 읽고, 쓰기에 못 미칠 때만
    revoke 후 다시 grant 한다. 재실행이 기존 MANAGE 를 EDIT 로 깎지 않는다.
    """
    code, body = call(f"{perms}/get?username={trainer}"
                      f"&resource_type=experiment&resource_id={exp_id}")
    current = body.get("permission") if code == 200 else None
    if current in ("EDIT", "MANAGE"):
        return current
    if current:
        call(f"{perms}/revoke", {"username": trainer, "resource_type": "experiment",
                                 "resource_id": exp_id}, "POST")
    code, body = call(f"{perms}/grant", {"username": trainer, "resource_type": "experiment",
                                         "resource_id": exp_id, "permission": "EDIT"}, "POST")
    return "EDIT" if code == 200 else f"실패 {code} {body}"


for name in os.environ["EXPERIMENTS"].split():
    code, body = call("/api/2.0/mlflow/experiments/create", {"name": name}, "POST")
    if code == 200:
        exp_id = body["experiment_id"]
    else:
        code, body = call(f"/api/2.0/mlflow/experiments/get-by-name?experiment_name={name}")
        if code != 200:
            print(f"  [WARN] 실험 {name} 확인 실패: {body}")
            continue
        exp_id = body["experiment"]["experiment_id"]
    print(f"  실험 {name} (id {exp_id}): {trainer} {ensure_edit(str(exp_id))}")
PY

# -----------------------------------------------------------------------------
# 5. TensorBoard
#    MLflow 는 metric 을 숫자로 모아 비교하는 쪽이고, TensorBoard 는 rsl_rl 이 직접
#    쓰는 event 파일을 그대로 본다. 학습 중 커브를 바로 보려면 이쪽이 빠르다.
#    logdir 이 아직 없어도 뜬다 — 나중에 생기면 reload_interval 주기에 집어간다.
#    FSx 는 읽기 전용으로만 마운트해 체크포인트를 건드릴 수 없게 한다.
#    정적 FSx PV 는 PVC 하나에만 바인딩되므로 이 네임스페이스용 한 쌍을 따로 만든다.
# -----------------------------------------------------------------------------
echo "[5/6] TensorBoard"
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolume
metadata:
  name: fsx-pv-${NAMESPACE}
spec:
  capacity:
    storage: ${FSX_GIB}Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: fsx-sc
  mountOptions:
    - flock
  csi:
    driver: fsx.csi.aws.com
    volumeHandle: ${FSX_ID}
    volumeAttributes:
      dnsname: ${FSX_DNS}
      mountname: ${FSX_MOUNT}
  claimRef:
    namespace: ${NAMESPACE}
    name: fsx-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fsx-pvc
  namespace: ${NAMESPACE}
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: fsx-sc
  volumeName: fsx-pv-${NAMESPACE}
  resources:
    requests:
      storage: ${FSX_GIB}Gi
---
apiVersion: v1
kind: Service
metadata:
  name: tensorboard
  namespace: ${NAMESPACE}
spec:
  type: ClusterIP
  selector:
    app: tensorboard
  ports:
    - name: http
      port: 80
      targetPort: 6006
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tensorboard
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tensorboard
  template:
    metadata:
      labels:
        app: tensorboard
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: ${SYSTEM_INSTANCE_TYPE}
      containers:
        - name: tensorboard
          image: ${TENSORBOARD_IMAGE}
          command: ["bash", "-ceu"]
          args:
            - |
              pip install --no-cache-dir --quiet 'tensorboard==${TENSORBOARD_VERSION}'
              exec tensorboard \\
                --logdir ${TRAINING_LOG_DIR} \\
                --bind_all \\
                --port 6006 \\
                --path_prefix /tensorboard \\
                --reload_multifile true \\
                --reload_interval 30
          env:
            # pip 와 TensorBoard 가 쓰기 가능한 홈이 필요하다. 이미지의 /root 는 읽기 전용이 아니지만
            # 파드가 재시작하면 날아가므로 emptyDir 쪽으로 몰아둔다.
            - name: HOME
              value: /tmp
          ports:
            - name: http
              containerPort: 6006
          readinessProbe:
            httpGet:
              path: /tensorboard/
              port: http
            # 매 기동마다 pip install 이 돈다(약 20초). 넉넉히 기다린다.
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: /tensorboard/
              port: http
            initialDelaySeconds: 180
            periodSeconds: 30
            failureThreshold: 5
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              memory: 4Gi
          volumeMounts:
            - name: fsx
              mountPath: /fsx
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: fsx
          persistentVolumeClaim:
            claimName: fsx-pvc
            readOnly: true
        - name: tmp
          emptyDir: {}
EOF
kubectl rollout status deployment/tensorboard -n "$NAMESPACE" --timeout 10m

# -----------------------------------------------------------------------------
# 6. Ingress
#    group.name 으로 Grafana 와 같은 ALB 를 공유한다. group.order 는 리스너 규칙
#    우선순위다. Grafana 가 100 에서 '/' 전체를 받으므로 더 구체적인 경로는 반드시
#    더 낮은 숫자여야 한다.
#    security-group-prefix-lists 는 그룹 내 모든 Ingress 에 같은 값으로 있어야 한다.
#    하나라도 빠지면 컨트롤러가 ALB 보안그룹에 0.0.0.0/0 inbound 를 넣는다.
#
#    tags 도 마찬가지로 그룹 멤버 전원이 같아야 한다. 값이 엇갈리면 컨트롤러가
#    'conflicting tag' 로 그룹 전체의 조정을 멈춘다.
# -----------------------------------------------------------------------------
echo "[6/6] Ingress"
for entry in "mlflow:10:/mlflow:/mlflow/health" "tensorboard:20:/tensorboard:/tensorboard/"; do
  IFS=: read -r name order path health <<<"$entry"
  kubectl apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
  annotations:
    alb.ingress.kubernetes.io/group.name: ${INGRESS_GROUP}
    alb.ingress.kubernetes.io/group.order: "${order}"
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'
    alb.ingress.kubernetes.io/security-group-prefix-lists: ${CF_PREFIX_LIST}
    alb.ingress.kubernetes.io/healthcheck-path: ${health}
    alb.ingress.kubernetes.io/tags: ManagedBy=${INGRESS_GROUP}
spec:
  ingressClassName: alb
  rules:
    - http:
        paths:
          - path: ${path}
            pathType: Prefix
            backend:
              service:
                name: ${name}
                port:
                  number: 80
EOF
  echo "  ${path} → ${name} (order ${order})"
done

cat <<EOF

완료.

  MLflow      : https://${CF_DOMAIN}/mlflow
                user ${ADMIN_USER} / pass:
                  kubectl get secret -n ${NAMESPACE} mlflow-admin -o jsonpath='{.data.password}' | base64 -d
  TensorBoard : https://${CF_DOMAIN}/tensorboard/
  Grafana     : https://${CF_DOMAIN}/

학습 Job 은 추가 설정 없이 붙는다. k8s-templates/render.sh 가 svc/mlflow 를 보고
MLFLOW_TRACKING_URI 를 채우고 mlflow-credentials Secret 을 Job 네임스페이스로 복사한다:

  cd hyperpod-training/k8s-templates
  MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply

TensorBoard 는 ${TRAINING_LOG_DIR} 이 생기면 30초 안에 run 을 집어간다. 학습 전에는 비어 있다.
새 ALB 리스너 규칙은 바로 뜨고, CloudFront 는 이 경로들을 캐싱하지 않으므로 전파 대기는 없다.

제거: ./scripts/eks/delete-mlflow-selfhosted.sh
EOF
