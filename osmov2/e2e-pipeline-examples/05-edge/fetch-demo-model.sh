#!/bin/bash
# =============================================================================
# fetch-demo-model.sh
# Stage 5 (edge) — 사전 점검용 데모 모델 준비 (선택)
#
# Stage 3 파인튜닝을 아직 돌리지 않았어도, 워크샵이 제공하는 사전 학습 데모
# 체크포인트(GR00T-N1.6-3B Pick-Orange)를 S3 에 올려 엣지 배포 흐름 전체를
# 한 번 점검(smoke-check)할 수 있게 한다. 실제 파이프라인 산출물이 아니라
# "배포가 되는지" 확인용 고정 데모 자산이다.
#
# 원본은 워크샵 setup-greengrass-workshop-N16.sh Step 2가 받던 CloudFront
# tarball. 여기서는 그 URL 만 재사용하고, S3 업로드 대상을 인자로 받는다.
#
# 사용법:
#   bash fetch-demo-model.sh --s3-uri s3://<bucket>/<prefix> --region <REGION>
#
#   옵션:
#     --s3-uri  <URI>     (필수) 데모 모델을 풀어 올릴 S3 위치
#     --region  <REGION>  (필수) AWS 리전
#     --keep-local        tar 해제본을 /tmp 에 남김 (기본은 정리)
#
# 이후: com.aws.groot.setup/recipe.yaml 의 modelS3Uri 를 --s3-uri 값으로 설정.
# =============================================================================
set -euo pipefail

S3_URI=""
REGION=""
KEEP_LOCAL="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --s3-uri)     S3_URI="$2"; shift 2 ;;
    --region)     REGION="$2"; shift 2 ;;
    --keep-local) KEEP_LOCAL="true"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

if [ -z "$REGION" ]; then
  REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
fi
if [ -z "$S3_URI" ] || [ -z "$REGION" ]; then
  echo "ERROR: --s3-uri 와 --region 은 필수입니다."
  exit 1
fi
export AWS_DEFAULT_REGION="$REGION"

# 워크샵 데모 자산 (사전 학습된 Pick-Orange N1.6 체크포인트)
CF_URL="https://d3ru2qz80ictoo.cloudfront.net/workshop/GR00T-N1.6-3B-Pick-Orange.tar.gz"
WORK_DIR="$(mktemp -d /tmp/groot-demo-model.XXXXXX)"
[ "$KEEP_LOCAL" = "true" ] || trap 'rm -rf "$WORK_DIR"' EXIT

echo "============================================"
echo " 데모 모델 준비 (사전 점검용)"
echo " Source: $CF_URL"
echo " Dest:   $S3_URI"
echo " Region: $REGION"
echo "============================================"

echo ">>> [1/3] 다운로드"
wget -q --show-progress -O "$WORK_DIR/model.tar.gz" "$CF_URL"

echo ">>> [2/3] 압축 해제"
mkdir -p "$WORK_DIR/model"
tar -xzf "$WORK_DIR/model.tar.gz" -C "$WORK_DIR/model"

echo ">>> [3/3] S3 업로드"
aws s3 sync "$WORK_DIR/model" "$S3_URI" --region "$REGION" --no-progress

echo ""
echo "============================================"
echo " 완료: $S3_URI"
echo "============================================"
echo " com.aws.groot.setup/recipe.yaml 의 modelS3Uri 를 위 값으로 설정하세요."
[ "$KEEP_LOCAL" = "true" ] && echo " 로컬 사본: $WORK_DIR/model"
