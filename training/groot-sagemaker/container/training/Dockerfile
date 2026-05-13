# =============================================================================
# GR00T-N1.6 SageMaker 학습 컨테이너
# =============================================================================
# Base: CUDA 12.4.1 devel (flash-attn 컴파일에 전체 툴킷 필요)
# 포함: Python 3.10, PyTorch 2.6, flash-attn 2.7, Isaac-GR00T
# 엔트리포인트: train.py (SageMaker 학습 엔트리포인트)
# =============================================================================

FROM nvcr.io/nvidia/cuda:12.4.1-devel-ubuntu22.04

# ---------------------------------------------------------------------------
# 빌드 시점 선택: GR00T 버전과 stable commit 핀
# ---------------------------------------------------------------------------
ARG GROOT_VERSION=n1.6
ARG USE_STABLE=true
# n1.6: https://github.com/NVIDIA/Isaac-GR00T/releases/tag/n1.6.1-release
# n1.7: https://github.com/NVIDIA/Isaac-GR00T/releases/tag/n1.7-release
ARG STABLE_COMMIT=5dc80c4afd726b34faad1d8f7e007a13b34e4c88
ARG BASE_MODEL_PATH=nvidia/GR00T-N1.6-3B

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/opt/gr00t:/opt/ml/code" \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

# ---------------------------------------------------------------------------
# 시스템 의존성
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    git-lfs \
    wget \
    curl \
    ca-certificates \
    build-essential \
    cmake \
    ninja-build \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    software-properties-common \
    ffmpeg \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswscale-dev \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Python 3.10
# ---------------------------------------------------------------------------
RUN add-apt-repository ppa:deadsnakes/ppa && \
    apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3.10-dev python3.10-venv python3.10-distutils \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1 && \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1

RUN curl -sS https://bootstrap.pypa.io/get-pip.py | python3.10

# ---------------------------------------------------------------------------
# uv (빠른 Python 패키지 관리자)
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir uv

# ---------------------------------------------------------------------------
# PyTorch 2.6 + CUDA 12.4
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
    "torch==2.6.0" \
    "torchvision==0.21.0" \
    "torchaudio==2.6.0" \
    --index-url https://download.pytorch.org/whl/cu124

# ---------------------------------------------------------------------------
# flash-attn (사전 빌드 wheel 사용 — 소스 컴파일 20분 절약)
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir psutil && \
    pip install --no-cache-dir flash-attn --no-build-isolation \
    --find-links https://github.com/Dao-AILab/flash-attention/releases/expanded_assets/v2.7.4.post1

# ---------------------------------------------------------------------------
# Isaac-GR00T 클론 및 학습 의존성 설치
# ---------------------------------------------------------------------------
WORKDIR /opt/gr00t
RUN git clone --recurse-submodules https://github.com/NVIDIA/Isaac-GR00T.git . && \
    if [ "${USE_STABLE}" = "true" ]; then \
        echo "Using stable commit: ${STABLE_COMMIT}" && \
        git checkout ${STABLE_COMMIT} && \
        git submodule update --init --recursive; \
    else \
        echo "Using latest from main branch"; \
    fi && \
    echo "GR00T version info:" && \
    git log -1 --format="%H %ai %s"

RUN uv pip install --system -e ".[train]"

# ---------------------------------------------------------------------------
# torchcodec (AV1 코덱 비디오 디코딩에 필요)
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir torchcodec

# ---------------------------------------------------------------------------
# SageMaker Training Toolkit (Script Mode 지원)
# ---------------------------------------------------------------------------
# entry_point/source_dir를 Estimator에서 지정하면 런타임에 스크립트를 주입.
# Docker 재빌드 없이 train.py 수정사항을 즉시 반영할 수 있음.
RUN pip install --no-cache-dir sagemaker-training

# ---------------------------------------------------------------------------
# MLflow + sagemaker-mlflow auth plugin
# ---------------------------------------------------------------------------
# MLFLOW_TRACKING_URI가 SageMaker MLflow ARN으로 설정되면 sagemaker-mlflow가
# SigV4 인증을 자동 처리. HF Trainer는 mlflow가 설치되어 있고 URI가 있으면
# MLflowCallback을 자동 활성화하여 metric/param/artifact를 로깅.
# --ignore-installed blinker: Ubuntu 22.04 base의 distutils-installed blinker 1.4를
# 안전 제거하지 못해 mlflow→Flask 설치가 실패하므로 우회.
RUN pip install --no-cache-dir --ignore-installed blinker mlflow sagemaker-mlflow

# ---------------------------------------------------------------------------
# SageMaker 디렉토리 구조
# ---------------------------------------------------------------------------
RUN mkdir -p /opt/ml/model /opt/ml/input/data /opt/ml/output /opt/ml/code

WORKDIR /opt/ml/code

# Default base model path (overridable by SM_HP_BASE_MODEL_PATH at runtime)
ENV BASE_MODEL_PATH=${BASE_MODEL_PATH}
ENV GROOT_VERSION=${GROOT_VERSION}
