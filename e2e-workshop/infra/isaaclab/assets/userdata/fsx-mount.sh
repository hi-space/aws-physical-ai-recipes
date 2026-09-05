#!/bin/bash
# =============================================================================
# fsx-mount.sh - 공유 FSx for Lustre 마운트 스크립트 (옵션)
# =============================================================================
# 스택을 -c enableFsx=true 로 배포한 경우에만 FSX_* 변수가 채워지며, 그때 공유
# FSx for Lustre 파일시스템을 /fsx 에 마운트한다. 기본 배포(enableFsx=false)에서는
# 변수가 비어 있어 바로 건너뛴다 — 체크포인트는 S3에서 aws s3 sync 로 받는다.
#
# FSx를 켠 경우 같은 파일시스템을 SageMaker Training(groot 스택의 DRA로 S3와 자동
# 동기화)과 HyperPod 클러스터(-c fsxFileSystemId 로 import)가 공유할 수 있다.
#
# Lustre 커널 모듈은 실행 중인 커널 버전에 정확히 맞아야 한다. DLAMI의 커널이
# FSx 저장소에 아직 없는 버전이면 설치가 실패할 수 있는데, 이 경우 배포 전체를
# 실패시키지 않고 [WARN] 마커만 남긴다 — aws s3 sync 경로는 그대로 쓸 수 있다.
#
# 입력 환경 변수:
#   FSX_ID         - FSx 파일시스템 ID (예: fs-xxxxxxxx)
#   FSX_DNS_NAME   - FSx DNS 이름 (예: fs-xxxx.fsx.us-east-1.amazonaws.com)
#   FSX_MOUNT_NAME - Lustre mount name (예: abcdef)
# =============================================================================

echo "===== [$(date)] START: fsx-mount.sh ====="

if [ -z "$FSX_ID" ] || [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  echo "[INFO] FSX_ID/FSX_DNS_NAME/FSX_MOUNT_NAME 미설정 (enableFsx=false) — FSx 마운트를 건너뜁니다."
  echo "===== [$(date)] END: fsx-mount.sh (SKIPPED) ====="
  return 0 2>/dev/null || exit 0
fi

# -----------------------------------------------------------------------------
# 1. Lustre 클라이언트 설치 (Amazon FSx Lustre client repo)
# -----------------------------------------------------------------------------
echo "----- [$(date)] START: fsx-mount (lustre client install) -----"
FSX_MOUNT_OK=1

if ! modprobe -n lustre 2>/dev/null && ! dpkg -l "lustre-client-modules-$(uname -r)" >/dev/null 2>&1; then
  wget -q -O - https://fsx-lustre-client-repo-public-keys.s3.amazonaws.com/fsx-ubuntu-public-key.asc \
    | gpg --dearmor > /usr/share/keyrings/fsx-ubuntu-public-key.gpg || FSX_MOUNT_OK=0
  echo "deb [signed-by=/usr/share/keyrings/fsx-ubuntu-public-key.gpg] https://fsx-lustre-client-repo.s3.amazonaws.com/ubuntu $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/fsxlustreclientrepo.list
  # DPkg::Lock::Timeout: 백그라운드로 병렬 실행되는 models-download.sh가 apt를 잡고
  # 있을 수 있으므로 lock을 기다린다 (기본 동작은 즉시 실패).
  apt-get -o DPkg::Lock::Timeout=300 update -y || FSX_MOUNT_OK=0
  # 실행 중인 커널에 맞는 모듈 우선, 없으면 aws 커널 메타 패키지 시도
  if ! apt-get -o DPkg::Lock::Timeout=300 install -y "lustre-client-modules-$(uname -r)"; then
    echo "[WARN] lustre-client-modules-$(uname -r) 패키지 없음 — lustre-client-modules-aws 시도"
    apt-get -o DPkg::Lock::Timeout=300 install -y lustre-client-modules-aws || FSX_MOUNT_OK=0
  fi
fi
echo "----- [$(date)] END: fsx-mount (lustre client install) -----"

# -----------------------------------------------------------------------------
# 2. 마운트 (/fsx) + fstab 등록 (reboot 후 자동 재마운트)
# -----------------------------------------------------------------------------
if [ "$FSX_MOUNT_OK" = "1" ]; then
  mkdir -p /fsx
  if mount -t lustre -o relatime,flock "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME}" /fsx; then
    chown ubuntu:ubuntu /fsx
    FSTAB_ENTRY="${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME} /fsx lustre defaults,relatime,flock,_netdev,nofail 0 0"
    if ! grep -q "${FSX_DNS_NAME}" /etc/fstab; then
      echo "$FSTAB_ENTRY" >> /etc/fstab
      echo "fstab에 FSx 마운트 항목 등록 완료"
    fi
    echo "FSx 마운트 완료: /fsx (${FSX_ID})"
  else
    FSX_MOUNT_OK=0
  fi
fi

if [ "$FSX_MOUNT_OK" != "1" ]; then
  echo "[WARN] FSx 마운트 실패 — 배포는 계속 진행합니다. 수동 마운트:"
  echo "  sudo mount -t lustre -o relatime,flock ${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME} /fsx"
  echo "  (checkpoint는 aws s3 sync 로 로컬 디스크에 받아도 됩니다)"
fi

echo "===== [$(date)] END: fsx-mount.sh ====="
