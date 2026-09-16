# Build from repository root. Workload source and robot assets are image contents.
FROM python:3.11.13-slim-bookworm
ARG RECIPE_SOURCE_REVISION=local
LABEL org.opencontainers.image.title="Physical AI SO-101 MuJoCo PPO" \
      org.opencontainers.image.revision="${RECIPE_SOURCE_REVISION}"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MUJOCO_GL=osmesa \
    MUJOCO_MENAGERIE_DIR=/opt/mujoco_menagerie OMP_NUM_THREADS=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    RECIPE_SOURCE_REVISION=${RECIPE_SOURCE_REVISION}
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates libosmesa6 libgl1 libglib2.0-0 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY dashboard/images/mujoco/requirements.txt /opt/requirements.txt
RUN pip install --no-cache-dir torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r /opt/requirements.txt
RUN git init /opt/mujoco_menagerie \
    && cd /opt/mujoco_menagerie \
    && git remote add origin https://github.com/google-deepmind/mujoco_menagerie.git \
    && git config core.sparseCheckout true \
    && echo robotstudio_so101/ > .git/info/sparse-checkout \
    && git fetch --depth 1 --filter=blob:none origin ac6b2b09983786f3036cab1000221017fa2193b4 \
    && git checkout --detach FETCH_HEAD \
    && rm -rf .git
COPY hyperpod-training/mujoco-workshop /opt/mujoco-workshop
RUN pip install --no-cache-dir --no-deps /opt/mujoco-workshop
COPY e2e-workshop/groot/training/data/convert_v3_to_v2.py /opt/recipes/data/convert_v3_to_v2.py
COPY dashboard/recipes /opt/recipes
RUN useradd --uid 10001 --create-home researcher
USER 10001:10001
WORKDIR /opt/recipes/mujoco
CMD ["python", "train.py", "--help"]
