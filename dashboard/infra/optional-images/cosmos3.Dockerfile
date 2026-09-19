# Optional only: the caller must supply inspected immutable base/tool images
# (COSMOS3_BASE_IMAGE = digest-pinned nvcr.io/nvidia/cuda 12.8 cudnn-devel; UV_IMAGE = digest-pinned ghcr.io/astral-sh/uv).
ARG COSMOS3_BASE_IMAGE
ARG UV_IMAGE
FROM ${UV_IMAGE} AS uv
FROM ${COSMOS3_BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg git git-lfs wget \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/cosmos3-venv \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    PATH=/opt/cosmos3-venv/bin:$PATH HF_HOME=/tmp/hf \
    TRITON_PTXAS_PATH=/usr/local/cuda/bin/ptxas
RUN git init /opt/cosmos-framework && cd /opt/cosmos-framework \
    && git remote add origin https://github.com/NVIDIA/cosmos-framework.git \
    && git fetch --depth 1 origin c23e51f2f157ae3e51cfcd86ebfb5464850894f2 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = c23e51f2f157ae3e51cfcd86ebfb5464850894f2 \
    && uv python install \
    && uv sync --locked --no-editable --all-extras --group=cu128 \
    && uv pip install --python /opt/cosmos3-venv/bin/python imageio==2.37.0 imageio-ffmpeg==0.6.0 \
    && rm -rf /root/.cache/uv
COPY dashboard/recipes /opt/recipes
WORKDIR /opt/cosmos-framework
ENTRYPOINT []
