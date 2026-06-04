#!/bin/bash
# =============================================================================
# setup-greengrass-workshop-N16.sh
# GR00T N1.6 Pick-Orange 워크숍 — Greengrass 설치 + 컴포넌트 등록
#
# N1.7과 동일 구조, 차이점:
#   - 모델: hi-space/GR00T-N1.6-3B-Pick-Orange
#   - Docker: groot-n16-inference-jinseony:latest
#   - TRT: DiT(Action Head)만 가속 (export_onnx_n1d6.py → build_tensorrt_engine.py)
#   - 컴포넌트 버전: 1.6.0
#
# 사용법: sudo bash setup-greengrass-workshop-N16.sh <USER_ID>
#
# ─── ⚠️  사전 요구사항: IAM 권한 ─────────────────────────────────────────────
# 이 스크립트는 Greengrass Nucleus 프로비저닝(Step 4)에서 IoT/IAM 리소스를
# 자동 생성합니다. EC2 인스턴스 Role에 아래 권한이 사전에 추가되어 있어야 합니다.
#
# 인스턴스 Role 확인:
#   curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/
#
# 필요 권한 추가 예시:
#   aws iam put-role-policy \
#     --role-name <INSTANCE_ROLE_NAME> \
#     --policy-name GreengrassProvisionPolicy \
#     --policy-document '{
#       "Version": "2012-10-17",
#       "Statement": [
#         { "Effect": "Allow", "Action": "iot:*", "Resource": "*" },
#         { "Effect": "Allow", "Action": "greengrass:*", "Resource": "*" },
#         {
#           "Effect": "Allow",
#           "Action": [
#             "iam:GetRole", "iam:CreateRole", "iam:AttachRolePolicy",
#             "iam:GetPolicy", "iam:PassRole", "iam:CreatePolicy", "iam:TagRole",
#             "iam:PutRolePolicy"
#           ],
#           "Resource": "*"
#         },
#         { "Effect": "Allow", "Action": "sts:GetCallerIdentity", "Resource": "*" }
#       ]
#     }'
#
# CDK/CloudFormation으로 배포된 인스턴스라면 스택에 위 정책을 포함시키세요.
# =============================================================================
set -euo pipefail

# ─── userId 입력 확인 ─────────────────────────────────────────────────────────
if [ -z "${1:-}" ]; then
  echo "❌ 사용법: sudo bash setup-greengrass-workshop-N16.sh <USER_ID> [--uninstall]"
  echo "   설치: sudo bash setup-greengrass-workshop-N16.sh jinseony"
  echo "   제거: sudo bash setup-greengrass-workshop-N16.sh jinseony --uninstall"
  exit 1
fi
USER_ID="$1"
UNINSTALL="${2:-}"

# ─── 환경 감지 ───────────────────────────────────────────────────────────────
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
ACCOUNT_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document | python3 -c "import sys,json;print(json.load(sys.stdin)['accountId'])")

THING_NAME="groot-${USER_ID}"
THING_GROUP="${THING_NAME}-group"
S3_BUCKET="groot-workshop-${USER_ID}-${ACCOUNT_ID}"
ECR_REPO="groot-n16-inference-${USER_ID}"
ECR_IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest"

