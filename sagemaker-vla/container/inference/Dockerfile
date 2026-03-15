# =============================================================================
# GR00T-N1.6 SageMaker 추론 컨테이너
# =============================================================================
# Single-stage build: CUDA devel + Isaac-GR00T + flash-attn + FastAPI
#
# 포트: 8080 (/ping, /invocations)
# =============================================================================

FROM nvidia/cuda:12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/opt/gr00t:/opt/ml/code" \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    SAGEMAKER_BIND_TO_PORT=8080

# ---------------------------------------------------------------------------
# 시스템 의존성
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
    build-essential cmake ninja-build \
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
# PyTorch (CUDA 12.4)
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
    "torch==2.6.0" \
    "torchvision==0.21.0" \
    --index-url https://download.pytorch.org/whl/cu124

# ---------------------------------------------------------------------------
# Isaac-GR00T 클론 및 설치 (먼저 설치하여 의존성 확보)
# ---------------------------------------------------------------------------
WORKDIR /opt/gr00t
RUN git clone --recurse-submodules https://github.com/NVIDIA/Isaac-GR00T.git .

RUN uv pip install --system -e .

# ---------------------------------------------------------------------------
# flash-attn: GR00T 이후 강제 재설치 (소스 빌드, ABI 일치 보장)
# GR00T가 설치한 flash-attn을 덮어써서 현재 PyTorch ABI와 일치시킴
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir psutil ninja packaging && \
    pip install --no-cache-dir --force-reinstall --no-deps \
    "flash-attn==2.7.4.post1" --no-build-isolation && \
    python -c "import flash_attn; import flash_attn_2_cuda; print(f'flash-attn {flash_attn.__version__} + CUDA extension OK')"

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

# SageMaker는 추론 컨테이너를 `docker run <image> serve`로 실행합니다.
# ENTRYPOINT를 사용하지 않고 CMD만 사용하여 SageMaker의 `serve` 인자가
# 추가 인자로 전달되는 문제를 방지합니다.
RUN printf '#!/bin/bash\nexec uvicorn serve:app --host 0.0.0.0 --port 8080\n' > /usr/local/bin/serve && \
    chmod +x /usr/local/bin/serve

ENTRYPOINT []
CMD ["/usr/local/bin/serve"]
