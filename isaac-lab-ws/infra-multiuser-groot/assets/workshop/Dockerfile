# Isaac Lab Docker 이미지 빌드용 Dockerfile
# isaac-lab.sh에서 ISAAC_SIM_VERSION으로 sed 패치 후 빌드된다.
#
# 사용자가 직접 수정하여 커스터마이징할 수 있다.
# 예: 추가 Python 패키지 설치, 다른 로봇 모델 포함 등

# 베이스 이미지 (isaac-lab.sh에서 sed로 버전 패치됨)
FROM nvcr.io/nvidia/isaac-sim:4.5.0

# 작업 디렉토리 설정
WORKDIR /workspace

# IsaacLab 소스 복사
COPY . /workspace/IsaacLab

# IsaacLab 설치
RUN cd /workspace/IsaacLab && \
    pip install -e .

# 분산 학습 스크립트 복사
COPY distributed_run.bash /workspace/distributed_run.bash
RUN chmod +x /workspace/distributed_run.bash

# 기본 명령어
CMD ["/bin/bash"]
