#!/bin/bash
set -euo pipefail

echo "[on_create] Starting node initialization..."

# Enroot 설치
ENROOT_VERSION="3.5.0"
curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot_${ENROOT_VERSION}-1_amd64.deb"
curl -fSsL -O "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot+caps_${ENROOT_VERSION}-1_amd64.deb"
apt-get update -y
apt-get install -y ./"enroot_${ENROOT_VERSION}-1_amd64.deb" ./"enroot+caps_${ENROOT_VERSION}-1_amd64.deb"
rm -f enroot*.deb

# Enroot 설정
mkdir -p /etc/enroot
cat > /etc/enroot/enroot.conf <<'ENROOT_CONF'
ENROOT_RUNTIME_PATH=/run/enroot/user-$(id -u)
ENROOT_CACHE_PATH=/tmp/enroot-cache
ENROOT_DATA_PATH=/tmp/enroot-data
ENROOT_SQUASH_OPTIONS="-noI -noD -noF -noX -no-duplicates"
ENROOT_MOUNT_HOME=y
ENROOT_RESTRICT_DEV=y
ENROOT_ROOTFS_WRITABLE=y
ENROOT_CONF

# Pyxis (SLURM container plugin) 설치
PYXIS_VERSION="0.20.0"
git clone --depth 1 --branch "v${PYXIS_VERSION}" https://github.com/NVIDIA/pyxis.git /tmp/pyxis
cd /tmp/pyxis && make install && cd - && rm -rf /tmp/pyxis

mkdir -p /etc/slurm
echo "required /usr/local/lib/slurm/spank_pyxis.so" > /etc/slurm/plugstack.conf

# FSx 마운트
bash /opt/ml/scripts/setup_fsx.sh

# SLURM 파티션 설정
bash /opt/ml/scripts/setup_slurm.sh

echo "[on_create] Node initialization complete."
