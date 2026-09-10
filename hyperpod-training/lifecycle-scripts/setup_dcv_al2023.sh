#!/bin/bash
# setup_dcv_al2023.sh — HyperPod EKS GPU 노드(Amazon Linux 2023)에 GNOME 데스크톱 + Amazon DCV 서버를 설치하고
# 'workspace' 가상 세션을 자동 생성한다 (모듈 10 §10.7 방법 B). Slurm 경로(Ubuntu AMI)의 setup_dcv.sh 에 해당한다.
#
# - EKS 노드의 컨테이너 런타임은 kubelet 의 containerd 이므로 Docker 는 설치하지 않는다. Isaac Sim 창은
#   Pod(k8s-templates/rl/isaaclab-play-job.yaml)가 노드의 X 소켓(/tmp/.X11-unix, hostPath)에 그린다.
# - 로그인: ec2-user / hyperpod (AL2023 기본 사용자). 웹 클라이언트 포트 8443, SSM 포트포워딩으로 접속한다.
# - DCV 라이선스는 EC2 인스턴스 롤의 S3 읽기(dcv-license.<region>)로 자동 처리된다(실행 롤에 AmazonS3FullAccess).
# 환경: DCV_USER(기본 ec2-user), DCV_PASSWORD(기본 hyperpod), DCV_TGZ_URL(기본 최신 amzn2023 x86_64)
set -uo pipefail

if ! command -v dnf >/dev/null 2>&1; then echo "[setup_dcv_al2023] not a dnf system, skipping."; exit 0; fi
if ! { lspci 2>/dev/null | grep -qi nvidia || [ -e /dev/nvidia0 ] || nvidia-smi -L &>/dev/null; }; then
  echo "[setup_dcv_al2023] No NVIDIA GPU detected, skipping DCV install."; exit 0
fi
if command -v dcv >/dev/null 2>&1 && systemctl is-active --quiet dcvserver 2>/dev/null; then
  echo "[setup_dcv_al2023] DCV already running."; exit 0
fi

DCV_USER="${DCV_USER:-ec2-user}"
DCV_PASSWORD="${DCV_PASSWORD:-hyperpod}"
DCV_TGZ_URL="${DCV_TGZ_URL:-https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-amzn2023-x86_64.tgz}"
LOG="/var/log/setup-dcv.log"
exec > >(tee -a "$LOG") 2>&1
log() { echo "[setup_dcv_al2023] $*"; }

retry() { local n="${2:-5}" d="${3:-8}"; for ((i=1;i<=n;i++)); do eval "$1" && return 0; log "retry $i/$n: $1"; sleep "$d"; done; return 1; }

# 1) GNOME 데스크톱 + GDM (AL2023 2023.7+ 'Desktop' 그룹), Wayland 끔 (DCV 는 Xorg 만 지원)
log "Installing GNOME desktop (dnf groupinstall Desktop)..."
retry "dnf -y -q groupinstall 'Desktop'" 3 15 || log "WARNING: Desktop group install had issues."
retry "dnf -y -q install xorg-x11-server-utils xterm gnome-terminal" 3 10 || true
mkdir -p /etc/gdm
if [ -f /etc/gdm/custom.conf ]; then
  grep -q '^WaylandEnable=false' /etc/gdm/custom.conf || sed -i 's/^\[daemon\]/[daemon]\nWaylandEnable=false/' /etc/gdm/custom.conf
else
  printf '[daemon]\nWaylandEnable=false\n' > /etc/gdm/custom.conf
fi
dnf -y -q remove gnome-initial-setup 2>/dev/null || true

# 2) Amazon DCV 서버 + 웹 뷰어 + Xdcv(가상 세션)
log "Installing Amazon DCV server..."
rpm --import https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY || true
cd /tmp && rm -rf nice-dcv-*
retry "curl -fsSL -o /tmp/dcv.tgz '${DCV_TGZ_URL}'" 3 10 || { log "WARNING: DCV download failed."; exit 0; }
tar -xzf /tmp/dcv.tgz -C /tmp
DCV_DIR="$(ls -d /tmp/nice-dcv-*amzn2023* | head -1)"
dnf -y -q install "${DCV_DIR}"/nice-dcv-server-*.rpm "${DCV_DIR}"/nice-dcv-web-viewer-*.rpm "${DCV_DIR}"/nice-xdcv-*.rpm \
  || { log "WARNING: DCV package install failed."; exit 0; }
usermod -aG video dcv 2>/dev/null || true
rm -rf /tmp/dcv.tgz "${DCV_DIR}"

cat > /etc/dcv/dcv.conf <<DCVCONF
[license]
[log]
level = "info"
[session-management]
virtual-session-xdcv-args = "-listen tcp"
[session-management/defaults]
[session-management/automatic-console-session]
storage-root = "/home/${DCV_USER}"
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
systemctl enable dcvserver
systemctl restart dcvserver

# 3) 부팅 시 'workspace' 가상 세션 자동 생성
cat > /usr/local/bin/auto-create-dcv-session.sh <<SCRIPT
#!/bin/bash
set -euo pipefail
SESSION_ID="workspace"; OWNER="${DCV_USER}"
until systemctl is-active --quiet dcvserver; do sleep 3; done
if ! dcv list-sessions | grep -q "Session: '\${SESSION_ID}'"; then
  dcv create-session "\${SESSION_ID}" --type virtual --owner "\${OWNER}" --name "HyperPod Workspace"
fi
sudo -u "\${OWNER}" dbus-launch gsettings set org.gnome.desktop.lockdown disable-lock-screen true 2>/dev/null || true
sudo -u "\${OWNER}" dbus-launch gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
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

# 4) 로그인 비밀번호
id "${DCV_USER}" >/dev/null 2>&1 || useradd -m "${DCV_USER}"
echo "${DCV_USER}:${DCV_PASSWORD}" | chpasswd

log "DCV installation complete. sessions: $(dcv list-sessions 2>/dev/null | tr '\n' ' ')"
log "Login: ${DCV_USER} / ${DCV_PASSWORD} (port 8443 via SSM port forwarding)"
