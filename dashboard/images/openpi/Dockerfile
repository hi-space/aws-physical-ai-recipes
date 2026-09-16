# Context: repository root. Locks upstream source/dependencies at build time.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends \
    git git-lfs ffmpeg build-essential clang ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/openpi-venv \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    PATH=/opt/openpi-venv/bin:$PATH HF_HOME=/tmp/hf XLA_PYTHON_CLIENT_MEM_FRACTION=0.9
RUN git init /opt/openpi && cd /opt/openpi \
    && git remote add origin https://github.com/Physical-Intelligence/openpi.git \
    && git fetch --depth 1 origin 215abfb217dbac7d5f1273282331b9b1866c0479 \
    && git checkout --detach FETCH_HEAD \
    && GIT_LFS_SKIP_SMUDGE=1 git submodule update --init --recursive \
    && uv python install 3.11.13 \
    && GIT_LFS_SKIP_SMUDGE=1 uv sync --frozen --python 3.11.13 --no-dev
COPY dashboard/recipes /opt/recipes
WORKDIR /opt/openpi
CMD ["python", "/opt/recipes/openpi/train.py", "--help"]
