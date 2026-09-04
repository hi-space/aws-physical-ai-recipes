#!/bin/bash
set -euo pipefail

echo "[setup_dcv] Checking if DCV setup is needed..."

# Only install DCV on GPU nodes (skip head node)
if [ "${SAGEMAKER_INSTANCE_GROUP_NAME:-}" = "head" ]; then
  echo "[setup_dcv] Head node detected, skipping DCV install."
  exit 0
fi

# Check if GPU is available
if ! command -v nvidia-smi &>/dev/null; then
  echo "[setup_dcv] No NVIDIA GPU detected, skipping DCV install."
  exit 0
fi

# Skip if already fully configured
if command -v dcv &>/dev/null && systemctl is-active --quiet dcvserver 2>/dev/null; then
  echo "[setup_dcv] DCV already running."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

LOG="/var/log/setup-dcv.log"
exec > >(tee -a "$LOG") 2>&1

retry() {
  local tries="${2:-5}" delay="${3:-5}"
  for ((i=1;i<=tries;i++)); do
    if eval "$1"; then return 0; fi
    echo "[setup_dcv] Retry $i/$tries..."
    sleep "$delay"
  done
  return 1
}

apt_update() { retry "apt-get update -yq" 5 8; }
apt_install() { retry "apt-get install -yq --no-install-recommends $*" 5 8; }

# ============================================================
# 1) Desktop environment (Ubuntu Desktop + GDM, Wayland off)
# ============================================================
echo "[setup_dcv] Installing desktop environment..."
apt_update
apt_install ubuntu-desktop-minimal gdm3 dbus-x11 xterm x11-xserver-utils || \
  apt_install xfce4 xfce4-goodies dbus-x11 xterm x11-xserver-utils || \
  echo "[setup_dcv] WARNING: Desktop install had issues."

# Disable Wayland for DCV compatibility
if [ -f /etc/gdm3/custom.conf ]; then
  sed -i 's/^#\(WaylandEnable=false\)/\1/' /etc/gdm3/custom.conf || true
fi

# Disable GNOME initial setup wizard
apt-get remove --purge -yq gnome-initial-setup 2>/dev/null || true

# ============================================================
# 2) NICE DCV Server
# ============================================================
echo "[setup_dcv] Installing NICE DCV..."
DCV_URL="https://d1uj6qtbmh3dt5.cloudfront.net/2024.0/Servers/nice-dcv-2024.0-19030-ubuntu2204-x86_64.tgz"
cd /tmp
wget -q "$DCV_URL" -O /tmp/dcv.tgz
tar -xzf /tmp/dcv.tgz -C /tmp
cd /tmp/nice-dcv-2024.0-19030-ubuntu2204-x86_64

apt_install libpulse-mainloop-glib0 libpulse0 libgstreamer-plugins-base1.0-0 \
  libcrack2 libxcb-damage0 libxcb-xkb1 libxcb-xtest0 keyutils alsa-utils
apt-get install -yq ./*.deb

usermod -aG video dcv 2>/dev/null || true
rm -rf /tmp/dcv.tgz /tmp/nice-dcv-*

# DCV configuration
cat > /etc/dcv/dcv.conf <<'DCVCONF'
[license]
[log]
level = "info"
[session-management]
virtual-session-xdcv-args = "-listen tcp"
[session-management/defaults]
[session-management/automatic-console-session]
storage-root = "/home/ubuntu"
[display]
max-head-resolution = "(4096, 2160)"
web-client-max-head-resolution = "(4096, 4096)"
[display/linux]
gl-displays = [":0.0"]
[connectivity]
web-port = 8443
web-url-path = "/"
idle-timeout = 0
[security]
auth-token-verifier = ""
no-tls-strict = true
os-auto-lock = false
DCVCONF

systemctl enable dcvserver
systemctl restart dcvserver

# ============================================================
# 3) Auto-create DCV session service
# ============================================================
echo "[setup_dcv] Setting up auto DCV session..."
cat > /usr/local/bin/auto-create-dcv-session.sh <<'SCRIPT'
#!/bin/bash
set -euo pipefail
SESSION_ID="workspace"
OWNER="ubuntu"

until systemctl is-active --quiet dcvserver; do sleep 3; done

if ! dcv list-sessions | grep -q "Session: '${SESSION_ID}'"; then
  dcv create-session "${SESSION_ID}" --type virtual --owner "${OWNER}" --name "HyperPod Workspace"
fi

sudo -u "${OWNER}" dbus-launch gsettings set org.gnome.desktop.lockdown disable-lock-screen true 2>/dev/null || true
sudo -u "${OWNER}" dbus-launch gsettings set org.gnome.desktop.interface color-scheme prefer-dark 2>/dev/null || true
SCRIPT
chmod +x /usr/local/bin/auto-create-dcv-session.sh

cat > /etc/systemd/system/auto-dcv.service <<'UNIT'
[Unit]
Description=Auto-create DCV virtual session
After=dcvserver.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/auto-create-dcv-session.sh
RemainAfterExit=yes
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable auto-dcv.service
systemctl start auto-dcv.service

# ============================================================
# 4) Docker + NVIDIA Container Toolkit
# ============================================================
echo "[setup_dcv] Installing Docker + NVIDIA Container Toolkit..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi
usermod -aG docker ubuntu 2>/dev/null || true

if ! dpkg -l | grep -q nvidia-container-toolkit; then
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
    gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | \
    tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  apt_update
  apt_install nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker 2>/dev/null || true
  systemctl restart docker
fi

# ============================================================
# 5) Set ubuntu password for DCV login
# ============================================================
echo "ubuntu:hyperpod" | chpasswd

# ============================================================
# 6) Firefox browser
# ============================================================
apt_install firefox 2>/dev/null || true

echo "[setup_dcv] DCV installation complete."
echo "[setup_dcv] Access via: https://<node-ip>:8443"
echo "[setup_dcv] Login: ubuntu / hyperpod"
echo "[setup_dcv] FSx is already mounted at /fsx (datasets, checkpoints available)"
