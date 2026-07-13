#!/bin/bash
# =============================================================================
# build-inference-image.sh
# Stage 5 (edge) — GR00T 추론 서버 Docker 이미지 빌드 + ECR 푸시
#
# com.aws.groot.inference 컴포넌트가 docker run 하는 이미지를 만든다.
# 엣지 디바이스는 이 이미지를 ECR 에서 pull 만 하면 되도록, 빌드는 여기서 미리
# 수행한다(디바이스에서 무거운 build 를 반복하지 않기 위함).
#
# 워크샵 setup-greengrass-workshop-N16.sh Step 3의 인라인 Dockerfile 을 일반화:
#   - 계정/리포/userId 하드코딩 제거 → 인자
#   - Isaac-GR00T 커밋을 --gr00t-commit 으로 파라미터화 (기본값은 워크샵 N1.6
#     안정 커밋; Stage 3에서 다른 커밋으로 학습했다면 그 커밋과 맞출 것)
#
# 베이스: nvcr.io/nvidia/pytorch:24.12-py3 (CUDA 12.4, py3.12, system TRT 10.7)
# 결과 ENTRYPOINT: python -m gr00t.eval.run_gr00t_server
#
# 사용법:
#   bash build-inference-image.sh --repo <NAME> --region <REGION> [옵션]
#
#   옵션:
#     --repo         <NAME>     (필수) ECR 리포지토리 이름 (예: groot-inference)
#     --region       <REGION>   (필수) AWS 리전
#     --tag          <TAG>      이미지 태그 (기본 latest)
#     --gr00t-commit <SHA>      Isaac-GR00T 체크아웃 커밋
#                               (기본 5dc80c4afd726b34faad1d8f7e007a13b34e4c88)
#     --no-push                 로컬 빌드만, ECR 푸시 생략
#
# 예:
#   bash build-inference-image.sh --repo groot-inference --region ap-northeast-2
# =============================================================================
set -euo pipefail

REPO=""
REGION=""
TAG="latest"
GR00T_COMMIT="5dc80c4afd726b34faad1d8f7e007a13b34e4c88"
PUSH="true"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)         REPO="$2"; shift 2 ;;
    --region)       REGION="$2"; shift 2 ;;
    --tag)          TAG="$2"; shift 2 ;;
    --gr00t-commit) GR00T_COMMIT="$2"; shift 2 ;;
    --no-push)      PUSH="false"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

if [ -z "$REGION" ]; then
  REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
fi
if [ -z "$REPO" ] || [ -z "$REGION" ]; then
  echo "ERROR: --repo 와 --region 은 필수입니다."
  exit 1
fi
export AWS_DEFAULT_REGION="$REGION"

LOCAL_IMAGE="groot-inference:${TAG}"

echo "============================================"
echo " GR00T 추론 이미지 빌드"
echo " Repo:         $REPO"
echo " Region:       $REGION"
echo " Tag:          $TAG"
echo " GR00T commit: $GR00T_COMMIT"
echo " Push:         $PUSH"
echo "============================================"

# ─── Dockerfile 생성 ─────────────────────────────────────────────────────────
BUILD_DIR="$(mktemp -d /tmp/groot-inference-build.XXXXXX)"
trap 'rm -rf "$BUILD_DIR"' EXIT

cat > "$BUILD_DIR/Dockerfile" << DKEOF
# Base: pytorch:24.12-py3 — CUDA 12.4, Python 3.12, system TRT 10.7
FROM nvcr.io/nvidia/pytorch:24.12-py3
ENV DEBIAN_FRONTEND=noninteractive
ENV NVIDIA_DRIVER_CAPABILITIES=graphics,utility,compute

RUN apt-get update && apt-get install -y git git-lfs ffmpeg wget curl && rm -rf /var/lib/apt/lists/*
RUN pip install uv

# torch + transformers 업그레이드 (N1.6 의 Qwen3 백본 지원에 필요)
RUN pip install --upgrade torch torchvision --index-url https://download.pytorch.org/whl/cu124
RUN pip install --upgrade transformers accelerate

# Isaac-GR00T — uv sync 가 나머지 의존성 + dataclass 호환을 처리
RUN git clone https://github.com/NVIDIA/Isaac-GR00T.git /workspace/gr00t-repo && \\
    cd /workspace/gr00t-repo && \\
    git checkout ${GR00T_COMMIT} && \\
    uv sync && uv pip install -e .

# ONNX export 의존성 (venv 생성 이후에 설치)
RUN uv pip install --python /workspace/gr00t-repo/.venv/bin/python onnxscript onnx onnxruntime

ENV VIRTUAL_ENV="/workspace/gr00t-repo/.venv"
ENV PATH="/workspace/gr00t-repo/.venv/bin:\${PATH}"
ENV PYTHONPATH="/workspace/gr00t-repo:/workspace"

# TRT fix: pip TRT(CUDA error 35 버그) 제거하고 system TRT 10.7 로 심볼릭 링크
RUN VENV_SP="/workspace/gr00t-repo/.venv/lib/python3.12/site-packages" && \\
    SYS_SP="/usr/local/lib/python3.12/dist-packages" && \\
    rm -rf \$VENV_SP/tensorrt \$VENV_SP/tensorrt_libs \$VENV_SP/tensorrt_bindings \\
           \$VENV_SP/tensorrt_cu12* \$VENV_SP/tensorrt-* \$VENV_SP/tensorrt_*.dist-info && \\
    ln -sf \$SYS_SP/tensorrt \$VENV_SP/tensorrt && \\
    [ -d \$SYS_SP/tensorrt_libs ] && ln -sf \$SYS_SP/tensorrt_libs \$VENV_SP/tensorrt_libs; \\
    [ -d \$SYS_SP/tensorrt_bindings ] && ln -sf \$SYS_SP/tensorrt_bindings \$VENV_SP/tensorrt_bindings; \\
    for f in \$SYS_SP/tensorrt-10.7*.dist-info \$SYS_SP/tensorrt_*10.7*.dist-info; do \\
      [ -e "\$f" ] && ln -sf "\$f" "\$VENV_SP/\$(basename \$f)"; \\
    done; \\
    python -c "import tensorrt as trt; print('TRT', trt.__version__)"

WORKDIR /workspace/gr00t-repo
ENV LD_LIBRARY_PATH="/usr/local/lib/python3.12/dist-packages/torch/lib:/usr/local/nvidia/lib:/usr/local/nvidia/lib64:\${LD_LIBRARY_PATH}"
ENTRYPOINT ["python", "-m", "gr00t.eval.run_gr00t_server"]
DKEOF

echo ">>> docker build ($LOCAL_IMAGE)"
docker build -t "$LOCAL_IMAGE" "$BUILD_DIR"

if [ "$PUSH" != "true" ]; then
  echo ""
  echo "로컬 빌드 완료: $LOCAL_IMAGE (푸시 생략)"
  exit 0
fi

# ─── ECR 푸시 ────────────────────────────────────────────────────────────────
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
FULL_IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" &>/dev/null || \
  aws ecr create-repository --repository-name "$REPO" --region "$REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null

aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

docker tag "$LOCAL_IMAGE" "$FULL_IMAGE"
docker push "$FULL_IMAGE"

echo ""
echo "============================================"
echo " 푸시 완료: $FULL_IMAGE"
echo "============================================"
echo " com.aws.groot.inference/recipe.yaml 의 ecrImage 를 위 값으로 설정하세요."
