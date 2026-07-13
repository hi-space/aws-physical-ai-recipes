#!/bin/bash
# =============================================================================
# bootstrap-device.sh
# Stage 5 (edge) — 엣지 디바이스 1회성 부트스트랩
#
# AWS IoT Greengrass v2 Nucleus 설치 + 프로비저닝 + 실행 권한(TES) 부여.
# 디바이스당 딱 한 번만 실행한다. 컴포넌트 등록/배포는 register-components.sh 참고.
#
# 워크샵 setup-greengrass-workshop-N16.sh 에서 다음을 일반화:
#   - EC2 IMDS 하드 의존 제거 → --region/--account 인자 또는 IMDS 폴백
#   - CloudFront 모델 tarball 다운로드 / ECR 이미지 빌드 제거 (그 역할은
#     setup 컴포넌트가 S3에서, inference 컴포넌트가 BYO ECR 이미지로 수행)
#   - Thing 이름을 userId 유추 대신 --thing-name 으로 명시
#
# 사용법:
#   sudo bash bootstrap-device.sh --thing-name <NAME> [옵션]
#
#   옵션:
#     --thing-name  <NAME>    (필수) IoT Thing 이름. Thing Group 은 <NAME>-group
#     --region      <REGION>  AWS 리전 (미지정 시 IMDS → AWS_DEFAULT_REGION)
#     --account     <ID>      AWS 계정 ID (미지정 시 IMDS → STS)
#     --s3-bucket   <BUCKET>  모델을 담은 S3 버킷 (TES Role S3 권한 스코프용)
#     --nucleus-version <V>   Greengrass Nucleus 버전 (기본 2.17.0)
#     --uninstall             Greengrass + IoT/배포 리소스 제거
#
# 예:
#   sudo bash bootstrap-device.sh --thing-name groot-edge-01 \
#        --region ap-northeast-2 --s3-bucket my-groot-models
#
# ─── 사전 요구사항: 디바이스 자격증명 IAM 권한 ─────────────────────────────────
# 이 스크립트는 Nucleus 프로비저닝에서 IoT/IAM 리소스를 자동 생성한다. 실행
# 주체(EC2 인스턴스 Role 또는 디바이스에 설정된 AWS 자격증명)에 아래 권한이
# 사전에 있어야 한다:
#   iot:*, greengrass:*, sts:GetCallerIdentity,
#   iam:{GetRole,CreateRole,AttachRolePolicy,GetPolicy,PassRole,
#        CreatePolicy,TagRole,PutRolePolicy,GetRolePolicy}
# =============================================================================
set -euo pipefail

# ─── 인자 파싱 ────────────────────────────────────────────────────────────────
THING_NAME=""
REGION=""
ACCOUNT_ID=""
S3_BUCKET=""
NUCLEUS_VERSION="2.17.0"
UNINSTALL="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --thing-name)      THING_NAME="$2"; shift 2 ;;
    --region)          REGION="$2"; shift 2 ;;
    --account)         ACCOUNT_ID="$2"; shift 2 ;;
    --s3-bucket)       S3_BUCKET="$2"; shift 2 ;;
    --nucleus-version) NUCLEUS_VERSION="$2"; shift 2 ;;
    --uninstall)       UNINSTALL="true"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

if [ -z "$THING_NAME" ]; then
  echo "ERROR: --thing-name 은 필수입니다."
  echo "  예: sudo bash bootstrap-device.sh --thing-name groot-edge-01"
  exit 1
fi
THING_GROUP="${THING_NAME}-group"

# ─── 리전/계정 확정 (인자 → IMDS → 환경/STS 폴백) ─────────────────────────────
imds_token() {
  curl -s -m 2 -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true
}
IMDS_TOKEN="$(imds_token)"

if [ -z "$REGION" ] && [ -n "$IMDS_TOKEN" ]; then
  REGION=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)
fi
REGION="${REGION:-${AWS_DEFAULT_REGION:-${AWS_REGION:-}}}"
if [ -z "$REGION" ]; then
  echo "ERROR: 리전을 확정할 수 없습니다. --region 으로 지정하세요."
  exit 1
fi
export AWS_DEFAULT_REGION="$REGION"

if [ -z "$ACCOUNT_ID" ]; then
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
fi
if [ -z "$ACCOUNT_ID" ]; then
  echo "ERROR: 계정 ID를 확정할 수 없습니다. --account 으로 지정하세요."
  exit 1
fi

TES_ROLE="GreengrassV2TokenExchangeRole"
TES_POLICY="GrootEdgeAccess"

