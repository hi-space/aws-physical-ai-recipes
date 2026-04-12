#!/bin/bash -e
# =============================================================================
# efs-mount.sh - EFS 마운트 및 사전 학습 모델 다운로드 스크립트
# =============================================================================
# EFS 파일 시스템을 /home/ubuntu/environment/efs에 마운트하고,
# 사전 학습된 모델 파일(agent_72000.pt)을 EFS에 다운로드한다.
#
# 입력 환경 변수:
#   EFS_ID - EFS 파일 시스템 ID (예: fs-xxxxxxxx)
#   REGION - AWS 리전 (예: us-east-1)
# =============================================================================

echo "===== [$(date)] START: efs-mount.sh ====="

# -----------------------------------------------------------------------------
# 1. nfs-common 설치
#    NFS v4 마운트에 필요한 패키지를 설치한다.
#    (amazon-efs-utils는 Ubuntu 기본 저장소에 없으므로 nfs-common 사용)
# -----------------------------------------------------------------------------
apt-get install -y nfs-common

# -----------------------------------------------------------------------------
# 2. EFS 마운트 디렉토리 생성 및 마운트
#    NFS v4.1 프로토콜로 EFS 파일 시스템을 마운트한다.
# -----------------------------------------------------------------------------
mkdir -p /home/ubuntu/environment/efs
chown -R ubuntu:ubuntu /home/ubuntu/environment/efs
mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2 ${EFS_ID}.efs.${REGION}.amazonaws.com:/ /home/ubuntu/environment/efs

# -----------------------------------------------------------------------------
# 2-1. fstab에 EFS 마운트 항목 등록 (reboot 후 자동 재마운트)
#      중복 등록을 방지하기 위해 grep으로 기존 항목을 확인한다.
# -----------------------------------------------------------------------------
FSTAB_ENTRY="${EFS_ID}.efs.${REGION}.amazonaws.com:/ /home/ubuntu/environment/efs nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,_netdev,nofail 0 0"
if ! grep -q "${EFS_ID}.efs" /etc/fstab; then
  echo "$FSTAB_ENTRY" >> /etc/fstab
  echo "fstab에 EFS 마운트 항목 등록 완료"
fi

# -----------------------------------------------------------------------------
# 3. 사전 학습된 모델 파일 다운로드
#    Workshop_Asset 중 agent_72000.pt를 EFS에 다운로드한다.
# -----------------------------------------------------------------------------
wget -P /home/ubuntu/environment/efs https://ws-assets-prod-iad-r-pdx-f3b3f9f1a7d6a3d0.s3.us-west-2.amazonaws.com/075ce3fe-6888-4ea9-986e-5bdd1b767ef7/agent_72000.pt

echo "===== [$(date)] END: efs-mount.sh ====="
