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

# Start SLURM services
if [ "${SAGEMAKER_INSTANCE_GROUP_NAME:-}" = "head" ]; then
  if [ -f /opt/slurm/sbin/slurmctld ]; then
    systemctl enable slurmctld 2>/dev/null || true
    systemctl start slurmctld 2>/dev/null || true
    echo "[on_create] SLURM controller started."
  fi
else
  # Compute nodes: ensure FSx is mounted then start slurmd
  if ! mount | grep -q "/fsx"; then
    mount /fsx 2>/dev/null || echo "[on_create] WARNING: FSx mount retry failed."
  fi
  if [ -f /opt/slurm/sbin/slurmd ]; then
    systemctl enable slurmd 2>/dev/null || true
    systemctl start slurmd 2>/dev/null || true
    echo "[on_create] SLURM worker (slurmd) started."
  fi
fi

# Setup DCV for remote desktop (GPU nodes only, runs after Slurm is up)
bash "${SCRIPT_DIR}/setup_dcv.sh" || echo "[on_create] DCV setup skipped or failed (non-fatal)."

echo "[on_create] Node initialization complete."
exit 0
