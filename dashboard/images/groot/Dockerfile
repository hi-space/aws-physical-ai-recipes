# Context: repository root. Actual N1.6.1 source; not the moving main/N1.7 branch.
FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends \
    git git-lfs build-essential ffmpeg libegl1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/groot-venv \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    PATH=/opt/groot-venv/bin:$PATH GR00T_HOME=/opt/groot HF_HOME=/tmp/hf
RUN git init /opt/groot && cd /opt/groot \
    && git remote add origin https://github.com/NVIDIA/Isaac-GR00T.git \
    && git fetch --depth 1 origin 5dc80c4afd726b34faad1d8f7e007a13b34e4c88 \
    && git checkout --detach FETCH_HEAD \
    && git submodule update --init --recursive \
    && uv python install 3.10.18 && uv sync --frozen --python 3.10.18 --no-dev \
    && uv pip install --python /opt/groot-venv/bin/python mlflow==2.22.0 sagemaker-mlflow==0.1.0 tensorboard==2.19.0
COPY hyperpod-training/configs/so101_modality.py /opt/recipes/groot/so101_modality.py
COPY dashboard/recipes /opt/recipes
WORKDIR /opt/groot
ENTRYPOINT []
CMD ["python", "/opt/recipes/groot/train.py", "--help"]