# ─── Uninstall 모드 ──────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "--uninstall" ]; then
  echo "============================================"
  echo " 🗑️  N1.6 Greengrass Workshop Uninstall"
  echo "============================================"
  echo " Thing:  $THING_NAME"
  echo " Group:  $THING_GROUP"
  echo " Region: $REGION"
  echo ""

  # 1. Greengrass 서비스 중지 및 제거
  echo ">>> [1/6] Stopping Greengrass service"
  systemctl stop greengrass.service 2>/dev/null || true
  systemctl disable greengrass.service 2>/dev/null || true
  rm -rf /greengrass/v2
  rm -f /etc/systemd/system/greengrass.service
  systemctl daemon-reload 2>/dev/null || true
  echo "   ✅ Greengrass removed"

  # 2. Greengrass 배포 삭제
  echo ">>> [2/6] Cancelling and deleting Greengrass deployments"
  # Thing 대상 배포 삭제
  THING_DEPLOYS=$(aws greengrassv2 list-deployments --target-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:thing/${THING_NAME}" \
    --query 'deployments[].deploymentId' --output text --region "$REGION" 2>/dev/null || echo "")
  for DEPLOY_ID in $THING_DEPLOYS; do
    aws greengrassv2 cancel-deployment --deployment-id "$DEPLOY_ID" --region "$REGION" 2>/dev/null || true
    aws greengrassv2 delete-deployment --deployment-id "$DEPLOY_ID" --region "$REGION" 2>/dev/null || true
    echo "   Deleted thing deployment: $DEPLOY_ID"
  done
  # Thing Group 대상 배포 삭제
  GROUP_DEPLOYS=$(aws greengrassv2 list-deployments --target-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP}" \
    --query 'deployments[].deploymentId' --output text --region "$REGION" 2>/dev/null || echo "")
  for DEPLOY_ID in $GROUP_DEPLOYS; do
    aws greengrassv2 cancel-deployment --deployment-id "$DEPLOY_ID" --region "$REGION" 2>/dev/null || true
    aws greengrassv2 delete-deployment --deployment-id "$DEPLOY_ID" --region "$REGION" 2>/dev/null || true
    echo "   Deleted group deployment: $DEPLOY_ID"
  done
  # Greengrass Core Device 삭제
  aws greengrassv2 delete-core-device --core-device-thing-name "$THING_NAME" --region "$REGION" 2>/dev/null && \
    echo "   Deleted core device: $THING_NAME" || true
  echo "   ✅ Deployments and core device cleaned"

  # 3. IoT Thing 리소스 제거
  echo ">>> [3/6] Removing IoT resources (${THING_NAME})"
  # Certificate 분리 및 삭제
  PRINCIPALS=$(aws iot list-thing-principals --thing-name "$THING_NAME" --region "$REGION" --query 'principals[*]' --output text 2>/dev/null || echo "")
  for CERT_ARN in $PRINCIPALS; do
    CERT_ID=$(echo "$CERT_ARN" | awk -F'/' '{print $NF}')
    # 정책 분리
    POLICIES=$(aws iot list-attached-policies --target "$CERT_ARN" --region "$REGION" --query 'policies[*].policyName' --output text 2>/dev/null || echo "")
    for POLICY in $POLICIES; do
      aws iot detach-policy --policy-name "$POLICY" --target "$CERT_ARN" --region "$REGION" 2>/dev/null || true
    done
    aws iot detach-thing-principal --thing-name "$THING_NAME" --principal "$CERT_ARN" --region "$REGION" 2>/dev/null || true
    aws iot update-certificate --certificate-id "$CERT_ID" --new-status INACTIVE --region "$REGION" 2>/dev/null || true
    aws iot delete-certificate --certificate-id "$CERT_ID" --force-delete --region "$REGION" 2>/dev/null || true
    echo "   Deleted certificate: $CERT_ID"
  done
  aws iot remove-thing-from-thing-group --thing-name "$THING_NAME" --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true
  aws iot delete-thing --thing-name "$THING_NAME" --region "$REGION" 2>/dev/null || true
  aws iot delete-thing-group --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true
  echo "   ✅ IoT Thing/Group removed"

  # 4. Greengrass 컴포넌트 삭제
  echo ">>> [4/6] Deleting Greengrass components (N1.6)"
  for COMP in com.workshop.${USER_ID}.benchmark com.workshop.${USER_ID}.docker-build com.workshop.${USER_ID}.inference com.workshop.${USER_ID}.setup; do
    VERSIONS=$(aws greengrassv2 list-component-versions \
      --arn "arn:aws:greengrass:${REGION}:${ACCOUNT_ID}:components:${COMP}" \
      --query "componentVersions[?starts_with(componentVersion,'1.')].componentVersion" \
      --output text --region "$REGION" 2>/dev/null || echo "")
    for VER in $VERSIONS; do
      aws greengrassv2 delete-component --arn "arn:aws:greengrass:${REGION}:${ACCOUNT_ID}:components:${COMP}:versions:${VER}" --region "$REGION" 2>/dev/null && \
        echo "   Deleted: $COMP v$VER" || echo "   Skip: $COMP v$VER"
    done
    [ -z "$VERSIONS" ] && echo "   Skip: $COMP (no 1.x versions)"
  done

  # 5. TES Role 인라인 정책 제거
  echo ">>> [5/6] Removing TES role policy"
  aws iam delete-role-policy --role-name "GreengrassV2TokenExchangeRole" --policy-name "GreengrassWorkshopAccess" 2>/dev/null && \
    echo "   ✅ TES policy removed" || echo "   Skip (not found)"

  # 6. ECR 리포지토리 삭제
  echo ">>> [6/6] ECR / S3 정리 안내"
  echo "   ECR 삭제: aws ecr delete-repository --repository-name $ECR_REPO --force --region $REGION"
  echo "   S3  삭제: aws s3 rb s3://${S3_BUCKET} --force"

  echo ""
  echo "============================================"
  echo " ✅ N1.6 Uninstall Complete!"
  echo "============================================"
  echo ""
  exit 0
fi

echo "============================================"
echo " GR00T N1.6 Greengrass Workshop Setup"
echo "============================================"
echo " Region:     $REGION"
echo " Account:    $ACCOUNT_ID"
echo " UserId:     $USER_ID"
echo " Thing:      $THING_NAME"
echo " Group:      $THING_GROUP"
echo " S3:         $S3_BUCKET"
echo " ECR:        $ECR_IMAGE"
echo "============================================"
echo ""

# ─── Step 1: Prerequisites ───────────────────────────────────────────────────
echo ">>> [1/6] Prerequisites"
apt-get update -qq
apt-get install -y -qq default-jdk unzip curl jq 2>/dev/null

# ─── Step 2: S3 버킷 + 모델 다운로드 ────────────────────────────────────────
echo ">>> [2/6] S3 Bucket + Model"

if aws s3api head-bucket --bucket "$S3_BUCKET" --region "$REGION" 2>/dev/null; then
  echo "   Bucket already exists: $S3_BUCKET"
else
  echo "   Creating bucket: $S3_BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$S3_BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$S3_BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
  aws s3api put-public-access-block --bucket "$S3_BUCKET" \
    --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
fi

CF_BASE="https://d3ru2qz80ictoo.cloudfront.net/workshop"

# Pick-Orange N1.6 모델
if aws s3 ls "s3://${S3_BUCKET}/workshop/GR00T-N1.6-3B-Pick-Orange.tar.gz" --region "$REGION" &>/dev/null; then
  echo "   Model already in S3, skipping"
else
  echo "   Downloading N1.6 model from CloudFront → S3..."
  wget -q --show-progress -O /tmp/GR00T-N1.6-3B-Pick-Orange.tar.gz "${CF_BASE}/GR00T-N1.6-3B-Pick-Orange.tar.gz"
  aws s3 cp /tmp/GR00T-N1.6-3B-Pick-Orange.tar.gz "s3://${S3_BUCKET}/workshop/GR00T-N1.6-3B-Pick-Orange.tar.gz" --region "$REGION"
  rm -f /tmp/GR00T-N1.6-3B-Pick-Orange.tar.gz
  echo "   ✅ Model uploaded"
fi

echo "   Files in s3://${S3_BUCKET}/workshop/:"
aws s3 ls "s3://${S3_BUCKET}/workshop/" --region "$REGION" --human-readable 2>/dev/null || true

# ─── Step 3: ECR + Docker 이미지 ─────────────────────────────────────────────
echo ">>> [3/6] ECR + Docker"

aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" &>/dev/null || \
  aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" --image-scanning-configuration scanOnPush=true

aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

ECR_EXISTS=$(aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag=latest --region "$REGION" 2>/dev/null && echo "yes" || echo "no")

if [ "$ECR_EXISTS" = "yes" ]; then
  echo "   Image already in ECR: $ECR_IMAGE (skipping)"
else
  echo "   Building N1.6 Docker image (PyTorch + TRT 10.7 compatible)..."
  BUILD_DIR="/tmp/groot-n16-build"
  rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR"

  cat > "$BUILD_DIR/Dockerfile" << 'DKEOF'
# Base: pytorch:24.12-py3 — CUDA 12.4, Python 3.12, system TRT 10.7 (working)
FROM nvcr.io/nvidia/pytorch:24.12-py3
ENV DEBIAN_FRONTEND=noninteractive
ENV NVIDIA_DRIVER_CAPABILITIES=graphics,utility,compute

RUN apt-get update && apt-get install -y git git-lfs ffmpeg wget curl && rm -rf /var/lib/apt/lists/*
RUN pip install uv

# Upgrade torch + transformers (Qwen3 support required for N1.6)
RUN pip install --upgrade torch torchvision --index-url https://download.pytorch.org/whl/cu124
RUN pip install --upgrade transformers accelerate

# Isaac-GR00T N1.6 stable — uv sync handles all deps + dataclass compat
RUN git clone https://github.com/NVIDIA/Isaac-GR00T.git /workspace/gr00t-repo && \
    cd /workspace/gr00t-repo && \
    git checkout 5dc80c4afd726b34faad1d8f7e007a13b34e4c88 && \
    uv sync && uv pip install -e .

# ONNX export dependencies (must be after uv sync creates the venv)
RUN uv pip install --python /workspace/gr00t-repo/.venv/bin/python onnxscript onnx onnxruntime

ENV VIRTUAL_ENV="/workspace/gr00t-repo/.venv"
ENV PATH="/workspace/gr00t-repo/.venv/bin:${PATH}"
ENV PYTHONPATH="/workspace/gr00t-repo:/workspace"

# TRT fix: remove pip TRT 10.16 (CUDA error 35 bug), use system TRT 10.7
RUN VENV_SP="/workspace/gr00t-repo/.venv/lib/python3.12/site-packages" && \
    SYS_SP="/usr/local/lib/python3.12/dist-packages" && \
    rm -rf $VENV_SP/tensorrt $VENV_SP/tensorrt_libs $VENV_SP/tensorrt_bindings \
           $VENV_SP/tensorrt_cu12* $VENV_SP/tensorrt-* $VENV_SP/tensorrt_*.dist-info && \
    ln -sf $SYS_SP/tensorrt $VENV_SP/tensorrt && \
    [ -d $SYS_SP/tensorrt_libs ] && ln -sf $SYS_SP/tensorrt_libs $VENV_SP/tensorrt_libs; \
    [ -d $SYS_SP/tensorrt_bindings ] && ln -sf $SYS_SP/tensorrt_bindings $VENV_SP/tensorrt_bindings; \
    for f in $SYS_SP/tensorrt-10.7*.dist-info $SYS_SP/tensorrt_*10.7*.dist-info; do \
      [ -e "$f" ] && ln -sf "$f" "$VENV_SP/$(basename $f)"; \
    done; \
    python -c "import tensorrt as trt; print('TRT', trt.__version__)"

WORKDIR /workspace/gr00t-repo
ENV LD_LIBRARY_PATH="/usr/local/lib/python3.12/dist-packages/torch/lib:/usr/local/nvidia/lib:/usr/local/nvidia/lib64:${LD_LIBRARY_PATH}"
ENTRYPOINT ["python", "-m", "gr00t.eval.run_gr00t_server"]
DKEOF

  docker build -t "groot-n16-inference:latest" "$BUILD_DIR"
  docker tag "groot-n16-inference:latest" "$ECR_IMAGE"
  docker push "$ECR_IMAGE"
  rm -rf "$BUILD_DIR"
  echo "   ✅ Image pushed: $ECR_IMAGE"
fi

# ─── Step 3.5: EC2 Instance Role에 IoT/Greengrass 권한 확인 ──────────────────
echo ">>> [3.5/6] Checking IoT/Greengrass permissions on EC2 Role"

EC2_ROLE_NAME=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/ 2>/dev/null || echo "")

GG_PROVISION_POLICY="GreengrassProvisionPolicy"

if [ -n "$EC2_ROLE_NAME" ]; then
  if aws iam get-role-policy --role-name "$EC2_ROLE_NAME" --policy-name "$GG_PROVISION_POLICY" &>/dev/null; then
    echo "   ✅ Permissions already configured on $EC2_ROLE_NAME"
  else
    echo "   ⚠️  IoT/Greengrass 권한이 없습니다. 아래 명령어로 추가하세요:"
    echo "   aws iam put-role-policy --role-name $EC2_ROLE_NAME --policy-name $GG_PROVISION_POLICY \\"
    echo "     --policy-document file://gg-provision-policy.json"
    echo ""
    echo "   또는 관리자에게 요청하세요."
    echo "   계속 진행합니다 (Greengrass 설치 시 실패할 수 있음)..."
  fi
else
  echo "   ⚠️  EC2 Role을 감지할 수 없습니다. 계속 진행합니다."
fi

# ─── Step 4: Greengrass 설치 + 프로비저닝 ────────────────────────────────────
if [ -f /greengrass/v2/bin/greengrass-cli ]; then
  echo ">>> [4/6] Greengrass already installed (skipping)"
else
  echo ">>> [4/6] Installing Greengrass"
  curl -s https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-nucleus-latest.zip -o /tmp/gg.zip
  unzip -qo /tmp/gg.zip -d /tmp/gg

  java -Droot="/greengrass/v2" -Dlog.store=FILE \
    -jar /tmp/gg/lib/Greengrass.jar \
    --aws-region "$REGION" \
    --thing-name "$THING_NAME" \
    --thing-group-name "$THING_GROUP" \
    --component-default-user ggc_user:ggc_group \
    --provision true \
    --setup-system-service true \
    --deploy-dev-tools true

  rm -rf /tmp/gg /tmp/gg.zip
  for i in $(seq 1 30); do
    /greengrass/v2/bin/greengrass-cli component list &>/dev/null && break
    sleep 5
  done
  echo "   ✅ Greengrass installed"

  # Greengrass 시스템 컴포넌트 배포 (dev-tools 스킵된 경우 대비)
  echo "   Deploying Greengrass system components..."
  aws greengrassv2 create-deployment \
    --target-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP}" \
    --components "{
      \"aws.greengrass.Nucleus\":{\"componentVersion\":\"2.17.0\"},
      \"aws.greengrass.Cli\":{\"componentVersion\":\"2.17.0\"},
      \"aws.greengrass.SecureTunneling\":{\"componentVersion\":\"2.0.0\"},
      \"aws.greengrass.LogManager\":{\"componentVersion\":\"2.3.12\",\"configurationUpdate\":{\"merge\":\"{\\\"logsUploaderConfiguration\\\":{\\\"componentLogsConfigurationMap\\\":{\\\"com.workshop.${USER_ID}.setup\\\":{\\\"minimumLogLevel\\\":\\\"INFO\\\"},\\\"com.workshop.${USER_ID}.docker-build\\\":{\\\"minimumLogLevel\\\":\\\"INFO\\\"},\\\"com.workshop.${USER_ID}.inference\\\":{\\\"minimumLogLevel\\\":\\\"INFO\\\"},\\\"com.workshop.${USER_ID}.benchmark\\\":{\\\"minimumLogLevel\\\":\\\"INFO\\\"}}}}\"}}
    }" \
    --region "$REGION" &>/dev/null || true
fi

aws iot create-thing-group --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true
aws iot add-thing-to-thing-group --thing-name "$THING_NAME" --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true

# ─── Step 5: TES Role 권한 ───────────────────────────────────────────────────
echo ">>> [5/6] IAM permissions"

TES_ROLE="GreengrassV2TokenExchangeRole"
POLICY_NAME="GreengrassWorkshopAccess"

if ! aws iam get-role-policy --role-name "$TES_ROLE" --policy-name "$POLICY_NAME" &>/dev/null; then
  cat > /tmp/tes-policy.json << IAMEOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}", "arn:aws:s3:::${S3_BUCKET}/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "*"
    }
  ]
}
IAMEOF
  aws iam put-role-policy --role-name "$TES_ROLE" --policy-name "$POLICY_NAME" --policy-document file:///tmp/tes-policy.json
  echo "   ✅ Permissions added"
else
  echo "   Permissions already configured"
fi

# ─── Step 6: com.workshop.* 컴포넌트 등록 (N1.6) ────────────────────────────
echo ">>> [6/6] Registering components (N1.6)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENTS_DIR="${SCRIPT_DIR}/../workshop-components/N1.6"

if [ ! -d "$COMPONENTS_DIR" ]; then
  COMPONENTS_DIR="$(pwd)/workshop-components/N1.6"
fi

if [ ! -d "$COMPONENTS_DIR" ]; then
  echo "   Downloading components from S3..."
  COMPONENTS_DIR="/tmp/workshop-components/N1.6"
  aws s3 sync "s3://${S3_BUCKET}/workshop-components/N1.6" "$COMPONENTS_DIR" --region "$REGION" 2>/dev/null || true
fi

OLD_ECR_PATTERN="007023064118\.dkr\.ecr\.[a-z0-9-]*\.amazonaws\.com/groot-n16-inference-jinseony"
NEW_ECR="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"

for RECIPE in "$COMPONENTS_DIR"/com.workshop.*/recipe.yaml; do
  [ -f "$RECIPE" ] || continue
  COMP_NAME=$(grep 'ComponentName:' "$RECIPE" | awk '{print $2}')
  COMP_VER=$(grep 'ComponentVersion:' "$RECIPE" | awk -F'"' '{print $2}')

  TEMP_RECIPE="/tmp/recipe-$(basename $(dirname $RECIPE)).yaml"
  sed -E "s|${OLD_ECR_PATTERN}|${NEW_ECR}|g" "$RECIPE" > "$TEMP_RECIPE"
  sed -i "s|S3_BUCKET_PLACEHOLDER|${S3_BUCKET}|g" "$TEMP_RECIPE"
  # Replace hardcoded region in recipe configurations
  sed -i "s|region: \"us-east-1\"|region: \"${REGION}\"|g" "$TEMP_RECIPE"
  # Append -USER_ID to component names to avoid conflicts between users
  sed -i "s|ComponentName: com.workshop\.|ComponentName: com.workshop.${USER_ID}.|g" "$TEMP_RECIPE"
  # Also fix dependency references
  sed -i "s|com.workshop.docker-build|com.workshop.${USER_ID}.docker-build|g" "$TEMP_RECIPE"
  sed -i "s|com.workshop.setup|com.workshop.${USER_ID}.setup|g" "$TEMP_RECIPE"
  sed -i "s|com.workshop.inference|com.workshop.${USER_ID}.inference|g" "$TEMP_RECIPE"
  sed -i "s|com.workshop.benchmark|com.workshop.${USER_ID}.benchmark|g" "$TEMP_RECIPE"

  COMP_NAME_FINAL=$(grep 'ComponentName:' "$TEMP_RECIPE" | awk '{print $2}')
  echo "   Registering: $COMP_NAME_FINAL v$COMP_VER"
  aws greengrassv2 create-component-version \
    --inline-recipe "fileb://$TEMP_RECIPE" \
    --region "$REGION" 2>/dev/null && echo "     ✅ OK" || echo "     ⏭️  Already exists"
  rm -f "$TEMP_RECIPE"
done

# ─── 완료 ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo " ✅ N1.6 Setup Complete!"
echo "============================================"
echo ""
echo " Thing:  $THING_NAME"
echo " Group:  $THING_GROUP"
echo " S3:     s3://${S3_BUCKET}/"
echo " ECR:    $ECR_IMAGE"
echo ""
echo " [1/3] 환경 준비 (Docker + 모델 + TRT 빌드):"
echo "   aws greengrassv2 create-deployment \\"
echo "     --target-arn arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP} \\"
echo "     --deployment-name \"workshop-n16-setup\" \\"
echo "     --components '{\"aws.greengrass.Nucleus\":{\"componentVersion\":\"2.17.0\"},\"aws.greengrass.Cli\":{\"componentVersion\":\"2.17.0\"},\"aws.greengrass.SecureTunneling\":{\"componentVersion\":\"2.0.0\"},\"aws.greengrass.LogManager\":{\"componentVersion\":\"2.3.12\"},\"com.workshop.${USER_ID}.docker-build\":{\"componentVersion\":\"1.0.0\"},\"com.workshop.${USER_ID}.setup\":{\"componentVersion\":\"1.0.0\"}}' \\"
echo "     --deployment-policies '{\"componentUpdatePolicy\":{\"action\":\"SKIP_NOTIFY_COMPONENTS\"}}' \\"
echo "     --region $REGION"
echo ""
echo " [2/3] 벤치마크 (PyTorch vs TRT, inference 제외):"
echo "   aws greengrassv2 create-deployment \\"
echo "     --target-arn arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP} \\"
echo "     --deployment-name \"workshop-n16-benchmark\" \\"
echo "     --components '{\"aws.greengrass.Nucleus\":{\"componentVersion\":\"2.17.0\"},\"aws.greengrass.Cli\":{\"componentVersion\":\"2.17.0\"},\"aws.greengrass.SecureTunneling\":{\"componentVersion\":\"2.0.0\"},\"aws.greengrass.LogManager\":{\"componentVersion\":\"2.3.12\"},\"com.workshop.${USER_ID}.docker-build\":{\"componentVersion\":\"1.0.0\"},\"com.workshop.${USER_ID}.setup\":{\"componentVersion\":\"1.0.0\"},\"com.workshop.${USER_ID}.benchmark\":{\"componentVersion\":\"1.0.0\"}}' \\"
echo "     --deployment-policies '{\"componentUpdatePolicy\":{\"action\":\"SKIP_NOTIFY_COMPONENTS\"}}' \\"
echo "     --region $REGION"
echo ""
echo " [3/3] 추론 서버 (Policy Server 포트 5555, 벤치마크 제외):"
echo "   aws greengrassv2 create-deployment \\"
echo "     --target-arn arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP} \\"
echo "     --deployment-name \"workshop-n16-inference\" \\"
echo "     --components '{\"aws.greengrass.Nucleus\":{\"componentVersion\":\"2.17.0\"},\"aws.greengrass.Cli\":{\"componentVersion\":\"2.17.0\"},\"aws.greengrass.SecureTunneling\":{\"componentVersion\":\"2.0.0\"},\"aws.greengrass.LogManager\":{\"componentVersion\":\"2.3.12\"},\"com.workshop.${USER_ID}.docker-build\":{\"componentVersion\":\"1.0.0\"},\"com.workshop.${USER_ID}.setup\":{\"componentVersion\":\"1.0.0\"},\"com.workshop.${USER_ID}.inference\":{\"componentVersion\":\"1.0.0\"}}' \\"
echo "     --deployment-policies '{\"componentUpdatePolicy\":{\"action\":\"SKIP_NOTIFY_COMPONENTS\"}}' \\"
echo "     --region $REGION"
echo ""
echo " 기대 벤치마크 결과 (L40S):"
echo "   PyTorch: Avg ~126ms | 7.9 Hz"
echo "   TRT (DiT Action Head): Avg ~60ms | 16.6 Hz | 2.1x speedup"
