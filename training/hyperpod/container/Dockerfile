# GR00T Fine-tuning Container for SageMaker HyperPod
# Based on: https://github.com/NVIDIA/Isaac-GR00T/blob/main/docker/Dockerfile

FROM nvcr.io/nvidia/pytorch:25.04-py3

ENV NVIDIA_DRIVER_CAPABILITIES=graphics,utility,compute

RUN apt-get update && apt-get install -y \
    build-essential yasm cmake libtool git pkg-config \
    libass-dev libfreetype6-dev libvorbis-dev \
    autoconf automake texinfo tmux ffmpeg libegl1

RUN pip install --upgrade pip setuptools
RUN pip install uv
RUN sed -i s/dill==0.3.9/dill==0.3.8/g /etc/pip/constraint.txt || true
RUN sed -i s/scipy==1.15.2/scipy==1.15.3/g /etc/pip/constraint.txt || true
RUN pip install imageio h5py boto3 transformers[torch] deepspeed timm peft \
    diffusers wandb tianshou dm_tree openai albumentations==1.4.18 \
    decord==0.6.0 torchcodec==0.4.0 mlflow sagemaker-mlflow

RUN mkdir -p /opt && cd /opt && git clone https://github.com/facebookresearch/pytorch3d.git
RUN cd /opt/pytorch3d && pip install .

# Clone Isaac-GR00T and install
RUN cd /workspace && git clone https://github.com/NVIDIA/Isaac-GR00T.git gr00t
WORKDIR /workspace/gr00t
RUN uv venv .venv && \
    . .venv/bin/activate && \
    uv pip install -e . && \
    uv pip install flash-attn --no-build-isolation

# EGL/Vulkan setup for headless rendering
RUN mkdir -p /usr/share/glvnd/egl_vendor.d && \
    cat >/usr/share/glvnd/egl_vendor.d/10_nvidia.json <<'EOF'
{
    "file_format_version" : "1.0.0",
    "ICD" : {
        "library_path" : "libEGL_nvidia.so.0"
    }
}
EOF

RUN mkdir -p /usr/share/vulkan/icd.d && \
    cat >/usr/share/vulkan/icd.d/nvidia_icd.json <<'EOF'
{
    "file_format_version": "1.0.0",
    "ICD": {
        "library_path": "libGLX_nvidia.so.0",
        "api_version": "1.2.140"
    }
}
EOF

WORKDIR /workspace/gr00t
