#!/bin/bash -e
# =============================================================================
# isaac-lab.sh - Isaac Lab Docker 이미지 빌드 스크립트
# =============================================================================
# IsaacLab 리포지토리를 클론하고, Workshop_Asset(Dockerfile, distributed_run.bash)을
# 다운로드한 후, Dockerfile에서 Isaac Sim 버전을 패치하여 Docker 이미지를 빌드한다.
#
# 입력 환경 변수:
#   ISAAC_SIM_VERSION - Isaac Sim 버전 (예: '4.5.0', '5.1.0', '')
#   ISAAC_LAB_VERSION - Isaac Lab 태그 (프로필의 isaacLabVersion). 미지정 시 main 브랜치
# =============================================================================

echo "===== [$(date)] START: isaac-lab.sh ====="

# GNOME 설치가 유발하는 일시적 DNS 붕괴 대비 — git clone/docker pull 전에 복구 확인
[ -f /tmp/userdata-scripts/dns-guard.sh ] && source /tmp/userdata-scripts/dns-guard.sh

# -----------------------------------------------------------------------------
# 1. ISAAC_SIM_VERSION이 비어있으면 스킵
#    isaacSimVersion이 빈 문자열인 프로필에서는 Isaac Sim/Lab 설치를 건너뛴다.
# -----------------------------------------------------------------------------
if [ -z "${ISAAC_SIM_VERSION}" ]; then
  echo "ISAAC_SIM_VERSION이 설정되지 않음. Isaac Lab 설치를 건너뜁니다."
  echo "===== [$(date)] END: isaac-lab.sh (SKIPPED) ====="
else

# -----------------------------------------------------------------------------
# 2. IsaacLab 리포지토리 클론
#    Isaac Sim 버전과 호환되는 태그를 고정한다. ISAAC_LAB_VERSION이 지정되면
#    해당 태그를 고정 체크아웃한다.
#    main은 개발 브랜치여서 다음 메이저(IsaacLab 3.0 / Isaac Sim 6.x) 코드가
#    수시로 들어오고 되돌려진다. 실제로 2026-08-29 시점의 main은 tomllib
#    (Python 3.11+)을 요구해 Isaac Sim 4.5.0(Python 3.10.15)에서
#    `isaaclab.sh --install`이 ModuleNotFoundError로 실패했고, 하루 뒤에는
#    다시 5.1.0 타깃 상태로 되돌아가 있었다. 이렇게 하루 단위로 달라지므로
#    프로필이 선언한 태그로 반드시 고정해야 재현 가능한 빌드가 된다.
# -----------------------------------------------------------------------------
# /home/ubuntu/environment 는 참가자가 체크포인트 등을 직접 내려받는 작업 디렉터리이므로
# 소유자를 ubuntu 로 둔다 (root 로 만들면 ubuntu 가 하위 디렉터리를 만들 수 없다).
install -d -o ubuntu -g ubuntu /home/ubuntu/environment
cd /home/ubuntu/environment
if [ -n "${ISAAC_LAB_VERSION}" ]; then
  echo "IsaacLab 태그 v${ISAAC_LAB_VERSION} 고정 클론"
  git clone --branch "v${ISAAC_LAB_VERSION}" --depth 1 https://github.com/isaac-sim/IsaacLab.git
else
  echo "경고: ISAAC_LAB_VERSION 미지정 — main 브랜치를 클론합니다 (Isaac Sim 버전과 불일치할 수 있음)"
  git clone https://github.com/isaac-sim/IsaacLab.git
fi
chown -R ubuntu:ubuntu /home/ubuntu/environment/IsaacLab
cd /home/ubuntu/environment/IsaacLab

# -----------------------------------------------------------------------------
# 3. Workshop 에셋 복사 (Dockerfile, distributed_run.bash)
#    dcv-instance.ts가 UserData 시작 부분에서 /tmp에 기록한 파일을 복사한다.
#    외부 S3 URL 의존성 없이 리포에 내장된 에셋을 사용한다.
# -----------------------------------------------------------------------------
cp /tmp/workshop-dockerfile Dockerfile
cp /tmp/workshop-distributed-run distributed_run.bash

# -----------------------------------------------------------------------------
# 4. Dockerfile에서 Isaac Sim 버전 sed 패치
#    베이스 이미지를 지정된 버전으로 교체하고,
#    Isaac Sim 5.x 이상에서는 추가 EULA 동의가 필요하다.
# -----------------------------------------------------------------------------
sed -i "s|FROM nvcr.io/nvidia/isaac-sim:.*|FROM nvcr.io/nvidia/isaac-sim:${ISAAC_SIM_VERSION}|g" Dockerfile

MAJOR_VER=$(echo "${ISAAC_SIM_VERSION}" | cut -d. -f1)
if [ "${MAJOR_VER}" -ge 5 ] 2>/dev/null; then
  # 5.x: ACCEPT_EULA + OMNI_KIT_ACCEPT_EULA + USER root
  sed -i '/^FROM/a ENV ACCEPT_EULA=Y\nENV OMNI_KIT_ACCEPT_EULA=YES\nUSER root' Dockerfile
else
  # 4.x: EULA 불필요
  :
fi

# -----------------------------------------------------------------------------
# 5. Docker 이미지 빌드
#    워크숍에서는 DCV 인스턴스에서 이 로컬 이미지로 직접 docker run 한다.
# -----------------------------------------------------------------------------
docker build -t isaaclab-batch:latest .

echo "===== [$(date)] END: isaac-lab.sh ====="
fi
