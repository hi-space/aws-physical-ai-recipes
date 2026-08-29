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
#
# PIP_CONSTRAINT로 빌드 격리 환경의 setuptools 버전을 제한한다.
# isaaclab 코어의 의존성 flatdict==4.0.1은 sdist만 제공하며 setup.py가
# pkg_resources를 import하지만, setuptools는 82.0.0에서 pkg_resources를
# 제거했다. 제한하지 않으면 pip이 빌드 격리 환경에 최신 setuptools를 받아와
# flatdict 휠 빌드가 `ModuleNotFoundError: No module named 'pkg_resources'`로
# 실패하고, 그 결과 isaaclab 코어만 설치되지 않는다. 그런데 isaaclab.sh가
# 이 오류를 무시하고 넘어가므로 이미지 빌드는 성공한 것처럼 끝나고 런타임에야
# `ModuleNotFoundError: No module named 'isaaclab'`로 드러난다.
# 82 미만이면 충분하지만, 워크숍에서 실제로 검증한 핀은 `<81`이다.
RUN chmod +x ${ISAACLAB_PATH}/isaaclab.sh && \
    echo "setuptools<81" > /tmp/pip-constraint.txt && \
    PIP_CONSTRAINT=/tmp/pip-constraint.txt ${ISAACLAB_PATH}/isaaclab.sh -p -m pip install toml && \
    PIP_CONSTRAINT=/tmp/pip-constraint.txt ${ISAACLAB_PATH}/isaaclab.sh --install && \
    rm -f /tmp/pip-constraint.txt

# 설치 검증 — isaaclab 코어가 설치되지 않았으면 빌드를 즉시 중단한다.
# 위 설치 단계는 개별 패키지 실패를 조용히 넘기므로 이 가드가 필수다.
# `import isaaclab_tasks`로 검증할 수는 없다: 그 경로는 USD 모듈(pxr)을 요구하고
# pxr은 Isaac Sim 앱이 초기화된 뒤에만 로드되므로 빌드 시점에는 항상 실패한다.
# 따라서 import 부작용이 없는 pip show로 설치 사실만 확인한다
# (미설치 시 pip show가 exit 1을 반환해 빌드가 중단된다).
RUN ${ISAACLAB_PATH}/isaaclab.sh -p -m pip show isaaclab > /dev/null && \
    echo "isaaclab core install verified"

WORKDIR /workspace

# 분산 학습 스크립트 복사
COPY distributed_run.bash /workspace/distributed_run.bash
RUN chmod +x /workspace/distributed_run.bash

CMD ["/bin/bash"]
