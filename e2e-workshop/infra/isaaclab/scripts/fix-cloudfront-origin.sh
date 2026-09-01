#!/usr/bin/env bash
# =============================================================================
# fix-cloudfront-origin.sh — DCV 인스턴스 stop/start 후 CloudFront origin 갱신
#
# DCV 인스턴스를 stop/start하면 퍼블릭 DNS가 바뀌어
# CloudFront origin이 stale 상태가 되고 code-server URL이 502를 반환한다.
# 이 스크립트는 배포 식별자(계정 ID)로 인스턴스와 CloudFront distribution을 찾아
# 현재 퍼블릭 DNS로 origin DomainName을 갱신한다.
#
# 사용법:
#   ./scripts/fix-cloudfront-origin.sh [profile]
#   (식별자는 현재 자격증명의 계정 ID를 자동 사용)
# =============================================================================
set -euo pipefail

PROFILE_FILTER="${1:-}"
REGION="${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo "us-east-1")}"

# 1인 1계정 전제: 식별자는 항상 계정 ID
USER_ID="$(aws sts get-caller-identity --query Account --output text)"

if [[ -z "$USER_ID" ]]; then
  echo "Error: 계정 ID를 확인할 수 없습니다 (aws sts get-caller-identity 실패)."
  exit 1
fi

command -v jq >/dev/null || { echo "Error: jq가 필요합니다."; exit 1; }

echo "=== CloudFront Origin 갱신 ==="
echo "UserId: $USER_ID"
echo "Region: $REGION"
echo ""

# --- 1. UserId 태그로 running 상태 EC2 인스턴스 탐색 ---
echo "→ EC2 인스턴스 탐색 중..."
INSTANCE_INFO=$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters \
    "Name=tag:UserId,Values=$USER_ID" \
    "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,PublicDnsName,Tags[?Key==`Name`]|[0].Value,PublicIpAddress]' \
  --output json)

INSTANCE_COUNT=$(echo "$INSTANCE_INFO" | jq 'length')

if [[ "$INSTANCE_COUNT" == "0" ]]; then
  echo "Error: UserId=$USER_ID 인 running 상태 인스턴스를 찾을 수 없습니다."
  echo "       인스턴스가 'running' 상태인지 확인하세요."
  exit 1
fi

# 프로필 필터 적용 (Name 태그에 프로필명 포함되어 있으면)
if [[ -n "$PROFILE_FILTER" ]]; then
  PROFILE_PART="$(echo "$PROFILE_FILTER" | sed 's/./\U&/')"
  INSTANCE_INFO=$(echo "$INSTANCE_INFO" | jq --arg p "$PROFILE_PART" '[.[] | select(.[2] | contains($p))]')
  INSTANCE_COUNT=$(echo "$INSTANCE_INFO" | jq 'length')
fi

if [[ "$INSTANCE_COUNT" -gt 1 ]]; then
  echo "Error: 여러 인스턴스가 발견되었습니다. profile 인자로 좁혀주세요."
  echo "$INSTANCE_INFO" | jq -r '.[] | "  - \(.[0])  \(.[2])"'
  exit 1
fi

INSTANCE_ID=$(echo "$INSTANCE_INFO" | jq -r '.[0][0]')
NEW_DNS=$(echo "$INSTANCE_INFO" | jq -r '.[0][1]')
INSTANCE_NAME=$(echo "$INSTANCE_INFO" | jq -r '.[0][2]')
NEW_IP=$(echo "$INSTANCE_INFO" | jq -r '.[0][3]')

if [[ -z "$NEW_DNS" || "$NEW_DNS" == "null" ]]; then
  echo "Error: 인스턴스 $INSTANCE_ID 의 PublicDnsName이 비어있습니다."
  exit 1
fi

echo "  Instance: $INSTANCE_ID ($INSTANCE_NAME)"
echo "  New DNS:  $NEW_DNS"
echo ""