# ─── Uninstall 모드 ──────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "true" ]; then
  echo "============================================"
  echo " Greengrass edge uninstall"
  echo " Thing:  $THING_NAME"
  echo " Group:  $THING_GROUP"
  echo " Region: $REGION"
  echo "============================================"

  echo ">>> [1/5] Greengrass 서비스 중지 및 제거"
  systemctl stop greengrass.service 2>/dev/null || true
  systemctl disable greengrass.service 2>/dev/null || true
  rm -rf /greengrass/v2
  rm -f /etc/systemd/system/greengrass.service
  systemctl daemon-reload 2>/dev/null || true

  echo ">>> [2/5] Greengrass 배포 취소/삭제"
  for TARGET in \
    "arn:aws:iot:${REGION}:${ACCOUNT_ID}:thing/${THING_NAME}" \
    "arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP}"; do
    DEPLOYS=$(aws greengrassv2 list-deployments --target-arn "$TARGET" \
      --query 'deployments[].deploymentId' --output text --region "$REGION" 2>/dev/null || echo "")
    for D in $DEPLOYS; do
      aws greengrassv2 cancel-deployment --deployment-id "$D" --region "$REGION" 2>/dev/null || true
      aws greengrassv2 delete-deployment --deployment-id "$D" --region "$REGION" 2>/dev/null || true
      echo "   삭제된 배포: $D"
    done
  done
  aws greengrassv2 delete-core-device --core-device-thing-name "$THING_NAME" --region "$REGION" 2>/dev/null \
    && echo "   삭제된 core device: $THING_NAME" || true

  echo ">>> [3/5] IoT Thing/인증서 제거"
  PRINCIPALS=$(aws iot list-thing-principals --thing-name "$THING_NAME" --region "$REGION" \
    --query 'principals[*]' --output text 2>/dev/null || echo "")
  for CERT_ARN in $PRINCIPALS; do
    CERT_ID=$(echo "$CERT_ARN" | awk -F'/' '{print $NF}')
    POLICIES=$(aws iot list-attached-policies --target "$CERT_ARN" --region "$REGION" \
      --query 'policies[*].policyName' --output text 2>/dev/null || echo "")
    for P in $POLICIES; do
      aws iot detach-policy --policy-name "$P" --target "$CERT_ARN" --region "$REGION" 2>/dev/null || true
    done
    aws iot detach-thing-principal --thing-name "$THING_NAME" --principal "$CERT_ARN" --region "$REGION" 2>/dev/null || true
    aws iot update-certificate --certificate-id "$CERT_ID" --new-status INACTIVE --region "$REGION" 2>/dev/null || true
    aws iot delete-certificate --certificate-id "$CERT_ID" --force-delete --region "$REGION" 2>/dev/null || true
    echo "   삭제된 인증서: $CERT_ID"
  done
  aws iot remove-thing-from-thing-group --thing-name "$THING_NAME" --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true
  aws iot delete-thing --thing-name "$THING_NAME" --region "$REGION" 2>/dev/null || true
  aws iot delete-thing-group --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true

  echo ">>> [4/5] TES Role 인라인 정책 제거"
  aws iam delete-role-policy --role-name "$TES_ROLE" --policy-name "$TES_POLICY" 2>/dev/null \
    && echo "   제거됨: ${TES_ROLE}/${TES_POLICY}" || echo "   건너뜀 (없음)"

  echo ">>> [5/5] 컴포넌트 삭제 안내"
  echo "   컴포넌트 버전 삭제는 register-components.sh --delete 로 수행하세요."
  echo ""
  echo "Uninstall 완료."
  exit 0
fi

echo "============================================"
echo " Greengrass edge bootstrap"
echo " Thing:   $THING_NAME"
echo " Group:   $THING_GROUP"
echo " Region:  $REGION"
echo " Account: $ACCOUNT_ID"
echo " Nucleus: $NUCLEUS_VERSION"
echo "============================================"

# ─── Step 1: 필수 패키지 ──────────────────────────────────────────────────────
echo ">>> [1/4] 필수 패키지 (JDK, unzip, curl, jq)"
if command -v apt-get &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq default-jdk unzip curl jq
elif command -v dnf &>/dev/null; then
  dnf install -y -q java-17-amazon-corretto-headless unzip curl jq
elif command -v yum &>/dev/null; then
  yum install -y -q java-17-amazon-corretto-headless unzip curl jq
else
  echo "   지원되지 않는 패키지 매니저. JDK/unzip/curl/jq 를 수동 설치하세요."
fi

# ─── Step 2: Nucleus 설치 + 프로비저닝 ────────────────────────────────────────
if [ -f /greengrass/v2/bin/greengrass-cli ]; then
  echo ">>> [2/4] Greengrass 이미 설치됨 (건너뜀)"
else
  echo ">>> [2/4] Greengrass Nucleus 설치 + 프로비저닝"
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
  echo "   Greengrass 설치 완료"
fi

aws iot create-thing-group --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true
aws iot add-thing-to-thing-group --thing-name "$THING_NAME" --thing-group-name "$THING_GROUP" --region "$REGION" 2>/dev/null || true

# ─── Step 3: TES Role 실행 권한 (S3 모델 pull + ECR 이미지 pull + 로그) ────────
echo ">>> [3/4] TES Role 권한 (${TES_ROLE}/${TES_POLICY})"
if [ -n "$S3_BUCKET" ]; then
  S3_RES="\"arn:aws:s3:::${S3_BUCKET}\", \"arn:aws:s3:::${S3_BUCKET}/*\""
else
  echo "   경고: --s3-bucket 미지정 → S3 권한을 모든 버킷(*)로 부여합니다."
  S3_RES="\"*\""
fi
cat > /tmp/groot-tes-policy.json << IAMEOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [${S3_RES}]
    },
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken", "ecr:BatchGetImage",
                 "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
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
aws iam put-role-policy --role-name "$TES_ROLE" --policy-name "$TES_POLICY" \
  --policy-document file:///tmp/groot-tes-policy.json
rm -f /tmp/groot-tes-policy.json
echo "   권한 부여 완료"

# ─── Step 4: 안내 ─────────────────────────────────────────────────────────────
echo ">>> [4/4] 완료"
echo ""
echo "============================================"
echo " Bootstrap 완료."
echo "============================================"
echo " Thing:  $THING_NAME"
echo " Group:  $THING_GROUP"
echo ""
echo " 다음 단계: 컴포넌트 등록 + 배포"
echo "   bash register-components.sh --region $REGION \\"
echo "     --deploy --thing-group $THING_GROUP"
echo ""
