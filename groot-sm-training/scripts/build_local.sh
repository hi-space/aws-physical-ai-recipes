#!/usr/bin/env bash
# =============================================================================
# build_local.sh
#
# 로컬 Docker로 GR00T 컨테이너를 빌드하고 ECR에 푸시합니다.
# CodeBuild 미사용 또는 로컬 테스트용 대안입니다.
#
# 사전 조건:
#   - Docker Desktop 또는 Docker Engine 설치 및 실행 중
#   - AWS CLI 구성 완료 (aws configure)
#   - infra/deploy_stack.py 실행 완료 (ECR 리포지토리 생성됨)
#
# 사용법:
#   bash scripts/build_local.sh --type training
#   bash scripts/build_local.sh --type inference
#   bash scripts/build_local.sh --type all
#   bash scripts/build_local.sh --type training --region us-east-1
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# 색상 출력
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 사용법
# ---------------------------------------------------------------------------
usage() {
    cat <<EOF
사용법: $(basename "$0") --type <training|inference|all> [옵션]

옵션:
  --type        빌드 타입: training, inference, all (필수)
  --region      AWS 리전 (기본값: aws configure에서 자동 감지)
  --account-id  AWS 계정 ID (기본값: 자동 감지)
  -h, --help    도움말 출력

예시:
  $(basename "$0") --type training
  $(basename "$0") --type all --region ap-northeast-2
EOF
    exit 0
}

# ---------------------------------------------------------------------------
# 인수 파싱
# ---------------------------------------------------------------------------
TYPE=""
REGION=""
ACCOUNT_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --type)         TYPE="$2";       shift 2 ;;
        --region)       REGION="$2";     shift 2 ;;
        --account-id)   ACCOUNT_ID="$2"; shift 2 ;;
        -h|--help)      usage ;;
        *) error "알 수 없는 옵션: $1. --help 참고" ;;
    esac
done

[[ -z "$TYPE" ]] && error "--type이 필요합니다. (training|inference|all)"
[[ "$TYPE" != "training" && "$TYPE" != "inference" && "$TYPE" != "all" ]] \
    && error "잘못된 --type: $TYPE"

# ---------------------------------------------------------------------------
# AWS 설정 자동 감지
# ---------------------------------------------------------------------------
REGION="${REGION:-$(aws configure get region 2>/dev/null || echo "")}"
[[ -z "$REGION" ]] && error "리전을 감지할 수 없습니다. --region을 지정하거나 aws configure를 실행하세요."

ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")}"
[[ -z "$ACCOUNT_ID" ]] && error "AWS 계정 ID를 감지할 수 없습니다."

ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

info "리전: ${REGION}"
info "계정 ID: ${ACCOUNT_ID}"
info "ECR 레지스트리: ${ECR_REGISTRY}"

# ---------------------------------------------------------------------------
# Docker 상태 확인
# ---------------------------------------------------------------------------
docker info >/dev/null 2>&1 || error "Docker가 실행 중이지 않습니다. Docker를 시작하세요."
export DOCKER_BUILDKIT=1

# ---------------------------------------------------------------------------
# ECR 인증
# ---------------------------------------------------------------------------
info "ECR 인증 중..."
aws ecr get-login-password --region "${REGION}" \
    | docker login --username AWS --password-stdin "${ECR_REGISTRY}"
success "ECR 인증 완료."

# ---------------------------------------------------------------------------
# 빌드 함수
# ---------------------------------------------------------------------------
build_and_push() {
    local build_type="$1"
    local repo_name="groot-n16-${build_type}"
    local dockerfile="container/${build_type}/Dockerfile"
    local full_uri="${ECR_REGISTRY}/${repo_name}:latest"

    info "============================================"
    info "${build_type} 컨테이너 빌드 시작"
    info "============================================"
    info "Dockerfile: ${dockerfile}"
    info "ECR URI:    ${full_uri}"

    [[ ! -f "$dockerfile" ]] && error "Dockerfile 없음: ${dockerfile}"

    # 이미지 빌드 (sagemaker-vla/ 루트에서 실행 필요)
    info "Docker 빌드 중..."
    docker build \
        --file "${dockerfile}" \
        --tag "${repo_name}:latest" \
        --cache-from "${full_uri}" \
        .
    success "빌드 완료: ${repo_name}:latest"

    # ECR 태그
    docker tag "${repo_name}:latest" "${full_uri}"

    # ECR 푸시
    info "ECR 푸시 중..."
    docker push "${full_uri}"
    success "푸시 완료: ${full_uri}"

    echo ""
    echo -e "${GREEN}이미지 URI:${NC}"
    echo -e "  ${BLUE}${full_uri}${NC}"
    echo ""
}

# ---------------------------------------------------------------------------
# 빌드 실행
# ---------------------------------------------------------------------------
# sagemaker-vla/ 디렉토리에서 실행 확인
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ ! -f "${PROJECT_DIR}/config.yaml" ]]; then
    error "sagemaker-vla/ 프로젝트 루트에서 실행해야 합니다.\n  cd /path/to/sagemaker-vla && bash scripts/build_local.sh --type ${TYPE}"
fi

cd "$PROJECT_DIR"

case "$TYPE" in
    training)
        build_and_push "training"
        ;;
    inference)
        build_and_push "inference"
        ;;
    all)
        build_and_push "training"
        build_and_push "inference"
        ;;
esac

success "모든 빌드 완료!"
echo ""
echo "다음 단계:"
echo "  python pipeline/run_pipeline.py --embodiment-tag my_robot --dataset-s3-uri s3://..."
