#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Derive lifecycle bucket name.
# Method 1: config file deployed alongside scripts (most reliable)
# Method 2: SageMaker env var (if available)
# Method 3: aws s3 ls fallback (requires network + IAM ready)
if [ -f "${SCRIPT_DIR}/bucket.conf" ]; then
  export LIFECYCLE_BUCKET=$(cat "${SCRIPT_DIR}/bucket.conf" | tr -d '[:space:]')
elif [ -n "${SAGEMAKER_LIFECYCLE_CONFIG_S3_URI:-}" ]; then
  export LIFECYCLE_BUCKET=$(echo "${SAGEMAKER_LIFECYCLE_CONFIG_S3_URI}" | sed 's|^s3://||' | cut -d/ -f1)
elif [ -z "${LIFECYCLE_BUCKET:-}" ]; then
  for attempt in 1 2 3; do
    LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
    [ -n "$LIFECYCLE_BUCKET" ] && break
    sleep 5
  done
  export LIFECYCLE_BUCKET
fi

echo "[on_create] Starting node initialization..."
echo "[on_create] Instance group: ${SAGEMAKER_INSTANCE_GROUP_NAME:-unknown}"
echo "[on_create] Hostname: $(hostname)"
echo "[on_create] Lifecycle bucket: ${LIFECYCLE_BUCKET:-unknown}"

# Detect package manager
if command -v yum &>/dev/null; then
  PKG_MGR="yum"
elif command -v apt-get &>/dev/null; then
  PKG_MGR="apt-get"
else
  echo "[on_create] WARNING: No supported package manager found."
  PKG_MGR=""
fi

# Install essential packages (git for repo cloning, ffmpeg for torchcodec video processing)
if [ "$PKG_MGR" = "apt-get" ]; then
  apt-get update -y -qq && apt-get install -y -qq git git-lfs ffmpeg 2>/dev/null || true
elif [ "$PKG_MGR" = "yum" ]; then
  yum install -y git git-lfs ffmpeg 2>/dev/null || true
fi
git lfs install 2>/dev/null || true
echo "[on_create] Essential packages installed."

# Install Enroot (container runtime)
ENROOT_VERSION="3.5.0"
if ! command -v enroot &>/dev/null; then
  cd /tmp
  if [ "$PKG_MGR" = "yum" ]; then
    curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot-${ENROOT_VERSION}-1.el8.x86_64.rpm"
    curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot+caps-${ENROOT_VERSION}-1.el8.x86_64.rpm"
    yum install -y ./enroot-${ENROOT_VERSION}-1.el8.x86_64.rpm ./enroot+caps-${ENROOT_VERSION}-1.el8.x86_64.rpm || \
      echo "[on_create] WARNING: Enroot install failed, continuing..."
    rm -f /tmp/enroot*.rpm
  elif [ "$PKG_MGR" = "apt-get" ]; then
    curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot_${ENROOT_VERSION}-1_amd64.deb"
    curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot+caps_${ENROOT_VERSION}-1_amd64.deb"
    apt-get update -y
    apt-get install -y ./enroot_${ENROOT_VERSION}-1_amd64.deb ./enroot+caps_${ENROOT_VERSION}-1_amd64.deb || \
      echo "[on_create] WARNING: Enroot install failed, continuing..."
    rm -f /tmp/enroot*.deb
  fi
fi

# Configure Enroot if installed
if command -v enroot &>/dev/null; then
  mkdir -p /etc/enroot /run/enroot
  chmod 777 /run/enroot
  # Pick a temp path for `enroot import`. Importing a large image (Isaac Sim is
  # ~20GB) unpacks every layer into the temp path and then converts aufs
  # whiteouts to overlayfs ones, so the location has to be both big and a real
  # local filesystem:
  #   - the node's root volume is too small (single-digit GB free) and the import
  #     dies with "parallel: Error: Change $TMPDIR with --tmpdir or use --compress."
  #   - /fsx (Lustre) is big but cannot do the whiteout xattrs, giving
  #     "enroot-aufs2ovlfs: failed to create opaque ovlfs whiteout ... Operation not permitted"
  # GPU instance types expose local NVMe at /opt/dlami/nvme (multiple TB), which
  # satisfies both. Nodes without instance store (e.g. an ml.m5 head node) fall
  # back to /tmp — fine for small images, but import large ones on a GPU node.
  if mountpoint -q /opt/dlami/nvme 2>/dev/null; then
    ENROOT_TMP=/opt/dlami/nvme/enroot/tmp
  else
    ENROOT_TMP=/tmp
  fi
  mkdir -p "${ENROOT_TMP}" 2>/dev/null || true
  chmod 777 "${ENROOT_TMP}" 2>/dev/null || true
  echo "[on_create] Enroot temp path: ${ENROOT_TMP}"
  cat > /etc/enroot/enroot.conf <<ENROOT_CONF
