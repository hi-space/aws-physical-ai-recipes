# Optional only: the caller must supply inspected immutable base/tool images.
ARG COSMOS_BASE_IMAGE
ARG UV_IMAGE
FROM ${UV_IMAGE} AS uv
FROM ${COSMOS_BASE_IMAGE}
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/cosmos-venv \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    PATH=/opt/cosmos-venv/bin:$PATH HF_HOME=/tmp/hf
RUN git init /opt/cosmos && cd /opt/cosmos \
    && git remote add origin https://github.com/nvidia-cosmos/cosmos-transfer2.5.git \
    && git fetch --depth 1 origin 0033b77a9e41e74f9d8d0b9cf80e0ecf94b3533b \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 0033b77a9e41e74f9d8d0b9cf80e0ecf94b3533b \
    && git submodule update --init --recursive \
    && uv sync --frozen --extra=cu128 \
    && uv pip install --python /opt/cosmos-venv/bin/python imageio==2.37.0 imageio-ffmpeg==0.6.0
COPY dashboard/recipes /opt/recipes
WORKDIR /opt/cosmos
ENTRYPOINT []
