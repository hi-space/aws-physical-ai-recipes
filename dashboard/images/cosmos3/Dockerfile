# Cosmos 3 (Edge / Nano) inference image: pinned NVIDIA cosmos-framework release 2026-09-18.
# Mirrors the upstream Dockerfile (nvidia/cuda cudnn-devel base, uv-managed Python 3.13, `uv sync --locked`)
# on the CUDA 12.8 wheel group so it matches the HyperPod node drivers used by the other GPU images.
# Reference build; the deployable variant is dashboard/infra/optional-images/cosmos3.Dockerfile with
# digest-pinned base/uv images supplied through the CDK `optionalImages.cosmos3` context.
FROM nvcr.io/nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg git git-lfs wget \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.2 /uv /uvx /usr/local/bin/
ENV UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/cosmos3-venv \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    PATH=/opt/cosmos3-venv/bin:$PATH HF_HOME=/tmp/hf \
    TRITON_PTXAS_PATH=/usr/local/cuda/bin/ptxas
RUN git init /opt/cosmos-framework && cd /opt/cosmos-framework \
    && git remote add origin https://github.com/NVIDIA/cosmos-framework.git \
    && git fetch --depth 1 origin c23e51f2f157ae3e51cfcd86ebfb5464850894f2 \
    && git checkout --detach FETCH_HEAD \
    && uv python install \
    && uv sync --locked --no-editable --all-extras --group=cu128 \
    && uv pip install --python /opt/cosmos3-venv/bin/python imageio==2.37.0 imageio-ffmpeg==0.6.0 \
    && rm -rf /root/.cache/uv
COPY dashboard/recipes /opt/recipes
WORKDIR /opt/cosmos-framework
ENTRYPOINT []
