#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build_runtime_image.sh
#
# Builds the GR00T runtime image `groot-runtime` on the GPU workstation (DCV /
# code-server instance, personal profile) and pushes it to the account's ECR
# repository created by the GrootFinetune stack. Modules 2, 3 (§3.5-3.7), 5 and 6
# run the Policy Server / Greengrass inference from this image.
#
# Why here and not in CodeBuild: the image (~27GB) is only useful where there is
# a GPU. The workshop-studio profile (CPU workstation) skips every module that
# needs it, so the stack no longer spends 30-40 minutes of CodeBuild on it at
# deploy time. The workstation has Docker, the instance role and a 500GB disk.
#
# Usage (code-server terminal):
#   cd ~/aws-physical-ai-recipes/e2e-workshop/infra/groot/assets
#   ./build_runtime_image.sh                 # build + push groot-runtime:latest (skips if present)
#   ./build_runtime_image.sh --force         # rebuild even if the tag already exists in ECR
#   GROOT_VERSION=n1.7 ./build_runtime_image.sh --force   # other GR00T version
#   nohup ./build_runtime_image.sh > ~/groot-runtime-build.log 2>&1 &   # background
#
# Env: REGION / ACCOUNT_ID (auto-resolved from IMDS / STS), GROOT_VERSION (n1.6),
#      USE_STABLE (true), IMAGE_TAG (latest), ECR_REPO (groot-runtime).
# Takes about 30 minutes on a g6e.4xlarge. Idempotent unless --force.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GROOT_VERSION="${GROOT_VERSION:-n1.6}"
USE_STABLE="${USE_STABLE:-true}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ECR_REPO="${ECR_REPO:-groot-runtime}"

REGION="${REGION:-${AWS_DEFAULT_REGION:-}}"
if [ -z "$REGION" ]; then
  IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || echo "")
  REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)
  REGION="${REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
fi
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"

REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ECR_IMAGE="${REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

echo ">>> groot-runtime build (region ${REGION}, account ${ACCOUNT_ID})"
echo "    GR00T ${GROOT_VERSION} ($([ "$USE_STABLE" = "true" ] && echo stable || echo latest)) -> ${ECR_IMAGE}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found. Run this on the workstation (DCV / code-server instance)." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: cannot talk to the Docker daemon. Try: sudo usermod -aG docker \$USER && newgrp docker" >&2
  exit 1
fi

# ECR repo is created by the GrootFinetune stack; create it only if that stack is not there.
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 || {
  echo "    ECR repository ${ECR_REPO} not found — creating it (GrootFinetune stack not deployed?)"
  aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null
}
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
echo "    ECR login OK"

if [ "$FORCE" != "true" ] && \
   aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$IMAGE_TAG" --region "$REGION" >/dev/null 2>&1; then
  echo "    Image already in ECR: ${ECR_IMAGE} (skipping; use --force to rebuild)"
  exit 0
fi

AVAIL_GB=$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
if [ -n "$AVAIL_GB" ] && [ "$AVAIL_GB" -lt 80 ]; then
  echo "WARNING: only ${AVAIL_GB}GB free under /var/lib/docker; the build needs ~80GB. 'docker system prune -a' may help." >&2
fi

# Build with the same script CodeBuild used (build_container.sh, Dockerfile in this directory).
cd "$SCRIPT_DIR"
BUILD_ARGS=(--version "$GROOT_VERSION" -n "$ECR_REPO" -t "$IMAGE_TAG")
[ "$USE_STABLE" = "true" ] || BUILD_ARGS+=(--latest)
echo ">>> docker build (about 30 minutes)..."
GROOT_VERSION="$GROOT_VERSION" ./build_container.sh "${BUILD_ARGS[@]}"

echo ">>> pushing ${ECR_IMAGE}"
docker tag "${ECR_REPO}:${IMAGE_TAG}" "$ECR_IMAGE"
docker push "$ECR_IMAGE"

echo ">>> done: ${ECR_IMAGE}"
aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$IMAGE_TAG" --region "$REGION" \
  --query 'imageDetails[0].{Tags:imageTags,PushedAt:imagePushedAt,SizeBytes:imageSizeInBytes}' --output table