# --- 2. UserId 태그로 CloudFront distribution 탐색 ---
echo "→ CloudFront Distribution 탐색 중..."
DIST_LIST=$(aws cloudfront list-distributions --output json)
DIST_IDS=$(echo "$DIST_LIST" | jq -r '.DistributionList.Items[]?.Id // empty')

DIST_ID=""
for ID in $DIST_IDS; do
  ARN=$(echo "$DIST_LIST" | jq -r --arg id "$ID" '.DistributionList.Items[] | select(.Id==$id) | .ARN')
  TAGS=$(aws cloudfront list-tags-for-resource --resource "$ARN" --output json 2>/dev/null || echo '{"Tags":{"Items":[]}}')
  TAG_USER=$(echo "$TAGS" | jq -r '.Tags.Items[]? | select(.Key=="UserId") | .Value')
  TAG_NAME=$(echo "$TAGS" | jq -r '.Tags.Items[]? | select(.Key=="Name") | .Value')

  if [[ "$TAG_USER" != "$USER_ID" ]]; then
    continue
  fi
  if [[ -n "$PROFILE_FILTER" ]]; then
    PROFILE_PART="$(echo "$PROFILE_FILTER" | sed 's/./\U&/')"
    [[ "$TAG_NAME" == *"$PROFILE_PART"* ]] || continue
  fi

  if [[ -n "$DIST_ID" ]]; then
    echo "Error: 여러 distribution이 발견되었습니다. profile 인자로 좁혀주세요."
    exit 1
  fi
  DIST_ID="$ID"
  DIST_NAME="$TAG_NAME"
done

if [[ -z "$DIST_ID" ]]; then
  echo "Error: UserId=$USER_ID 인 CloudFront distribution을 찾을 수 없습니다."
  exit 1
fi

echo "  Distribution: $DIST_ID ($DIST_NAME)"
echo ""

# --- 3. 현재 distribution config + ETag 조회 ---
echo "→ 현재 origin 확인 중..."
CFG_FILE=$(mktemp)
trap 'rm -f "$CFG_FILE" "$CFG_FILE.new"' EXIT

aws cloudfront get-distribution-config --id "$DIST_ID" --output json > "$CFG_FILE"

ETAG=$(jq -r '.ETag' "$CFG_FILE")
CURRENT_DNS=$(jq -r '.DistributionConfig.Origins.Items[0].DomainName' "$CFG_FILE")

echo "  Current: $CURRENT_DNS"
echo "  Target:  $NEW_DNS"

if [[ "$CURRENT_DNS" == "$NEW_DNS" ]]; then
  echo ""
  echo "이미 최신 DNS로 설정되어 있습니다. 갱신 불필요."

  CF_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)

  echo ""
  echo "=== 결과 ==="
  echo "Instance ID:      $INSTANCE_ID"
  echo "Public IP:        $NEW_IP"
  echo "Public DNS:       $NEW_DNS"
  echo "Distribution ID:  $DIST_ID"
  echo "DCV URL:          https://$NEW_IP:8443"
  echo "code-server URL:  https://$CF_DOMAIN"
  exit 0
fi

# --- 4. DomainName 교체 후 update-distribution ---
echo ""
echo "→ Origin DomainName 갱신 중..."
jq --arg dns "$NEW_DNS" \
  '.DistributionConfig.Origins.Items[0].DomainName = $dns | .DistributionConfig' \
  "$CFG_FILE" > "$CFG_FILE.new"

aws cloudfront update-distribution \
  --id "$DIST_ID" \
  --if-match "$ETAG" \
  --distribution-config "file://$CFG_FILE.new" \
  --output json > /dev/null

echo "  완료. CloudFront 전파에 수 분 소요됩니다."

CF_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)

echo ""
echo "=== 결과 ==="
echo "Instance ID:      $INSTANCE_ID"
echo "Public IP:        $NEW_IP"
echo "Public DNS:       $NEW_DNS"
echo "Distribution ID:  $DIST_ID"
echo "DCV URL:          https://$NEW_IP:8443"
echo "code-server URL:  https://$CF_DOMAIN"
