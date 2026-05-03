#!/bin/bash
set -euo pipefail

echo "[setup_fsx] Checking FSx configuration..."

# Get region from instance metadata
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "us-west-2")

# Find FSx filesystem in same VPC via tags or lifecycle bucket config
FSX_DNS_NAME="${FSX_DNS_NAME:-}"
FSX_MOUNT_NAME="${FSX_MOUNT_NAME:-}"

if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  # Try to discover FSx from lifecycle bucket config
  LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
  if [ -n "$LIFECYCLE_BUCKET" ]; then
    if aws s3 cp "s3://${LIFECYCLE_BUCKET}/config/fsx.env" /tmp/fsx.env 2>/dev/null; then
      source /tmp/fsx.env
      rm -f /tmp/fsx.env
    fi
  fi
fi

# If head node already has FSx mounted, save config for compute nodes
if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  if mount | grep -q "/fsx.*lustre"; then
    FSX_MOUNT_INFO=$(mount | grep "/fsx" | head -1)
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
  # Auto-discover with retry (FSx may still be initializing during first boot)
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

mkdir -p /fsx

if mount | grep -q "/fsx"; then
  echo "[setup_fsx] /fsx already mounted."
else
  mount -t lustre "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME}" /fsx || {
    echo "[setup_fsx] WARNING: Mount failed. Will retry after cluster is ready."
    exit 0
  }

  if ! grep -q "/fsx" /etc/fstab; then
    echo "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME} /fsx lustre defaults,noatime,flock,_netdev 0 0" >> /etc/fstab
  fi
fi

mkdir -p /fsx/datasets /fsx/checkpoints /fsx/scratch
chmod 777 /fsx/datasets /fsx/checkpoints /fsx/scratch

echo "[setup_fsx] FSx mounted at /fsx successfully."
