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
# The vendor image makes this directory 0750 for UID 1234. Dashboard workloads
# run as UID/GID 1000; grant traversal/read access, never write or root execution.
RUN chmod 0755 /isaac-sim \
    && setpriv --reuid=1000 --regid=1000 --clear-groups \
       /isaac-sim/python.sh /opt/recipes/isaaclab/test_image_contract.py
WORKDIR /opt/recipes
