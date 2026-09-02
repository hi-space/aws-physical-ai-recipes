#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-groot-runtime-trt.sh
#
# Builds the Module 6 edge runtime image `groot-runtime-trt` and pushes it to the
# account's ECR. The image is a THIN layer on top of the Module 3 `groot-runtime`
# image (pytorch:25.04-py3, Python 3.12, system TensorRT 10.9) that adds the ONNX
# export deps and wires the venv to the container's system TensorRT.
#
# Why a separate image: Module 2 uses `groot-runtime` directly (PyTorch), so its
# provisioning runs with --skip-image-build and does NOT build this image. Module 6
# (ONNX export + TensorRT engine + TRT benchmark) needs the TRT/onnx tooling, so
# this image is built once here before deploying the Module 6 components.
#
# Usage:
#   sudo bash build-groot-runtime-trt.sh
#   (REGION defaults to $AWS_DEFAULT_REGION or the EC2 IMDS region; ACCOUNT_ID is
#    resolved from STS. Override by exporting REGION / ACCOUNT_ID.)
#
# Idempotent: if groot-runtime-trt:latest already exists in ECR it is left as-is.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="${REGION:-${AWS_DEFAULT_REGION:-}}"
if [ -z "$REGION" ]; then
  IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || echo "")
  REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "us-east-1")
fi
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"

ECR_REPO="groot-runtime-trt"
ECR_IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest"
RUNTIME_BASE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/groot-runtime:latest"

echo ">>> Building ${ECR_REPO} (region ${REGION}, account ${ACCOUNT_ID})"

# ECR repo + login
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" &>/dev/null || \
  aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Skip if already present
if aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag=latest --region "$REGION" &>/dev/null; then
  echo "   Image already in ECR: $ECR_IMAGE (skipping build)"
  exit 0
fi

# Base = the GR00T runtime image built by Module 3 (GrootFinetune CDK -> groot-runtime-build)
docker pull "$RUNTIME_BASE" || {
  echo "   ERROR: base image not found: $RUNTIME_BASE"
  echo "   Run Module 3 first to build the groot-runtime image."
  exit 1
}

BUILD_DIR="/tmp/groot-runtime-trt-build"
rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR"

# Thin TRT/ONNX layer (quoted heredoc = all literal; FROM base substituted after).
cat > "$BUILD_DIR/Dockerfile" << 'DKEOF'
FROM __RUNTIME_BASE__
# ONNX export deps (onnx itself is already present in groot-runtime)
RUN uv pip install --python /workspace/gr00t-repo/.venv/bin/python onnxscript onnxruntime
# TRT fix: drop the venv's buggy pip TensorRT (10.16, CUDA-init error 35) and use
# the container's system TensorRT (10.9) via symlink, then verify the import.
RUN VENV_SP="/workspace/gr00t-repo/.venv/lib/python3.12/site-packages" && \
    SYS_SP="/usr/local/lib/python3.12/dist-packages" && \
    rm -rf $VENV_SP/tensorrt $VENV_SP/tensorrt_libs $VENV_SP/tensorrt_bindings \
           $VENV_SP/tensorrt-*.dist-info $VENV_SP/tensorrt_cu1* && \
    ln -sf $SYS_SP/tensorrt $VENV_SP/tensorrt && \
    for d in $SYS_SP/tensorrt-*.dist-info; do ln -sf "$d" "$VENV_SP/$(basename $d)"; done && \
    /workspace/gr00t-repo/.venv/bin/python -c "import tensorrt as trt; print('venv TRT', trt.__version__)"
DKEOF
sed -i "s|__RUNTIME_BASE__|${RUNTIME_BASE}|" "$BUILD_DIR/Dockerfile"

docker build -t "${ECR_REPO}:latest" "$BUILD_DIR"
docker tag "${ECR_REPO}:latest" "$ECR_IMAGE"
docker push "$ECR_IMAGE"
rm -rf "$BUILD_DIR"
echo "   ✅ Image pushed: $ECR_IMAGE"
