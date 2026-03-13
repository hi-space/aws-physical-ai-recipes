# =============================================================================
# GR00T-N1.6 SageMaker 추론 컨테이너 (Multi-stage build)
# =============================================================================
# Stage 1 (builder): flash-attn 사전 컴파일 (CUDA devel 툴킷 필요)
# Stage 2 (runtime): 경량 CUDA runtime + FastAPI 추론 서버
#
# 포트: 8080 (/ping, /invocations)
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Builder — flash-attn 컴파일
# ---------------------------------------------------------------------------
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git wget curl ca-certificates build-essential cmake ninja-build \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

RUN add-apt-repository ppa:deadsnakes/ppa && \
    apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3.10-dev python3.10-venv python3.10-distutils \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1 && \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1

RUN curl -sS https://bootstrap.pypa.io/get-pip.py | python3.10

# PyTorch (flash-attn 빌드 의존성)
RUN pip install --no-cache-dir \
    "torch==2.6.0" \
    --index-url https://download.pytorch.org/whl/cu124

# flash-attn 사전 빌드 wheel 설치
RUN pip install --no-cache-dir flash-attn --no-build-isolation \
    --find-links https://github.com/Dao-AILab/flash-attention/releases/expanded_assets/v2.7.4.post1


# ---------------------------------------------------------------------------
# Stage 2: Runtime — 경량 추론 서버
# ---------------------------------------------------------------------------
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/opt/gr00t:/opt/ml/code" \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    SAGEMAKER_BIND_TO_PORT=8080

# ---------------------------------------------------------------------------
# 시스템 의존성 (Java 불필요 — FastAPI 사용)
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    software-properties-common \
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
RUN pip install --no-cache-dir uv

# ---------------------------------------------------------------------------
# PyTorch + uv (Isaac-GR00T 설치에 사용)
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
    "torch==2.6.0" \
    "torchvision==0.21.0" \
    --index-url https://download.pytorch.org/whl/cu124

# ---------------------------------------------------------------------------
# flash-attn: builder stage에서 복사 (재컴파일 불필요)
# ---------------------------------------------------------------------------
COPY --from=builder \
    /usr/local/lib/python3.10/dist-packages/flash_attn \
    /usr/local/lib/python3.10/dist-packages/flash_attn

COPY --from=builder \
    /usr/local/lib/python3.10/dist-packages/flash_attn-2.7.4.post1.dist-info \
    /usr/local/lib/python3.10/dist-packages/flash_attn-2.7.4.post1.dist-info

# ---------------------------------------------------------------------------
# Isaac-GR00T 클론 및 추론 의존성 설치 (학습 extras 제외)
# ---------------------------------------------------------------------------
WORKDIR /opt/gr00t
RUN git clone --recurse-submodules https://github.com/NVIDIA/Isaac-GR00T.git .

RUN uv pip install --system -e .

# ---------------------------------------------------------------------------
# FastAPI 추론 서버 의존성
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
    "fastapi==0.115.0" \
    "uvicorn[standard]==0.30.0" \
    "pillow>=10.0.0"

# ---------------------------------------------------------------------------
# 추론 서버 복사
# ---------------------------------------------------------------------------
RUN mkdir -p /opt/ml/model /opt/ml/code
COPY container/inference/serve.py /opt/ml/code/serve.py

EXPOSE 8080
WORKDIR /opt/ml/code

ENTRYPOINT ["uvicorn", "serve:app", "--host", "0.0.0.0", "--port", "8080"]
