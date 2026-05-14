# Isaac-GR00T Fine-tuning Container (N1.6 / N1.7)
# Based on upstream: https://github.com/NVIDIA/Isaac-GR00T/blob/main/Dockerfile
FROM nvcr.io/nvidia/pytorch:25.04-py3

ARG GROOT_VERSION=n1.6
ARG USE_STABLE=true
# n1.6: https://github.com/NVIDIA/Isaac-GR00T/releases/tag/n1.6.1-release
# n1.7: https://github.com/NVIDIA/Isaac-GR00T/releases/tag/n1.7-release
ARG STABLE_COMMIT=5dc80c4afd726b34faad1d8f7e007a13b34e4c88
ARG BASE_MODEL_PATH=nvidia/GR00T-N1.6-3B

ENV DEBIAN_FRONTEND=noninteractive
ENV NVIDIA_DRIVER_CAPABILITIES=graphics,utility,compute

# System deps (upstream + our additions: aws-cli, git-lfs, vim/htop)
RUN apt-get update && apt-get install -y \
    build-essential yasm cmake libtool git git-lfs pkg-config \
    libass-dev libfreetype6-dev libvorbis-dev \
    autoconf automake texinfo ffmpeg \
    wget curl ca-certificates unzip vim less htop \
    libegl1 \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 (needed for S3 integration)
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && ./aws/install && rm -rf awscliv2.zip aws

# UV package manager
RUN pip install uv

# Upstream dep fixes
RUN sed -i s/dill==0.3.9/dill==0.3.8/g /etc/pip/constraint.txt && \
    sed -i s/scipy==1.15.2/scipy==1.15.3/g /etc/pip/constraint.txt && \
    sed -i '/flash.attn/d' /etc/pip/constraint.txt

# pip deps (from upstream Dockerfile)
RUN pip install imageio h5py boto3 transformers[torch] deepspeed timm peft \
    diffusers wandb tianshou dm_tree openai \
    albumentations==1.4.18 decord==0.6.0 torchcodec==0.4.0

# PyTorch3D — pre-built wheel (fast) with source fallback
RUN PYTHON_VER="py3$(python -c 'import sys; print(sys.version_info.minor)')" && \
    TORCH_VER="pyt$(python -c 'import torch; print("".join(torch.__version__.split(".")[:2]))')" && \
    CUDA_VER="cu$(python -c 'import torch; print(torch.version.cuda.replace(".","")[:3])')" && \
    WHEEL_URL="https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/${PYTHON_VER}_${CUDA_VER}_${TORCH_VER}/download.html" && \
    echo "Trying pre-built PyTorch3D: ${WHEEL_URL}" && \
    pip install pytorch3d -f "${WHEEL_URL}" 2>/dev/null || \
    (echo "Pre-built wheel not available, building from source..." && \
     cd /opt && git clone https://github.com/facebookresearch/pytorch3d.git && \
     cd pytorch3d && MAX_JOBS=4 pip install .)

# Clone Isaac-GR00T
RUN git clone https://github.com/NVIDIA/Isaac-GR00T.git /workspace/gr00t-repo && \
    cd /workspace/gr00t-repo && \
    if [ "${USE_STABLE}" = "true" ]; then \
        echo "Using stable commit: ${STABLE_COMMIT}"; \
        git checkout ${STABLE_COMMIT}; \
    else \
        echo "Using latest version from main branch"; \
    fi && \
    echo "GR00T version info:" && \
    git log -1 --format="%H %ai %s"

# Install gr00t package
RUN cd /workspace/gr00t-repo && uv sync && uv pip install -e .

# Activate the uv venv so all subsequent python/pip commands use it
ENV VIRTUAL_ENV="/workspace/gr00t-repo/.venv"
ENV PATH="/workspace/gr00t-repo/.venv/bin:${PATH}"

# flash-attn — pre-built wheel from GitHub releases (avoids 30+ min source build)
RUN PYTHON_VER="cp$(python -c 'import sys; print(f"{sys.version_info.major}{sys.version_info.minor}")')" && \
    TORCH_VER=$(python -c "import torch; print(torch.__version__.split('+')[0])") && \
    CUDA_VER=$(python -c "import torch; print(torch.version.cuda.replace('.','')[:3])") && \
    FLASH_VER="2.7.4.post1" && \
    WHEEL_NAME="flash_attn-${FLASH_VER}+${PYTHON_VER}torch${TORCH_VER}cxx11abiFALSE-${PYTHON_VER}-${PYTHON_VER}-linux_x86_64.whl" && \
    WHEEL_URL="https://github.com/Dao-AILab/flash-attention/releases/download/v${FLASH_VER}/${WHEEL_NAME}" && \
    echo "Trying pre-built flash-attn: ${WHEEL_URL}" && \
    uv pip install "${WHEEL_URL}" 2>/dev/null || \
    (echo "Pre-built wheel not available, building from source..." && \
     uv pip install flash-attn==2.7.4.post1 --no-build-isolation)

# EGL/Vulkan setup
RUN mkdir -p /usr/share/glvnd/egl_vendor.d && \
    echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' \
    > /usr/share/glvnd/egl_vendor.d/10_nvidia.json
RUN mkdir -p /usr/share/vulkan/icd.d && \
    echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.2.140"}}' \
    > /usr/share/vulkan/icd.d/nvidia_icd.json

# Install additional utilities
RUN pip install notebook gpustat

# Copy workflow scripts + modality config
COPY finetune_gr00t.py /workspace/scripts/
COPY run_finetune_workflow.sh /workspace/scripts/
COPY so101_modality_config.py /workspace/scripts/
RUN chmod +x /workspace/scripts/run_finetune_workflow.sh

WORKDIR /workspace/gr00t-repo

ENV PYTHONPATH="/workspace/gr00t-repo:/workspace"
ENV DATASET_LOCAL_DIR="/workspace/train"
ENV OUTPUT_DIR="/workspace/checkpoints"
ENV BASE_MODEL_PATH="${BASE_MODEL_PATH}"

RUN mkdir -p ${DATASET_LOCAL_DIR} ${OUTPUT_DIR}

ENTRYPOINT ["/bin/bash"]
CMD ["/workspace/scripts/run_finetune_workflow.sh"]
