#!/bin/bash
# =============================================================================
# s3files-client.sh - Amazon S3 Files 클라이언트 설치 + 마운트 헬퍼 배치
# =============================================================================
# 학습 산출물의 허브는 S3 다. 모듈 3의 GrootFinetune 스택이 아티팩트 버킷을 S3 Files
# 파일시스템으로 노출하므로, 이 인스턴스는 그 파일시스템을 NFS 로 마운트해 SageMaker 가
# export 한 체크포인트를 `aws s3 sync` 없이 바로 읽는다.
#
# 이 스크립트는 IsaacLab 스택 배포(모듈 1) 시점에 실행되며 파일시스템은 아직 없다.
# 그래서 여기서는 클라이언트(amazon-efs-utils ≥ 3.0, mount.s3files 헬퍼)만 설치하고,
# 실제 마운트는 GrootFinetune 스택 배포 후 참가자가 한 줄로 수행한다:
#
#   sudo s3files-mount GrootFinetune-<ACCOUNT_ID> /mnt/s3/groot
#   sudo s3files-mount fs-0123456789abcdef0     /mnt/s3/groot     # 파일시스템 ID 직접 지정
#
# 헬퍼는 /etc/fstab 에 _netdev,nofail 로 등록해 reboot 후에도 자동 재마운트한다.
# 설치 실패는 배포를 실패시키지 않고 [WARN] 마커만 남긴다 — aws s3 sync 경로는 그대로 쓸 수 있다.
#
# 입력 환경 변수: 없음 (REGION 은 헬퍼가 IMDS 에서 읽는다)
# =============================================================================

echo "===== [$(date)] START: s3files-client.sh ====="

S3FILES_OK=1

# -----------------------------------------------------------------------------
# 1. amazon-efs-utils 설치 (EFS 와 S3 Files 가 공유하는 클라이언트, 3.0 이상 필요)
#    Ubuntu 는 공식 설치 스크립트를 쓴다 (Ubuntu 20.04/22.04/24.04 지원).
# -----------------------------------------------------------------------------
echo "----- [$(date)] START: s3files-client (amazon-efs-utils install) -----"
if command -v mount.s3files >/dev/null 2>&1; then
  echo "amazon-efs-utils (mount.s3files) 이미 설치됨: $(dpkg-query -W -f='${Version}' amazon-efs-utils 2>/dev/null || echo unknown)"
else
  # 백그라운드로 병렬 실행되는 models-download.sh 등이 apt 를 잡고 있을 수 있어 lock 을 기다린다.
  for _i in $(seq 1 60); do
    fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
    echo "dpkg lock 사용 중... 5초 대기 (${_i}/60)"; sleep 5
  done
  INSTALLED=0
  for _attempt in 1 2 3; do
    if curl -fsSL --max-time 60 https://amazon-efs-utils.aws.com/efs-utils-installer.sh -o /tmp/efs-utils-installer.sh \
       && sh /tmp/efs-utils-installer.sh --install; then
      INSTALLED=1; break
    fi
    echo "[WARN] efs-utils 설치 시도 ${_attempt}/3 실패 — 30초 후 재시도"; sleep 30
  done
  rm -f /tmp/efs-utils-installer.sh
  if [ "$INSTALLED" = "1" ] && command -v mount.s3files >/dev/null 2>&1; then
    echo "amazon-efs-utils 설치 완료: $(dpkg-query -W -f='${Version}' amazon-efs-utils 2>/dev/null || echo unknown)"
  else
    echo "[WARN] amazon-efs-utils 설치 실패 또는 mount.s3files 없음"
    S3FILES_OK=0
  fi
fi
# 마운트 헬퍼가 자격증명·메트릭에 botocore 를 쓴다. DLAMI 에는 보통 있지만 없으면 설치한다.
python3 -c 'import botocore' 2>/dev/null || pip3 install --quiet botocore 2>/dev/null || echo "[WARN] botocore 설치 실패 (마운트 자체에는 영향 없음)"
echo "----- [$(date)] END: s3files-client (amazon-efs-utils install) -----"

