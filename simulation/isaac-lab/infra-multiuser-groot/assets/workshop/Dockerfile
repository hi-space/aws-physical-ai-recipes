# Isaac Lab Docker 이미지 빌드용 Dockerfile
# isaac-lab.sh에서 ISAAC_SIM_VERSION으로 sed 패치 후 빌드된다.
#
# IsaacLab 공식 docker/Dockerfile.base 기반으로 간소화.
# 사용자가 직접 수정하여 커스터마이징할 수 있다.

# 베이스 이미지 (isaac-lab.sh에서 sed로 버전 패치됨)
FROM nvcr.io/nvidia/isaac-sim:4.5.0

USER root
SHELL ["/bin/bash", "-c"]

ENV ISAACSIM_ROOT_PATH="/isaac-sim"
ENV ISAACLAB_PATH="/workspace/IsaacLab"
ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm

# IsaacLab 소스 복사
COPY . ${ISAACLAB_PATH}

# Isaac Sim → _isaac_sim 심볼릭 링크 (isaaclab.sh가 Python 경로를 찾는 데 필요)
RUN ln -sf ${ISAACSIM_ROOT_PATH} ${ISAACLAB_PATH}/_isaac_sim

# 시스템 의존성 설치
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# IsaacLab 설치
RUN chmod +x ${ISAACLAB_PATH}/isaaclab.sh && \
    ${ISAACLAB_PATH}/isaaclab.sh -p -m pip install toml && \
    ${ISAACLAB_PATH}/isaaclab.sh --install

WORKDIR /workspace

# 분산 학습 스크립트 복사
COPY distributed_run.bash /workspace/distributed_run.bash
RUN chmod +x /workspace/distributed_run.bash

CMD ["/bin/bash"]
