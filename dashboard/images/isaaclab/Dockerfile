# Context: repository root. GPU build/run not validated by the CPU integration.
FROM nvcr.io/nvidia/isaac-lab:2.3.0
ARG RECIPE_SOURCE_REVISION=local
ENV RECIPE_SOURCE_REVISION=${RECIPE_SOURCE_REVISION} \
    PYTHONPATH=/opt/workshop/src:/opt/recipes \
    OMNI_KIT_ALLOW_ROOT=1
COPY hyperpod-training/isaac-lab-workshop /opt/workshop
COPY hyperpod-training/examples/rl/play_isaaclab.py /opt/recipes/isaaclab/play.py
COPY dashboard/recipes /opt/recipes
RUN /isaac-sim/python.sh -m pip install --no-cache-dir \
    mlflow==2.22.0 sagemaker-mlflow==0.1.0 imageio==2.37.0 imageio-ffmpeg==0.6.0 \
    && test -f /workspace/isaaclab/scripts/imitation_learning/isaaclab_mimic/generate_dataset.py \
    && test -f /opt/workshop/src/workshop/robots/usd/so_arm101.usd
# Dashboard workloads run as UID/GID 1000 and cannot mount the writable Kit
# volumes NVIDIA's container docs prescribe (kit/cache, kit/data, kit/logs and
# the OV dirs under $HOME). Without them Isaac Sim's RTX path fails to create
# its shader cache, derived-data cache, ogn cache and kvdb user.config, so
# HydraEngine rtx never builds a scene renderer and env.render() returns no
# frame (live view stays at 0 frames). Bake those dirs (empty in the base
# image, so this is a cheap layer) and a writable HOME owned by 1000:1000.
ENV HOME=/home/pai
RUN mkdir -p /isaac-sim/kit/cache /isaac-sim/kit/data /isaac-sim/kit/logs \
        /home/pai/.cache/ov /home/pai/.nvidia-omniverse/logs \
        /home/pai/.local/share/ov/data \
    && chown -R 1000:1000 /isaac-sim/kit/cache /isaac-sim/kit/data \
        /isaac-sim/kit/logs /home/pai
# The vendor image makes this directory 0750 for UID 1234. Dashboard workloads
# run as UID/GID 1000; grant traversal/read access, never write or root execution.
RUN chmod 0755 /isaac-sim \
    && setpriv --reuid=1000 --regid=1000 --clear-groups \
       /isaac-sim/python.sh /opt/recipes/isaaclab/test_image_contract.py
WORKDIR /opt/recipes
