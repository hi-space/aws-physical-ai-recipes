#!/bin/bash
# Build GR00T training container and push to ECR
#
# Prerequisites:
#   - Docker available on the node
#   - AWS CLI configured with ECR access
#
# Usage:
#   bash build_and_push_ecr.sh
#
# Environment Variables:
#   AWS_REGION (optional): AWS region (default: auto-detect from EC2 metadata)
#   AWS_ACCOUNT_ID (optional): AWS account ID (default: auto-detect from STS)
#   ECR_REPOSITORY (optional): ECR repository name (default: gr00t-train)
#   IMAGE_TAG (optional): Docker image tag (default: latest)

set -e

ECR_REPOSITORY="${ECR_REPOSITORY:-gr00t-train}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Get AWS Region (IMDSv2 → fallback)
if [ -z "${AWS_REGION}" ]; then
    TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s 2>/dev/null)
    AWS_REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
    AWS_REGION="${AWS_REGION:-us-east-1}"
fi

# Get AWS Account ID
if [ -z "${AWS_ACCOUNT_ID}" ]; then
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
fi

if [ -z "${AWS_ACCOUNT_ID}" ]; then
    echo "ERROR: Could not determine AWS Account ID"
    echo "Set AWS_ACCOUNT_ID environment variable or configure AWS CLI"
    exit 1
fi

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DOCKERFILE_PATH="${SCRIPT_DIR}/Dockerfile"

echo "=================================================="
echo "GR00T Training Container - Build & Push to ECR"
echo "=================================================="
echo "ECR: ${ECR_URI}:${IMAGE_TAG}"
echo "Dockerfile: ${DOCKERFILE_PATH}"
echo ""

# Step 1: Ensure ECR repository exists
echo "[1/4] Checking ECR repository..."
if ! aws ecr describe-repositories --repository-names "${ECR_REPOSITORY}" --region "${AWS_REGION}" > /dev/null 2>&1; then
    echo "  Creating ECR repository: ${ECR_REPOSITORY}"
    aws ecr create-repository \
        --repository-name "${ECR_REPOSITORY}" \
        --region "${AWS_REGION}" \
        --image-scanning-configuration scanOnPush=true
    echo "  Repository created"
else
    echo "  Repository exists"
fi

# Step 2: Authenticate Docker to ECR
echo "[2/4] Authenticating to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo "  Authentication successful"

# Step 3: Build Docker image
echo "[3/4] Building Docker image (this may take 20-30 minutes)..."
docker build \
    --platform linux/amd64 \
    -t "${ECR_REPOSITORY}:${IMAGE_TAG}" \
    -t "${ECR_URI}:${IMAGE_TAG}" \
    -f "${DOCKERFILE_PATH}" "${SCRIPT_DIR}"
echo "  Build complete"

# Step 4: Push to ECR
echo "[4/4] Pushing image to ECR..."
docker push "${ECR_URI}:${IMAGE_TAG}"
echo "  Push complete"

echo ""
echo "=================================================="
echo "Container ready: ${ECR_URI}:${IMAGE_TAG}"
echo "Next: Import to enroot on HyperPod cluster"
echo "  bash import_container.sh"
echo "=================================================="