ENROOT_RUNTIME_PATH=/run/enroot/user-\$(id -u)
ENROOT_CACHE_PATH=/fsx/enroot
ENROOT_DATA_PATH=/fsx/enroot/data
ENROOT_TEMP_PATH=${ENROOT_TMP}
ENROOT_SQUASH_OPTIONS="-noI -noD -noF -noX -no-duplicates"
ENROOT_MOUNT_HOME=y
ENROOT_RESTRICT_DEV=y
ENROOT_ROOTFS_WRITABLE=y
ENROOT_CONF
  echo "[on_create] Enroot configured."
fi

# Ensure SSM agent is running for cluster access
if command -v amazon-ssm-agent &>/dev/null || [ -f /usr/bin/amazon-ssm-agent ]; then
  systemctl enable amazon-ssm-agent 2>/dev/null || true
  systemctl restart amazon-ssm-agent 2>/dev/null || true
  echo "[on_create] SSM agent restarted."
elif [ -f /snap/amazon-ssm-agent/current/amazon-ssm-agent ]; then
  snap start amazon-ssm-agent 2>/dev/null || true
  echo "[on_create] SSM agent (snap) started."
else
  if [ "$PKG_MGR" = "yum" ]; then
    yum install -y amazon-ssm-agent 2>/dev/null && systemctl enable amazon-ssm-agent && systemctl start amazon-ssm-agent || \
      echo "[on_create] WARNING: Could not install/start SSM agent."
  fi
fi

# Setup SSH access for jump host
bash "${SCRIPT_DIR}/setup_ssh_access.sh" || echo "[on_create] SSH setup skipped or failed (non-fatal)."

# Add any hardcoded keys from add_key.sh (uploaded separately for quick access provisioning)
[ -f "${SCRIPT_DIR}/add_key.sh" ] && bash "${SCRIPT_DIR}/add_key.sh" || true

# Mount FSx if configured
bash "${SCRIPT_DIR}/setup_fsx.sh" || echo "[on_create] FSx mount skipped or failed (non-fatal)."

# Configure SLURM (head saves IP, compute connects to head)
bash "${SCRIPT_DIR}/setup_slurm.sh" || echo "[on_create] SLURM setup skipped or failed (non-fatal)."

# Start SLURM services — 백그라운드 watcher 로 위임.
# HyperPod(Managed Slurm)는 이 스크립트가 끝난 *뒤에* Slurm 을 설치하므로
# 여기서 바로 systemctl start 를 하면 바이너리가 없어 조용히 건너뛴다
# (실측: on_create 실행 후 4분+ 뒤에 Slurm 설치 완료). FSx 도 아직 CREATING
# 이면 첫 mount 가 실패한다. watcher 가 설치/생성 완료를 기다렸다가 마무리한다.
mkdir -p /var/log/provision
# setsid 로 세션을 분리해 lifecycle 실행이 끝나도 watcher 가 살아남게 한다.
SAGEMAKER_INSTANCE_GROUP_NAME="${SAGEMAKER_INSTANCE_GROUP_NAME:-}" \
  setsid nohup bash "${SCRIPT_DIR}/post_provision_watcher.sh" \
  >> /var/log/provision/post-provision-watcher.log 2>&1 &
echo "[on_create] post_provision_watcher started (FSx mount retry + Slurm daemon start)."

# NVIDIA driver for Isaac Sim RTX rendering (GPU nodes only). The AMI's 595.x open
# kernel module crashes the RTX renderer; install the known-good proprietary build.
bash "${SCRIPT_DIR}/setup_nvidia_driver.sh" || echo "[on_create] NVIDIA driver setup skipped or failed (non-fatal)."

# Setup DCV for remote desktop (GPU nodes only, runs after Slurm is up)
bash "${SCRIPT_DIR}/setup_dcv.sh" || echo "[on_create] DCV setup skipped or failed (non-fatal)."

echo "[on_create] Node initialization complete."
exit 0
