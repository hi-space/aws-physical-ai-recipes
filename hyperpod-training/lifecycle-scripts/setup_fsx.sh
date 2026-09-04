#!/bin/bash
set -euo pipefail

echo "[setup_fsx] Checking FSx configuration..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# HyperPod 호스트 에이전트는 lifecycle 스크립트를 별도 마운트 네임스페이스에서
# 실행한다. 그 안에서 한 mount 는 호스트(PID 1)·slurmd·SSM 세션에 보이지 않아
# 노드가 InService 인데 /fsx 가 빈 로컬 디렉터리로 남는다. 마운트와 확인은
# 항상 PID 1 의 네임스페이스에서 수행한다.
host() {
  if [ "$(readlink /proc/1/ns/mnt 2>/dev/null)" != "$(readlink /proc/self/ns/mnt 2>/dev/null)" ] \
     && command -v nsenter >/dev/null 2>&1; then
    nsenter -t 1 -m -- "$@"
  else
    "$@"
  fi
}
fsx_mounted() { host mountpoint -q /fsx; }

# Get region from instance metadata
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "us-east-1")

# Find FSx filesystem in same VPC via tags or lifecycle bucket config
FSX_DNS_NAME="${FSX_DNS_NAME:-}"
FSX_MOUNT_NAME="${FSX_MOUNT_NAME:-}"

# Primary source: fsx.env staged alongside these scripts by the CDK at deploy
# time (same mechanism as bucket.conf). This is authoritative — it names the
# filesystem that belongs to THIS cluster, so no discovery guessing is needed.
if [ -f "${SCRIPT_DIR}/fsx.env" ]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/fsx.env"
  echo "[setup_fsx] Loaded FSx config from ${SCRIPT_DIR}/fsx.env"
fi

if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  # Use LIFECYCLE_BUCKET from parent (on_create.sh exports it)
  if [ -z "${LIFECYCLE_BUCKET:-}" ]; then
    LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
  fi
  if [ -n "$LIFECYCLE_BUCKET" ]; then
    if aws s3 cp "s3://${LIFECYCLE_BUCKET}/config/fsx.env" /tmp/fsx.env 2>/dev/null; then
      source /tmp/fsx.env
      rm -f /tmp/fsx.env
    fi
  fi
fi

# If head node already has FSx mounted, save config for compute nodes
if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  if host mount | grep -q "/fsx.*lustre"; then
    FSX_MOUNT_INFO=$(host mount | grep "/fsx" | head -1)
    FSX_DNS_NAME=$(echo "$FSX_MOUNT_INFO" | awk -F'@' '{print $1}')
    FSX_MOUNT_NAME=$(echo "$FSX_MOUNT_INFO" | awk -F':/' '{print $2}' | awk '{print $1}')
    if [ -n "$LIFECYCLE_BUCKET" ] && [ -n "$FSX_DNS_NAME" ] && [ -n "$FSX_MOUNT_NAME" ]; then
      echo "FSX_DNS_NAME=${FSX_DNS_NAME}" > /tmp/fsx.env
      echo "FSX_MOUNT_NAME=${FSX_MOUNT_NAME}" >> /tmp/fsx.env
      aws s3 cp /tmp/fsx.env "s3://${LIFECYCLE_BUCKET}/config/fsx.env" 2>/dev/null || true
      rm -f /tmp/fsx.env
    fi
  fi
fi

if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  # Last resort: region-wide auto-discovery.
  #
  # This is deliberately a fallback, not the primary path: the query returns the
  # first available Lustre filesystem in the REGION, so in an account with more
  # than one FSx it can pick a filesystem in a different VPC, fail to mount, and
  # (because failures here are non-fatal) leave the cluster InService with no
  # /fsx. The reliable path is the fsx.env written next to these scripts by the
  # CDK at deploy time — see above.
  #
  # Note: we cannot narrow this by VPC from instance metadata. HyperPod nodes run
  # in a SageMaker service-owned account and their IMDS reports the *service*
  # VPC, not the cluster VPC, so a VpcId filter built from IMDS matches nothing.
  echo "[setup_fsx] WARNING: no fsx.env found; falling back to region-wide FSx lookup (may pick the wrong filesystem)."
  for attempt in $(seq 1 6); do
    FS_ID=$(aws fsx describe-file-systems --region "$REGION" --query "FileSystems[?FileSystemType=='LUSTRE' && Lifecycle=='AVAILABLE'].FileSystemId | [0]" --output text 2>/dev/null || true)
    if [ -n "$FS_ID" ] && [ "$FS_ID" != "None" ]; then
      FSX_DNS_NAME=$(aws fsx describe-file-systems --file-system-ids "$FS_ID" --region "$REGION" --query "FileSystems[0].DNSName" --output text 2>/dev/null || true)
      FSX_MOUNT_NAME=$(aws fsx describe-file-systems --file-system-ids "$FS_ID" --region "$REGION" --query "FileSystems[0].LustreConfiguration.MountName" --output text 2>/dev/null || true)
      break
    fi
    echo "[setup_fsx] FSx not ready yet (attempt $attempt/6). Waiting 30s..."
    sleep 30
  done
fi

if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  echo "[setup_fsx] FSx not found after retries. Skipping mount."
  exit 0
fi

echo "[setup_fsx] Mounting ${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME} at /fsx..."

# Install Lustre client
if command -v yum &>/dev/null; then
  amazon-linux-extras install -y lustre 2>/dev/null || \
    yum install -y lustre-client 2>/dev/null || \
    echo "[setup_fsx] WARNING: Could not install lustre client via yum."
elif command -v apt-get &>/dev/null; then
  apt-get update -y
  apt-get install -y lustre-client-modules-aws lustre-client-modules-$(uname -r) 2>/dev/null || \
    apt-get install -y lustre-client-modules-aws 2>/dev/null || \
    echo "[setup_fsx] WARNING: Could not install lustre client via apt."
fi

host mkdir -p /fsx

if fsx_mounted; then
  echo "[setup_fsx] /fsx already mounted."
else
  host mount -t lustre "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME}" /fsx || {
    echo "[setup_fsx] WARNING: Mount failed. Will retry after cluster is ready."
    exit 0
  }

  if ! grep -q "/fsx" /etc/fstab; then
    echo "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME} /fsx lustre defaults,noatime,flock,_netdev 0 0" >> /etc/fstab
  fi
fi

host mkdir -p /fsx/datasets /fsx/checkpoints /fsx/scratch
host chmod 777 /fsx/datasets /fsx/checkpoints /fsx/scratch

echo "[setup_fsx] FSx mounted at /fsx successfully."
