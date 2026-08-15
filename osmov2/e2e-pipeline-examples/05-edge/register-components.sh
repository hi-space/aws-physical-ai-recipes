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
#   ── 모델 변경 배포용 override (배포 시점에 컴포넌트 설정을 덮어씀) ──
#   recipe.yaml 을 수정하거나 컴포넌트 버전을 올리지 않고도, 아래 값을 배포의
#   configurationUpdate.merge 로 주입해 "모델만 바꿔 재배포" 할 수 있다.
#     --model-s3-uri <URI>      setup 의 modelS3Uri 를 이 값으로 override
#     --model-name   <NAME>     setup 의 modelName + inference 의 modelPath 를 함께 override
#     --ecr-image    <IMAGE>    inference 의 ecrImage 를 이 값으로 override
#
# 사용 흐름:
#   • 최초 배포        : recipe.yaml 의 REPLACE_ME 를 채우거나 위 override 로 지정.
#   • 모델만 교체       : 새 체크포인트를 S3 에 올린 뒤
#       bash register-components.sh --region <R> --deploy --thing-group <G> \
#         --model-s3-uri s3://<bucket>/<new-prefix>
#     → setup 이 --delete 로 새 모델을 mirror-sync 하고 inference 가 재시작되어
#       새 모델을 로드한다(컴포넌트 버전 범프 불필요).
#   • 코드/레시피 로직 변경 : recipe.yaml 의 ComponentVersion 을 올린 뒤 재등록.
#
# 예:
#   # 등록만
#   bash register-components.sh --region ap-northeast-2
#   # 등록 + 배포
#   bash register-components.sh --region ap-northeast-2 \
#     --deploy --thing-group groot-edge-01-group
#   # 모델만 교체해서 재배포
#   bash register-components.sh --region ap-northeast-2 \
#     --deploy --thing-group groot-edge-01-group \
#     --model-s3-uri s3://my-groot-models/models/run-2
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REGION=""
DEPLOY="false"
THING_GROUP=""
NUCLEUS_VERSION="2.17.0"
DELETE="false"
OV_MODEL_S3_URI=""
OV_MODEL_NAME=""
OV_ECR_IMAGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --region)          REGION="$2"; shift 2 ;;
    --deploy)          DEPLOY="true"; shift ;;
    --thing-group)     THING_GROUP="$2"; shift 2 ;;
    --nucleus-version) NUCLEUS_VERSION="$2"; shift 2 ;;
    --delete)          DELETE="true"; shift ;;
    --model-s3-uri)    OV_MODEL_S3_URI="$2"; shift 2 ;;
    --model-name)      OV_MODEL_NAME="$2"; shift 2 ;;
    --ecr-image)       OV_ECR_IMAGE="$2"; shift 2 ;;
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

# ─── REPLACE_ME 미치환 검사 ──────────────────────────────────────────────────
# 배포 시 override(--model-s3-uri / --ecr-image)로 값을 주입하면 recipe 의
# REPLACE_ME 기본값은 configurationUpdate 로 덮어써지므로 편집이 필수는 아니다.
# override 가 없는 항목에 REPLACE_ME 가 남아 있으면 그때만 막는다.
SETUP_RECIPE="${SCRIPT_DIR}/com.aws.groot.setup/recipe.yaml"
INF_RECIPE="${SCRIPT_DIR}/com.aws.groot.inference/recipe.yaml"
NEED_EDIT="false"
if [ -z "$OV_MODEL_S3_URI" ] && grep -q "REPLACE_ME" "$SETUP_RECIPE" 2>/dev/null; then
  echo "경고: com.aws.groot.setup/recipe.yaml 에 REPLACE_ME(modelS3Uri)가 남아 있습니다."
  echo "  recipe 를 수정하거나 --model-s3-uri s3://<bucket>/<prefix> 를 지정하세요."
  NEED_EDIT="true"
fi
if [ -z "$OV_ECR_IMAGE" ] && grep -q "REPLACE_ME" "$INF_RECIPE" 2>/dev/null; then
  echo "경고: com.aws.groot.inference/recipe.yaml 에 REPLACE_ME(ecrImage)가 남아 있습니다."
  echo "  recipe 를 수정하거나 --ecr-image <IMAGE> 를 지정하세요."
  NEED_EDIT="true"
fi
if [ "$NEED_EDIT" = "true" ]; then
  exit 1
fi