# -----------------------------------------------------------------------------
# 2. 마운트 헬퍼 /usr/local/bin/s3files-mount
#    <fs-id | CloudFormation 스택 이름> <마운트 경로> [ro]
#    스택 이름이 오면 Output `S3FilesFileSystemId` 를 읽는다 (GrootFinetune 스택 규약).
# -----------------------------------------------------------------------------
cat > /usr/local/bin/s3files-mount <<'HELPER'
#!/bin/bash
# s3files-mount — Amazon S3 Files 파일시스템을 마운트하고 /etc/fstab 에 등록한다.
# 사용법: sudo s3files-mount <fs-id | CloudFormation 스택 이름> <마운트 경로> [ro]
set -euo pipefail

usage() { echo "usage: sudo s3files-mount <fs-id | stack-name> <mount-dir> [ro]" >&2; exit 2; }
[ "$#" -ge 2 ] || usage
[ "$(id -u)" = "0" ] || { echo "root 권한이 필요합니다 (sudo)" >&2; exit 1; }

TARGET="$1"; DIR="$2"; MODE="${3:-rw}"
[ "$MODE" = "rw" ] || [ "$MODE" = "ro" ] || usage

if ! command -v mount.s3files >/dev/null 2>&1; then
  echo "mount.s3files 가 없습니다. amazon-efs-utils(>=3.0)를 설치하세요:" >&2
  echo "  curl -fsSL https://amazon-efs-utils.aws.com/efs-utils-installer.sh | sudo sh -s -- --install" >&2
  exit 1
fi

# 리전: 인자 없이도 동작하도록 IMDSv2 에서 읽는다 (AWS_REGION 이 있으면 우선).
if [ -z "${AWS_REGION:-}" ]; then
  TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" || true)
  AWS_REGION=$(curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/placement/region || true)
fi
export AWS_REGION

case "$TARGET" in
  fs-*) FS_ID="$TARGET" ;;
  *)
    FS_ID=$(aws cloudformation describe-stacks --stack-name "$TARGET" --region "$AWS_REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='S3FilesFileSystemId'].OutputValue" --output text 2>/dev/null || true)
    if [ -z "$FS_ID" ] || [ "$FS_ID" = "None" ]; then
      echo "스택 '$TARGET' 에서 S3FilesFileSystemId Output 을 찾지 못했습니다 (리전 ${AWS_REGION})." >&2
      echo "GrootFinetune 스택이 -c enableS3Files=false 로 배포됐거나 아직 배포되지 않았습니다." >&2
      exit 1
    fi
    echo "스택 ${TARGET} → 파일시스템 ${FS_ID}"
    ;;
esac

mkdir -p "$DIR"
if mountpoint -q "$DIR"; then
  echo "이미 마운트됨: $DIR"
else
  # tls/iam 은 헬퍼가 항상 강제하므로 지정하지 않는다.
  mount -t s3files -o "$MODE" "${FS_ID}:/" "$DIR"
  echo "마운트 완료: ${FS_ID}:/ → ${DIR} (${MODE})"
fi

# fstab: 같은 마운트 경로의 기존 s3files 항목은 교체한다. _netdev 없이는 부팅이 멈출 수 있다.
FSTAB_OPTS="_netdev,nofail"; [ "$MODE" = "ro" ] && FSTAB_OPTS="${FSTAB_OPTS},ro"
sed -i "\# ${DIR} s3files #d" /etc/fstab
echo "${FS_ID}:/ ${DIR} s3files ${FSTAB_OPTS} 0 0" >> /etc/fstab
echo "/etc/fstab 등록: ${FS_ID}:/ ${DIR} s3files ${FSTAB_OPTS}"

findmnt -T "$DIR" || true
HELPER
chmod 755 /usr/local/bin/s3files-mount
echo "마운트 헬퍼 설치: /usr/local/bin/s3files-mount"

if [ "$S3FILES_OK" != "1" ]; then
  echo "[WARN] S3 Files 클라이언트 준비 실패 — 배포는 계속 진행합니다. 수동 설치:"
  echo "  curl -fsSL https://amazon-efs-utils.aws.com/efs-utils-installer.sh | sudo sh -s -- --install"
  echo "  (checkpoint 는 aws s3 sync 로 로컬 디스크에 받아도 됩니다)"
fi

echo "===== [$(date)] END: s3files-client.sh ====="
