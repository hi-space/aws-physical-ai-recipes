#!/bin/bash
set -euo pipefail

echo "[setup_dcv] Checking if DCV setup is needed..."

# The head node only schedules jobs: no desktop there.
if [ "${SAGEMAKER_INSTANCE_GROUP_NAME:-}" = "head" ]; then
  echo "[setup_dcv] Head node detected, skipping DCV install."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

LOG="/var/log/setup-dcv.log"
exec > >(tee -a "$LOG") 2>&1

# Two flavours of DCV node:
#   GPU nodes (debug, gpu-*) — GNOME desktop + NVIDIA container toolkit, so Isaac Sim can render
#                              its viewport into the DCV session (workshop S4).
#   CPU nodes (cpu-*)        — lighter xfce desktop + Mesa software OpenGL. A DCV *virtual* session
#                              does not need a GPU (Xdcv renders through llvmpipe), which is enough
#                              for the SO-101 MuJoCo viewer (workshop S3.10). Adds ~3-5 min to boot.
# Detect the GPU by PCI device / device node, not by `command -v nvidia-smi`: the HyperPod AMI ships
# the nvidia-smi binary on CPU instances too (it just fails with "couldn't communicate with the
# NVIDIA driver"), which would send a c5 node down the GNOME path. Same test as setup_nvidia_driver.sh.
if lspci 2>/dev/null | grep -qi nvidia || [ -e /dev/nvidia0 ] || nvidia-smi -L &>/dev/null; then
  HAS_GPU=1
  echo "[setup_dcv] NVIDIA GPU detected: GPU desktop (GNOME + NVIDIA container toolkit)."
else
  HAS_GPU=0
  echo "[setup_dcv] No NVIDIA GPU: CPU desktop (xfce + Mesa software OpenGL)."
fi

# Skip if already fully configured
if command -v dcv &>/dev/null && systemctl is-active --quiet dcvserver 2>/dev/null; then
  echo "[setup_dcv] DCV already running."
  exit 0
fi

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
if [ "${HAS_GPU}" = "1" ]; then
  apt_install ubuntu-desktop-minimal gdm3 dbus-x11 xterm x11-xserver-utils || \
    apt_install xfce4 xfce4-goodies dbus-x11 xterm x11-xserver-utils || \
    echo "[setup_dcv] WARNING: Desktop install had issues."

  # libglvnd 정합성 복구: 드라이버 단계가 libGLdispatch.so.0 / libGLX.so.0 를 NVIDIA 빌드로 바꿔 놓았다면
  # 위에서 설치된 Ubuntu libgles2 와 어긋나 gnome-shell 이 "_glapi_tls_Current" 심볼 오류로 죽는다.
  # Ubuntu libglvnd 패키지를 재설치해 한 세트로 맞춘다(dpkg -V libglvnd0 가 깨끗해야 정상).
  apt-get install -yq --reinstall libglvnd0 libglx0 libgl1 libegl1 libgles2 libopengl0 >/dev/null 2>&1 \
    || echo "[setup_dcv] WARNING: libglvnd reinstall failed; gnome-shell may not start (check dpkg -V libglvnd0)."
  ldconfig
else
  # xfce is a fraction of ubuntu-desktop-minimal and has no GPU expectations. The Mesa packages give
  # Xdcv, GLFW (MuJoCo viewer) and MUJOCO_GL=egl offscreen rendering a software OpenGL implementation,
  # so play_mujoco.sbatch's first-run Mesa install becomes a no-op on these nodes.
  apt_install xfce4 xfce4-terminal dbus-x11 xterm x11-xserver-utils \
    libgl1-mesa-dri libglx-mesa0 libegl1 libgl1 libglvnd0 libglu1-mesa mesa-utils || \
    echo "[setup_dcv] WARNING: Desktop install had issues."
fi

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
if [ "${HAS_GPU}" = "1" ]; then
  apt-get install -yq ./*.deb
else
  # Only what a virtual session needs. nice-dcv-gl (GPU GLX sharing) would print
  # "DCVGL ... No supported glVND vendor" on every OpenGL app here, and
  # nice-dcv-gnome-shell-extension would drag gnome-shell + gdm3 onto a node that runs xfce.
  apt-get install -yq ./nice-dcv-server_*.deb ./nice-xdcv_*.deb ./nice-dcv-web-viewer_*.deb \
    ./nice-dcv-simple-external-authenticator_*.deb
fi

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
[connectivity]
web-port = 8443
web-url-path = "/"
idle-timeout = 0
[security]
auth-token-verifier = ""
no-tls-strict = true
os-auto-lock = false
DCVCONF

if [ "${HAS_GPU}" = "1" ]; then
  # Share the GPU-backed X display :0 with virtual sessions (Isaac Sim viewport).
  cat >> /etc/dcv/dcv.conf <<'DCVCONF'
[display/linux]
gl-displays = [":0.0"]
DCVCONF
fi
# No GPU: nothing to add. Without gl-displays the virtual session's Xdcv renders OpenGL through
# Mesa (llvmpipe) — the "OpenGL software rendering" setup in the DCV admin guide prerequisites.

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
# 4) Docker + NVIDIA Container Toolkit (GPU nodes only — the MuJoCo path runs from an FSx venv)
# ============================================================
if [ "${HAS_GPU}" = "1" ]; then
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