# ─── 등록 ────────────────────────────────────────────────────────────────────
echo ">>> 컴포넌트 등록 (region=$REGION)"
for RECIPE in "${RECIPES[@]}"; do
  [ -f "$RECIPE" ] || { echo "   누락: $RECIPE"; exit 1; }
  NAME=$(recipe_field "$RECIPE" "ComponentName")
  VER=$(recipe_field "$RECIPE" "ComponentVersion")
  echo "   등록: ${NAME} v${VER}"
  ERR=$(aws greengrassv2 create-component-version \
    --inline-recipe "fileb://${RECIPE}" --region "$REGION" 2>&1 >/dev/null) && {
    echo "     OK"
    continue
  }
  # 실패 원인 구분: 동일 버전이 이미 있으면 정상(재배포로 진행), 그 외는 에러로 취급.
  if echo "$ERR" | grep -qiE "already exists|ConflictException|same version"; then
    echo "     이미 존재: ${NAME} v${VER} (기존 버전 사용)"
    echo "       ※ recipe 를 수정했다면 ComponentVersion 을 올려야 반영됩니다."
    echo "         (모델만 바꾸는 경우엔 버전 범프 없이 --model-s3-uri override 사용)"
  else
    echo "     ERROR: ${NAME} v${VER} 등록 실패"
    echo "$ERR" | sed 's/^/       /'
    exit 1
  fi
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

INF_NAME=$(recipe_field "$INF_RECIPE" "ComponentName")
INF_VER=$(recipe_field "$INF_RECIPE" "ComponentVersion")
SETUP_NAME=$(recipe_field "$SETUP_RECIPE" "ComponentName")
SETUP_VER=$(recipe_field "$SETUP_RECIPE" "ComponentVersion")
MODEL_DIR=$(recipe_field "$SETUP_RECIPE" "modelDir"); MODEL_DIR="${MODEL_DIR:-/opt/groot/models}"

# ── configurationUpdate.merge 조립 (override 가 있을 때만) ──────────────────
# setup: modelS3Uri / modelName,  inference: ecrImage / modelPath.
SETUP_KV=""
[ -n "$OV_MODEL_S3_URI" ] && SETUP_KV="\"modelS3Uri\":\"${OV_MODEL_S3_URI}\""
if [ -n "$OV_MODEL_NAME" ]; then
  [ -n "$SETUP_KV" ] && SETUP_KV="${SETUP_KV},"
  SETUP_KV="${SETUP_KV}\"modelName\":\"${OV_MODEL_NAME}\""
fi
INF_KV=""
[ -n "$OV_ECR_IMAGE" ] && INF_KV="\"ecrImage\":\"${OV_ECR_IMAGE}\""
if [ -n "$OV_MODEL_NAME" ]; then
  # modelName 이 바뀌면 inference 가 읽는 modelPath 도 함께 맞춰줘야 한다.
  [ -n "$INF_KV" ] && INF_KV="${INF_KV},"
  INF_KV="${INF_KV}\"modelPath\":\"${MODEL_DIR}/${OV_MODEL_NAME}\""
fi

# configurationUpdate.merge 는 "JSON 을 담은 문자열"이라 내부 따옴표를 이스케이프한다.
component_entry() {  # $1=name $2=version $3=inner-kv(빈 문자열 가능)
  local name="$1" ver="$2" kv="$3"
  if [ -n "$kv" ]; then
    local esc; esc=$(printf '%s' "{${kv}}" | sed 's/"/\\"/g')
    printf '"%s": {"componentVersion": "%s", "configurationUpdate": {"merge": "%s"}}' "$name" "$ver" "$esc"
  else
    printf '"%s": {"componentVersion": "%s"}' "$name" "$ver"
  fi
}

echo ">>> 배포 (thing group=$THING_GROUP)"
[ -n "$OV_MODEL_S3_URI" ] && echo "   override modelS3Uri = $OV_MODEL_S3_URI"
[ -n "$OV_MODEL_NAME" ]   && echo "   override modelName   = $OV_MODEL_NAME (modelPath=${MODEL_DIR}/${OV_MODEL_NAME})"
[ -n "$OV_ECR_IMAGE" ]    && echo "   override ecrImage    = $OV_ECR_IMAGE"

# setup(의존)을 명시적으로 포함해야 configurationUpdate 로 모델 설정을 덮어쓸 수
# 있다. setup 설정이 바뀌면 HARD 의존인 inference 도 재시작되어 새 모델을 로드한다.
COMP_FILE="$(mktemp)"
cat > "$COMP_FILE" <<EOF
{
  "aws.greengrass.Nucleus": {"componentVersion": "${NUCLEUS_VERSION}"},
  $(component_entry "$SETUP_NAME" "$SETUP_VER" "$SETUP_KV"),
  $(component_entry "$INF_NAME" "$INF_VER" "$INF_KV")
}
EOF

aws greengrassv2 create-deployment \
  --target-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:thinggroup/${THING_GROUP}" \
  --deployment-name "groot-edge-inference" \
  --components "file://${COMP_FILE}" \
  --deployment-policies '{"failureHandlingPolicy":"ROLLBACK","componentUpdatePolicy":{"action":"SKIP_NOTIFY_COMPONENTS"}}' \
  --region "$REGION"
rm -f "$COMP_FILE"

echo ""
echo "배포 생성 완료. 진행 상황 확인:"
echo "  디바이스에서: sudo /greengrass/v2/bin/greengrass-cli component list"
echo "  로그:         sudo tail -f /greengrass/v2/logs/${INF_NAME}.log"
