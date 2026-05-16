#!/bin/bash
# Import GR00T container from ECR to Enroot on HyperPod
# Run this on the HyperPod head node after build_and_push_ecr.sh
#
# Usage:
#   bash import_container.sh [IMAGE_TAG] [AWS_REGION] [AWS_ACCOUNT_ID]
#
# Environment Variables:
#   IMAGE_TAG (optional): Docker image tag (default: latest)
#   AWS_REGION (optional): AWS region (default: auto-detect)
#   AWS_ACCOUNT_ID (optional): AWS account ID (default: auto-detect)
#   ENROOT_CACHE_PATH (optional): Enroot cache dir (default: /fsx/enroot)
#   ENROOT_DATA_PATH (optional): Enroot data dir (default: /fsx/enroot/data)

set -e

IMAGE_TAG="${1:-${IMAGE_TAG:-latest}}"

# Get AWS Region
if [ -n "$2" ]; then
    AWS_REGION="$2"
elif [ -z "${AWS_REGION}" ]; then
    TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s 2>/dev/null)
    AWS_REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
    AWS_REGION="${AWS_REGION:-us-east-1}"
fi

# Get AWS Account ID
if [ -n "$3" ]; then
    AWS_ACCOUNT_ID="$3"
elif [ -z "${AWS_ACCOUNT_ID}" ]; then
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
fi

if [ -z "${AWS_ACCOUNT_ID}" ]; then
    echo "ERROR: Could not determine AWS Account ID"
    exit 1
fi

ECR_REPOSITORY="gr00t-train"
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}"

ENROOT_CACHE_PATH="${ENROOT_CACHE_PATH:-/fsx/enroot}"
ENROOT_DATA_PATH="${ENROOT_DATA_PATH:-/fsx/enroot/data}"

echo "=================================================="
echo "GR00T Container - Enroot Import"
echo "=================================================="
echo "ECR Image: ${ECR_URI}"
echo "Enroot Data: ${ENROOT_DATA_PATH}"
echo ""

# Step 1: Setup directories
echo "[1/3] Setting up directories..."
mkdir -p "${ENROOT_CACHE_PATH}" "${ENROOT_DATA_PATH}" "${ENROOT_CACHE_PATH}/tmp"
export ENROOT_CACHE_PATH ENROOT_DATA_PATH
export TMPDIR="${ENROOT_CACHE_PATH}/tmp"

# Step 2: Import to Enroot from ECR
echo "[2/3] Importing from ECR to Enroot..."
CONTAINER_FILENAME="${ECR_REPOSITORY}+${IMAGE_TAG}.sqsh"
CONTAINER_PATH="${ENROOT_DATA_PATH}/${CONTAINER_FILENAME}"
if [ -f "${CONTAINER_PATH}" ]; then
    echo "  Removing existing container..."
    rm -f "${CONTAINER_PATH}"
fi

# Try dockerd:// (local Docker) first, fall back to docker:// (direct ECR pull)
if command -v docker &>/dev/null && docker image inspect "${ECR_URI}" > /dev/null 2>&1; then
    echo "  Importing from local Docker daemon..."
    enroot import -o "${CONTAINER_PATH}" "dockerd://${ECR_URI}"
else
    echo "  Importing directly from ECR (no local Docker)..."
    # Create credentials for enroot ECR access
    mkdir -p "${HOME}/.config/enroot"
    CREDENTIALS_FILE="${HOME}/.config/enroot/.credentials"
    ECR_TOKEN=$(aws ecr get-login-password --region "${AWS_REGION}")
    echo "machine ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com login AWS password ${ECR_TOKEN}" > "${CREDENTIALS_FILE}"
    chmod 600 "${CREDENTIALS_FILE}"
    enroot import -o "${CONTAINER_PATH}" "docker://${ECR_URI}"
    rm -f "${CREDENTIALS_FILE}"
fi
echo "  Import complete"

# Step 3: Verify
echo "[3/3] Verifying..."
if [ ! -f "${CONTAINER_PATH}" ]; then
    echo "  ERROR: Container not found at: ${CONTAINER_PATH}"
    exit 1
fi
CONTAINER_SIZE=$(du -h "${CONTAINER_PATH}" | cut -f1)
echo "  Container: ${CONTAINER_PATH}"
echo "  Size: ${CONTAINER_SIZE}"

echo ""
echo "=================================================="
echo "Container ready for SLURM jobs."
echo "Use in sbatch: --container-image=${CONTAINER_PATH}"
echo "=================================================="
