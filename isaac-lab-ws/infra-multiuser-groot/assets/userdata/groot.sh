#!/bin/bash -e
# =============================================================================
# groot.sh - GR00T N1 Docker 빌드 + 추론 서버 systemd 서비스 설정
# =============================================================================
# GR00T 리포지토리를 클론하고, Docker 이미지를 빌드하며,
# 부팅 시 자동으로 추론 서버를 실행하는 systemd 서비스를 등록한다.
# EFS에 GR00T-N1.6-3B 모델 가중치를 다운로드한다.
#
# 입력 환경 변수:
#   GROOT_REPO   - GR00T GitHub 리포지토리 URL
#   GROOT_BRANCH - GR00T 리포지토리 브랜치
#   EFS_ID       - EFS 파일 시스템 ID
#   REGION       - AWS 리전
# =============================================================================

echo "===== [$(date)] START: groot.sh ====="

# GROOT_REPO가 비어있으면 스킵
if [ -z "$GROOT_REPO" ]; then
  echo "GROOT_REPO가 설정되지 않음. GR00T 설치를 건너뜁니다."
  echo "===== [$(date)] END: groot.sh (SKIPPED) ====="
  exit 0
fi

# --- 1. HuggingFace에서 GR00T 모델 가중치 다운로드 (EFS) ---
pip3 install -q huggingface_hub
if [ ! -d /home/ubuntu/environment/efs/GR00T-N1.6-3B ]; then
  python3 -c "from huggingface_hub import snapshot_download; snapshot_download('nvidia/GR00T-N1.6-3B', local_dir='/home/ubuntu/environment/efs/GR00T-N1.6-3B')"
fi

# --- 2. GR00T 리포지토리 클론 + Dockerfile 생성 ---
mkdir -p /home/ubuntu/environment/groot_docker
cd /home/ubuntu/environment/groot_docker
git clone --branch $GROOT_BRANCH $GROOT_REPO gr00t

cat << 'GROOT_DOCKERFILE' > Dockerfile
FROM nvcr.io/nvidia/pytorch:25.04-py3
ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_CONSTRAINT=""
COPY gr00t/ /workspace/gr00t/
WORKDIR /workspace/gr00t
RUN pip install --no-cache-dir -e .
EXPOSE 5555
ENTRYPOINT ["python"]
CMD ["gr00t/eval/run_gr00t_server.py"]
GROOT_DOCKERFILE

chown -R ubuntu:ubuntu /home/ubuntu/environment/groot_docker

# --- 3. GR00T Docker 빌드 systemd 서비스 ---
cat << 'GROOTSVC' > /etc/systemd/system/groot-docker-build.service
[Unit]
Description=GR00T Docker Build
After=docker.service
Requires=docker.service
ConditionPathExists=!/var/groot-done

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'docker build -t groot-n1:latest /home/ubuntu/environment/groot_docker && touch /var/groot-done'
ExecStartPost=/bin/systemctl --no-block start groot-inference.service

[Install]
WantedBy=multi-user.target
GROOTSVC

# --- 4. GR00T 추론 서버 systemd 서비스 ---
cat << GROOTINFSVC > /etc/systemd/system/groot-inference.service
[Unit]
Description=GR00T Inference Server
After=groot-docker-build.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=on-failure
ExecStartPre=/bin/bash -c 'mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2 $EFS_ID.efs.$REGION.amazonaws.com:/ /home/ubuntu/environment/efs 2>/dev/null || true'
ExecStart=docker run --rm --gpus all --name groot-inference -p 5555:5555 -v /home/ubuntu/environment/efs:/workspace/weights groot-n1:latest gr00t/eval/run_gr00t_server.py --model_path /workspace/weights/GR00T-N1.6-3B --embodiment_tag GR1 --port 5555

[Install]
WantedBy=multi-user.target
GROOTINFSVC

systemctl daemon-reload
systemctl enable groot-docker-build.service
systemctl enable groot-inference.service

echo "===== [$(date)] END: groot.sh ====="
