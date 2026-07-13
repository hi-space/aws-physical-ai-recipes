#!/bin/bash
# =============================================================================
# register-components.sh
# Stage 5 (edge) — Greengrass 컴포넌트 등록 + (선택) 배포
#
# 이 디렉토리의 recipe.yaml 들을 Greengrass v2 컴포넌트 버전으로 등록한다.
# 부트스트랩(bootstrap-device.sh)과 달리 모델/이미지가 바뀔 때마다 반복 실행하는
# 성격의 작업이라 별도 스크립트로 분리했다. 어느 머신에서든 aws CLI 자격증명만
# 있으면 실행 가능(디바이스에서 실행할 필요 없음).
#
# 워크샵 setup 스크립트의 Step 6(컴포넌트 등록) + 말미의 create-deployment
# 안내를 하나로 묶고, userId 접미어/ECR sed 치환 같은 워크샵 전용 로직은 제거.
# recipe.yaml 의 REPLACE_ME 값(모델 S3 URI, ECR 이미지)은 사전에 직접 수정한다.
#
# 사용법:
#   bash register-components.sh --region <REGION> [옵션]
#
#   옵션:
#     --region       <REGION>   (필수) AWS 리전
#     --deploy                  등록 후 곧바로 배포까지 수행
#     --thing-group  <GROUP>    배포 대상 Thing Group (--deploy 시 필수)
#     --nucleus-version <V>     배포에 포함할 Nucleus 버전 (기본 2.17.0)
#     --delete                  등록된 컴포넌트 버전 삭제 (등록/배포 대신)
#
# 예:
#   # 등록만
#   bash register-components.sh --region ap-northeast-2
#   # 등록 + 배포
#   bash register-components.sh --region ap-northeast-2 \
#     --deploy --thing-group groot-edge-01-group
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REGION=""
DEPLOY="false"
THING_GROUP=""
NUCLEUS_VERSION="2.17.0"
DELETE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --region)          REGION="$2"; shift 2 ;;
    --deploy)          DEPLOY="true"; shift ;;
    --thing-group)     THING_GROUP="$2"; shift 2 ;;
    --nucleus-version) NUCLEUS_VERSION="$2"; shift 2 ;;
    --delete)          DELETE="true"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

if [ -z "$REGION" ]; then
  REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
fi
if [ -z "$REGION" ]; then
  echo "ERROR: --region 은 필수입니다."
  exit 1
fi
export AWS_DEFAULT_REGION="$REGION"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)

# 등록 순서: setup 먼저 (inference 가 HARD 의존).
RECIPES=(
  "${SCRIPT_DIR}/com.aws.groot.setup/recipe.yaml"
  "${SCRIPT_DIR}/com.aws.groot.inference/recipe.yaml"
)

recipe_field() {  # $1=recipe path, $2=field key
  grep "$2:" "$1" | head -1 | sed -E "s/.*$2:[[:space:]]*//; s/\"//g"
}

# ─── Delete 모드 ─────────────────────────────────────────────────────────────
if [ "$DELETE" = "true" ]; then
  echo ">>> 컴포넌트 버전 삭제 (region=$REGION)"
  for RECIPE in "${RECIPES[@]}"; do
    [ -f "$RECIPE" ] || continue
    NAME=$(recipe_field "$RECIPE" "ComponentName")
    VER=$(recipe_field "$RECIPE" "ComponentVersion")
    ARN="arn:aws:greengrass:${REGION}:${ACCOUNT_ID}:components:${NAME}:versions:${VER}"
    aws greengrassv2 delete-component --arn "$ARN" --region "$REGION" 2>/dev/null \
      && echo "   삭제됨: ${NAME} v${VER}" || echo "   건너뜀: ${NAME} v${VER} (없음)"
  done
  exit 0
fi

# ─── REPLACE_ME 미치환 경고 ──────────────────────────────────────────────────
if grep -rq "REPLACE_ME" "${RECIPES[@]}" 2>/dev/null; then
  echo "경고: recipe.yaml 에 REPLACE_ME 가 남아 있습니다."
  echo "  - com.aws.groot.setup/recipe.yaml    : modelS3Uri"
  echo "  - com.aws.groot.inference/recipe.yaml : ecrImage"
  echo "  위 값을 실제 S3 URI / ECR 이미지로 수정한 뒤 다시 실행하세요."
  exit 1
fi

# ─── 등록 ────────────────────────────────────────────────────────────────────
echo ">>> 컴포넌트 등록 (region=$REGION)"
for RECIPE in "${RECIPES[@]}"; do
  [ -f "$RECIPE" ] || { echo "   누락: $RECIPE"; exit 1; }
  NAME=$(recipe_field "$RECIPE" "ComponentName")
  VER=$(recipe_field "$RECIPE" "ComponentVersion")
  echo "   등록: ${NAME} v${VER}"
  aws greengrassv2 create-component-version \
    --inline-recipe "fileb://${RECIPE}" --region "$REGION" >/dev/null 2>&1 \
    && echo "     OK" || echo "     이미 존재 (건너뜀)"
done

# ─── 배포 (선택) ─────────────────────────────────────────────────────────────
if [ "$DEPLOY" != "true" ]; then
  echo ""
  echo "등록 완료. 배포하려면 --deploy --thing-group <GROUP> 를 추가하세요."
  exit 0
fi

if [ -z "$THING_GROUP" ]; then
  echo "ERROR: --deploy 에는 --thing-group 이 필요합니다."
  exit 1
fi

INF_NAME=$(recipe_field "${SCRIPT_DIR}/com.aws.groot.inference/recipe.yaml" "ComponentName")
INF_VER=$(recipe_field "${SCRIPT_DIR}/com.aws.groot.inference/recipe.yaml" "ComponentVersion")

echo ">>> 배포 (thing group=$THING_GROUP)"
# inference 만 지정 → setup 은 HARD 의존으로 자동 포함된다.
aws greengrassv2 create-deployment \
  --target-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP}" \
  --deployment-name "groot-edge-inference" \
  --components "{
    \"aws.greengrass.Nucleus\": {\"componentVersion\": \"${NUCLEUS_VERSION}\"},
    \"${INF_NAME}\": {\"componentVersion\": \"${INF_VER}\"}
  }" \
  --deployment-policies '{"componentUpdatePolicy":{"action":"SKIP_NOTIFY_COMPONENTS"}}' \
  --region "$REGION"

echo ""
echo "배포 생성 완료. 진행 상황 확인:"
echo "  디바이스에서: sudo /greengrass/v2/bin/greengrass-cli component list"
echo "  로그:         sudo tail -f /greengrass/v2/logs/${INF_NAME}.log"
