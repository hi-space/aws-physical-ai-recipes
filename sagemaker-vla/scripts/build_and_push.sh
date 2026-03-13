#!/usr/bin/env bash
# =============================================================================
# build_and_push.sh
#
# GR00T-N1.6 SageMaker 컨테이너 빌드 및 ECR 푸시 스크립트
# Training 또는 Inference 컨테이너를 빌드하고 Amazon ECR에 푸시한다.
#
# Requirements: 1.3, 1.5
# =============================================================================

set -e

# ---------------------------------------------------------------------------
# 색상 정의
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# 유틸리티 함수
# ---------------------------------------------------------------------------
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ---------------------------------------------------------------------------
# 사용법 출력
# ---------------------------------------------------------------------------
usage() {
    cat <<EOF
Usage: $(basename "$0") --type <training|inference> [--account-id <AWS_ACCOUNT_ID>] [--region <REGION>]

Build a GR00T-N1.6 Docker container and push it to Amazon ECR.

Required arguments:
  --type        Container type: "training" or "inference"

Optional arguments:
  --account-id  AWS account ID (default: auto-detect from aws sts get-caller-identity)
  --region      AWS region (default: auto-detect from aws configure)
  -h, --help    Show this help message

Examples:
  $(basename "$0") --type training
  $(basename "$0") --type inference --region ap-northeast-2
  $(basename "$0") --type training --account-id 123456789012 --region us-east-1
EOF
    exit 0
}

# ---------------------------------------------------------------------------
# 인자 파싱
# ---------------------------------------------------------------------------
TYPE=""
REGION=""
ACCOUNT_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --type)
            TYPE="$2"; shift 2 ;;
        --region)
            REGION="$2"; shift 2 ;;
        --account-id)
            ACCOUNT_ID="$2"; shift 2 ;;
        -h|--help)
            usage ;;
        *)
            error "Unknown argument: $1\nRun '$(basename "$0") --help' for usage." ;;
    esac
done

# ---------------------------------------------------------------------------
# 인자 유효성 검증
# ---------------------------------------------------------------------------
if [[ -z "$TYPE" ]]; then
    error "--type is required. Must be 'training' or 'inference'."
fi

if [[ "$TYPE" != "training" && "$TYPE" != "inference" ]]; then
    error "Invalid --type '$TYPE'. Must be 'training' or 'inference'."
fi

# ---------------------------------------------------------------------------
# AWS 기본값 자동 감지 (미지정 시 aws configure 설정 사용)
# ---------------------------------------------------------------------------
if [[ -z "$REGION" ]]; then
    REGION=$(aws configure get region 2>/dev/null || echo "")
    if [[ -z "$REGION" ]]; then
        error "리전을 감지할 수 없습니다. --region을 지정하거나 'aws configure'를 실행하세요."
    fi
    info "리전 자동 감지: ${REGION}"
fi

if [[ -z "$ACCOUNT_ID" ]]; then
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
    if [[ -z "$ACCOUNT_ID" ]]; then
        error "AWS 계정 ID를 감지할 수 없습니다. --account-id를 지정하거나 AWS 자격증명을 확인하세요."
    fi
    info "계정 ID 자동 감지: ${ACCOUNT_ID}"
fi

if ! [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    error "Invalid account ID '$ACCOUNT_ID'. Must be a 12-digit AWS account ID."
fi

# ---------------------------------------------------------------------------
# 변수 설정
# ---------------------------------------------------------------------------
REPO_NAME="groot-n16-${TYPE}"
IMAGE_TAG="latest"
FULL_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}:${IMAGE_TAG}"
DOCKERFILE="docker/Dockerfile.${TYPE}"

info "============================================"
info "GR00T-N1.6 Container Build & Push"
info "============================================"
info "Type:        ${TYPE}"
info "Region:      ${REGION}"
info "Account ID:  ${ACCOUNT_ID}"
info "Repository:  ${REPO_NAME}"
info "Image Tag:   ${IMAGE_TAG}"
info "Full URI:    ${FULL_URI}"
info "Dockerfile:  ${DOCKERFILE}"
info "============================================"

# Dockerfile 존재 확인
if [[ ! -f "$DOCKERFILE" ]]; then
    error "Dockerfile not found: ${DOCKERFILE}\nMake sure you run this script from the sagemaker-vla/ directory."
fi

# ---------------------------------------------------------------------------
# Step 1: ECR 인증
# ---------------------------------------------------------------------------
info "Step 1/5: Authenticating Docker to ECR..."
aws ecr get-login-password --region "${REGION}" \
    | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
success "ECR authentication successful."

# ---------------------------------------------------------------------------
# Step 2: ECR 리포지토리 생성 (이미 존재하면 무시)
# ---------------------------------------------------------------------------
info "Step 2/5: Creating ECR repository '${REPO_NAME}' (if not exists)..."
aws ecr create-repository \
    --repository-name "${REPO_NAME}" \
    --region "${REGION}" 2>/dev/null || warn "Repository '${REPO_NAME}' already exists — skipping creation."
success "ECR repository ready."

# ---------------------------------------------------------------------------
# Step 3: Docker 이미지 빌드
# ---------------------------------------------------------------------------
info "Step 3/5: Building Docker image..."
docker build -f "${DOCKERFILE}" -t "${REPO_NAME}:${IMAGE_TAG}" .
success "Docker image built: ${REPO_NAME}:${IMAGE_TAG}"

# ---------------------------------------------------------------------------
# Step 4: 이미지 태그
# ---------------------------------------------------------------------------
info "Step 4/5: Tagging image for ECR..."
docker tag "${REPO_NAME}:${IMAGE_TAG}" "${FULL_URI}"
success "Image tagged: ${FULL_URI}"

# ---------------------------------------------------------------------------
# Step 5: ECR에 푸시
# ---------------------------------------------------------------------------
info "Step 5/5: Pushing image to ECR..."
docker push "${FULL_URI}"
success "Image pushed successfully!"

# ---------------------------------------------------------------------------
# 완료 메시지 및 사용 안내
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} Build & Push Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "Image URI (use this in SageMaker scripts):"
echo -e "  ${BLUE}${FULL_URI}${NC}"
echo ""
echo -e "Next steps:"
echo -e "  1. Use this image URI in your SageMaker training or deployment scripts."
echo ""
if [[ "$TYPE" == "training" ]]; then
    echo -e "  ${YELLOW}Training example:${NC}"
    echo -e "    python scripts/launch_training.py \\"
    echo -e "      --image-uri ${FULL_URI} \\"
    echo -e "      --base-model-s3-uri s3://your-bucket/models/groot-n16 \\"
    echo -e "      --dataset-s3-uri s3://your-bucket/datasets/your-dataset \\"
    echo -e "      --output-s3-uri s3://your-bucket/output"
else
    echo -e "  ${YELLOW}Deployment example:${NC}"
    echo -e "    python scripts/deploy_endpoint.py \\"
    echo -e "      --image-uri ${FULL_URI} \\"
    echo -e "      --model-s3-uri s3://your-bucket/output/model.tar.gz \\"
    echo -e "      --endpoint-name groot-n16-endpoint"
fi
echo ""
