# Required build args are provisioned immutable images/assets, never fabricated ECR tags.
ARG ISAACLAB_RECIPE_IMAGE
ARG LEISAAC_ASSETS_IMAGE
FROM ${LEISAAC_ASSETS_IMAGE} AS scene-assets
FROM ${ISAACLAB_RECIPE_IMAGE}
ARG LEISAAC_SCENE_REVISION
ENV LEISAAC_SCENE_REVISION=${LEISAAC_SCENE_REVISION} LEISAAC_ASSETS_ROOT=/opt/leisaac/assets
RUN git init /opt/leisaac && cd /opt/leisaac \
    && git remote add origin https://github.com/LightwheelAI/leisaac.git \
    && git fetch --depth 1 origin 24d3bcd3f1e4585740fc79921782c41617237812 \
    && git checkout --detach FETCH_HEAD \
    && /isaac-sim/python.sh -m pip install --no-cache-dir './source/leisaac[gr00t]'
# Scene/robot releases are NOT part of the Python source. Supply a prevalidated
# release asset image containing /assets, with its digest as SCENE_REVISION.
COPY --from=scene-assets /assets /opt/leisaac/assets
RUN test -n "$LEISAAC_SCENE_REVISION" \
    && test -f /opt/leisaac/assets/scenes/kitchen_with_orange/scene.usd
COPY dashboard/recipes /opt/recipes
WORKDIR /opt/leisaac
