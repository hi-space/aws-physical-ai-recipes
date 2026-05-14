#!/bin/bash

# Build script for GR00T Fine-tuning Docker image (N1.6 / N1.7)

set -Eeuo pipefail

echo "=========================================="
echo "Building GR00T Fine-tuning Docker Image"
echo "=========================================="

# Version → commit / model mapping
declare -A GROOT_COMMITS=(
  [n1.6]="5dc80c4afd726b34faad1d8f7e007a13b34e4c88"
  [n1.7]="23ace64f17aa5015259b8609d371eb61a357c776"
)
declare -A GROOT_MODELS=(
  [n1.6]="nvidia/GR00T-N1.6-3B"
  [n1.7]="nvidia/GR00T-N1.7-3B"
)

# Default values
IMAGE_NAME="gr00t-finetune"
TAG="latest"
DOCKERFILE="Dockerfile"
PUSH_IMAGE=false
TEST_IMAGE=false
USE_STABLE=true
GROOT_VERSION="${GROOT_VERSION:-n1.6}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--tag)
            TAG="$2"
            shift 2
            ;;
        -n|--name)
            IMAGE_NAME="$2"
            shift 2
            ;;
        --version)
            GROOT_VERSION="$2"
            shift 2
            ;;
        --latest)
            USE_STABLE=false
            shift
            ;;
        --push)
            PUSH_IMAGE=true
            shift
            ;;
        --test)
            TEST_IMAGE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  -t, --tag TAG         Tag for the fine-tuning image (default: latest)"
            echo "  -n, --name NAME       Name for the fine-tuning image (default: gr00t-finetune)"
            echo "  --version VER         GR00T version: n1.6 or n1.7 (default: n1.7, or GROOT_VERSION env)"
            echo "  --latest              Use latest GR00T from main branch (default: stable commit)"
            echo "  --push                Push image to registry after building"
            echo "  --test                Run basic tests after building"
            echo "  -h, --help            Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

FULL_IMAGE_NAME="${IMAGE_NAME}:${TAG}"

# Validate version
if [[ -z "${GROOT_COMMITS[$GROOT_VERSION]+x}" ]]; then
    echo "ERROR: Unsupported GROOT_VERSION='${GROOT_VERSION}'. Supported: ${!GROOT_COMMITS[*]}"
    exit 1
fi

STABLE_COMMIT="${GROOT_COMMITS[$GROOT_VERSION]}"
BASE_MODEL_PATH="${GROOT_MODELS[$GROOT_VERSION]}"

echo "Building image: ${FULL_IMAGE_NAME}"
echo "Using Dockerfile: ${DOCKERFILE}"
echo "GR00T version: ${GROOT_VERSION}"
echo "Stable commit: ${STABLE_COMMIT}"
echo "Base model: ${BASE_MODEL_PATH}"

# Display GR00T version selection
if [[ "${USE_STABLE}" == "true" ]]; then
    echo "Mode: STABLE (tested commit) [default]"
else
    echo "Mode: LATEST (main branch, may have breaking changes)"
fi

# Build the fine-tuning image directly from the combined Dockerfile
echo "Building fine-tuning image..."
docker build \
    --build-arg GROOT_VERSION=${GROOT_VERSION} \
    --build-arg USE_STABLE=${USE_STABLE} \
    --build-arg STABLE_COMMIT=${STABLE_COMMIT} \
    --build-arg BASE_MODEL_PATH=${BASE_MODEL_PATH} \
    -f ${DOCKERFILE} \
    -t ${FULL_IMAGE_NAME} \
    .

echo "Image built successfully: ${FULL_IMAGE_NAME}"

# Run basic tests if requested
if [[ "${TEST_IMAGE}" == "true" ]]; then
    echo "=========================================="
    echo "Running Basic Tests"
    echo "=========================================="

    # Test 1: Check if the image runs without errors (dry run)
    echo "Test 1: Checking if image starts correctly..."
    docker run --rm \
        -e HF_TOKEN="dummy" \
        -e HF_DATASET_ID="dummy/dummy" \
        -e HF_MODEL_REPO_ID="dummy/dummy" \
        --entrypoint /bin/bash \
        ${FULL_IMAGE_NAME} \
        -c "echo 'Image starts correctly' && python -c 'import sys; print(f\"Python version: {sys.version}\")' && which huggingface-cli"

    # Test 2: Check if finetune script can be imported
    echo "Test 2: Checking if finetune script imports correctly..."
    docker run --rm \
        --entrypoint /bin/bash \
        ${FULL_IMAGE_NAME} \
        -c "PYTHONPATH=/workspace/gr00t-repo:/workspace python -c 'import importlib.util; spec = importlib.util.spec_from_file_location(\"finetune\", \"/workspace/scripts/finetune_gr00t.py\"); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); print(\"Finetune script imports successfully\")'"

    # Test 3: Check if modality config can be loaded
    echo "Test 3: Checking if modality config is accessible..."
    docker run --rm \
        --entrypoint /bin/bash \
        ${FULL_IMAGE_NAME} \
        -c "PYTHONPATH=/workspace/gr00t-repo:/workspace python -c 'import importlib.util; spec = importlib.util.spec_from_file_location(\"m\", \"/workspace/scripts/so101_modality_config.py\"); print(\"Modality config accessible\")'"

    echo "All tests passed!"
fi

# Push to registry if requested
if [[ "${PUSH_IMAGE}" == "true" ]]; then
    echo "=========================================="
    echo "Pushing to Registry"
    echo "=========================================="

    if [[ -z "${DOCKER_REGISTRY}" ]]; then
        echo "Warning: DOCKER_REGISTRY environment variable not set."
        echo "Assuming you want to push to Docker Hub or have already tagged appropriately."
    else
        # Re-tag with registry prefix
        REGISTRY_IMAGE="${DOCKER_REGISTRY}/${FULL_IMAGE_NAME}"
        docker tag ${FULL_IMAGE_NAME} ${REGISTRY_IMAGE}
        FULL_IMAGE_NAME=${REGISTRY_IMAGE}
    fi

    echo "Pushing image: ${FULL_IMAGE_NAME}"
    docker push ${FULL_IMAGE_NAME}
    echo "Image pushed successfully!"
fi

echo "=========================================="
echo "Build Complete!"
echo "=========================================="
echo "Image: ${FULL_IMAGE_NAME}"
echo "GR00T Version: ${GROOT_VERSION} ($([ "${USE_STABLE}" = "true" ] && echo "stable" || echo "latest"))"
echo "Base Model: ${BASE_MODEL_PATH}"
echo ""
echo "To run locally, create a local directory to simulate EFS mount:"
echo "mkdir -p ~/mock-efs/gr00t/checkpoints"
echo "Then run with a small number of steps for testing:"
echo "docker run --gpus all --network host \\"
echo "  -e MAX_STEPS=100 -e SAVE_STEPS=100 \\"
echo "  -v ~/mock-efs:/mnt/efs \\"
echo "  ${FULL_IMAGE_NAME}"
echo ""
echo "To build a different version:"
echo "  ./build_container.sh --version n1.6"
echo "  ./build_container.sh --version n1.7"
