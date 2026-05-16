#!/bin/bash -e
# =============================================================================
# isaac-lab.sh - Isaac Lab Docker 이미지 빌드 및 ECR 푸시 스크립트
# =============================================================================
# IsaacLab 리포지토리를 클론하고, Workshop_Asset(Dockerfile, distributed_run.bash)을
# 다운로드한 후, Dockerfile에서 Isaac Sim 버전을 패치하여 Docker 이미지를 빌드하고
# ECR에 푸시한다.
#
# 입력 환경 변수:
#   ISAAC_SIM_VERSION - Isaac Sim 버전 (예: '4.5.0', '5.1.0', '')
#   REGION            - AWS 리전 (예: us-east-1)
#   ACCOUNT           - AWS 계정 ID
#   ECR_REPO_NAME     - ECR 리포지토리 이름 (기본: isaaclab-batch)
# =============================================================================

echo "===== [$(date)] START: isaac-lab.sh ====="

# ECR 리포지토리 이름 기본값
if [ -z "$ECR_REPO_NAME" ]; then
  ECR_REPO_NAME="isaaclab-batch"
fi

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
# -----------------------------------------------------------------------------
mkdir -p /home/ubuntu/environment
cd /home/ubuntu/environment
git clone https://github.com/isaac-sim/IsaacLab.git
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
# -----------------------------------------------------------------------------
docker build -t ${ECR_REPO_NAME}:latest .

# -----------------------------------------------------------------------------
# 6. ECR 리포지토리 생성 및 이미지 푸시
#    || true로 이미 존재하는 리포지토리에 대한 에러를 방지한다.
# -----------------------------------------------------------------------------
aws ecr create-repository --repository-name ${ECR_REPO_NAME} --region ${REGION} || true
aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
docker tag ${ECR_REPO_NAME}:latest ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO_NAME}:latest
docker push ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO_NAME}:latest

echo "===== [$(date)] END: isaac-lab.sh ====="
fi
