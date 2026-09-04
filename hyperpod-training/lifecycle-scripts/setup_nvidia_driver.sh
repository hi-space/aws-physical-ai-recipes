#!/bin/bash
# setup_nvidia_driver.sh — GPU 노드의 NVIDIA 드라이버를 Isaac Sim RTX 렌더링이 동작하는
# 버전으로 교체한다.
#
# 왜 필요한가:
#   HyperPod AMI의 NVIDIA 드라이버 595.x 에서는 Isaac Sim 4.5/5.1의 RTX 렌더러가
#   초기화(rtx.scenedb.plugin) 중 segfault 로 죽는다(open/proprietary 커널 모듈 모두).
#   headless 물리 시뮬은 정상이지만 뷰포트(DCV GUI)와 카메라 렌더링(--enable_cameras)이
#   모두 불가능하다. 모듈 1 DCV 인스턴스와 동일한 580.173.02 에서는 정상 동작한다.
#
# 커널 모듈 종류는 AMI 와 같은 open 을 유지한다: GPUDirect 계열 모듈(gdrdrv, nvidia_fs,
# efa_nv_peermem)은 GPL 전용 심볼을 쓰므로 proprietary 모듈 위에서는 로드되지 않는다.
#
# 동작:
#   - GPU 가 없는 노드(head)는 건너뛴다.
#   - 이미 목표 버전이면 건너뛴다.
#   - GPU 를 잡고 있는 서비스(DCGM, 헬스 모니터링 에이전트, persistenced, DCV)를 잠시 멈추고
#     커널 모듈을 내린 뒤 NVIDIA .run 설치기로 사용자공간+커널 모듈을 빌드/설치하고(약 2~4분),
#     nvidia 에 의존하는 DKMS 모듈(gdrdrv, efa-nv-peermem)을 새 드라이버에 맞춰 재빌드한 뒤
#     모듈을 다시 올리고 서비스를 재시작한다.
#   - 실패해도 non-fatal: 기존 드라이버로 되돌아가 노드 프로비저닝은 계속된다.
#
# 환경 변수:
#   NVIDIA_DRIVER_VERSION      목표 드라이버 버전 (기본 580.173.02)
#   NVIDIA_KERNEL_MODULE_TYPE  open | proprietary (기본 open)
#   NVIDIA_DRIVER_SKIP=1       이 단계를 건너뛴다
set -uo pipefail

NVIDIA_DRIVER_VERSION="${NVIDIA_DRIVER_VERSION:-580.173.02}"
NVIDIA_KERNEL_MODULE_TYPE="${NVIDIA_KERNEL_MODULE_TYPE:-open}"
RUNFILE="NVIDIA-Linux-x86_64-${NVIDIA_DRIVER_VERSION}.run"
RUNFILE_URL="https://us.download.nvidia.com/tesla/${NVIDIA_DRIVER_VERSION}/${RUNFILE}"
LOG="/var/log/setup-nvidia-driver.log"

log() { echo "[setup_nvidia_driver] $*"; }

if [ "${NVIDIA_DRIVER_SKIP:-0}" = "1" ]; then
  log "NVIDIA_DRIVER_SKIP=1 — skipping."; exit 0
fi
if ! command -v nvidia-smi &>/dev/null || ! nvidia-smi -L &>/dev/null; then
  log "No NVIDIA GPU detected, skipping."; exit 0
fi

CURRENT="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
MODULE_TYPE="$(grep -q 'Open Kernel Module' /proc/driver/nvidia/version 2>/dev/null && echo open || echo proprietary)"
if [ "${CURRENT}" = "${NVIDIA_DRIVER_VERSION}" ] && [ "${MODULE_TYPE}" = "${NVIDIA_KERNEL_MODULE_TYPE}" ]; then
  log "Driver ${CURRENT} (${MODULE_TYPE}) already installed."; exit 0
fi
log "Current driver: ${CURRENT} (${MODULE_TYPE}) → target ${NVIDIA_DRIVER_VERSION} (${NVIDIA_KERNEL_MODULE_TYPE})"

exec > >(tee -a "$LOG") 2>&1

# 작업 공간: 로컬 NVMe(인스턴스 스토어)가 있으면 그곳, 없으면 /var/tmp
WORK="/opt/dlami/nvme/nvidia-driver"
mountpoint -q /opt/dlami/nvme 2>/dev/null || WORK="/var/tmp/nvidia-driver"
mkdir -p "${WORK}/tmp"; cd "${WORK}"

export DEBIAN_FRONTEND=noninteractive
KVER="$(uname -r)"
if [ ! -d "/lib/modules/${KVER}/build" ]; then
  apt-get update -yq && apt-get install -yq "linux-headers-${KVER}" || { log "WARNING: kernel headers unavailable; keeping current driver."; exit 0; }
fi
command -v gcc >/dev/null && command -v make >/dev/null || apt-get install -yq build-essential
# Vulkan 로더: NVIDIA Vulkan ICD 가 동작하려면 호스트에 libvulkan1 이 필요하다.
apt-get install -yq libvulkan1 >/dev/null 2>&1 || true

if [ ! -f "${RUNFILE}" ]; then
  log "Downloading ${RUNFILE_URL} ..."
  curl -fsSL -o "${RUNFILE}" "${RUNFILE_URL}" || { log "WARNING: download failed; keeping current driver."; exit 0; }
fi
rm -rf extracted; sh "${RUNFILE}" --extract-only --target extracted >/dev/null || { log "WARNING: extract failed; keeping current driver."; exit 0; }
KDIR=kernel; [ "${NVIDIA_KERNEL_MODULE_TYPE}" = "open" ] && KDIR=kernel-open
[ -d "extracted/${KDIR}" ] || { log "WARNING: runfile has no ${NVIDIA_KERNEL_MODULE_TYPE} kernel module; keeping current driver."; exit 0; }

# --- GPU 를 잡고 있는 프로세스/서비스 정리 -------------------------------------
STOPPED_UNITS=""
for u in nvidia-dcgm sagemaker-health-monitoring-agent dcvserver nvidia-fabricmanager; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then systemctl stop "$u" && STOPPED_UNITS="${STOPPED_UNITS} $u"; fi
done
PERSIST_PID="$(pgrep -x nvidia-persiste | head -1 || true)"
if [ -n "${PERSIST_PID}" ]; then
  PERSIST_UNIT="$(ps -o unit= -p "${PERSIST_PID}" 2>/dev/null | tr -d ' ')"
  [ -n "${PERSIST_UNIT}" ] && [ "${PERSIST_UNIT}" != "-" ] && systemctl stop "${PERSIST_UNIT}" 2>/dev/null && STOPPED_UNITS="${STOPPED_UNITS} ${PERSIST_UNIT}"
  pkill -x nvidia-persiste 2>/dev/null || true
fi
sleep 2

restore_services() {
  modprobe nvidia 2>/dev/null; modprobe nvidia_uvm 2>/dev/null; modprobe nvidia_modeset 2>/dev/null
  modprobe nvidia_drm 2>/dev/null; modprobe gdrdrv 2>/dev/null; modprobe efa_nv_peermem 2>/dev/null; modprobe nvidia_fs 2>/dev/null
  for u in ${STOPPED_UNITS}; do systemctl start "$u" 2>/dev/null || true; done
  systemctl restart auto-dcv 2>/dev/null || true
}

# 방금 멈춘 서비스가 디바이스를 닫는 데 잠깐 걸릴 수 있어 언로드를 최대 3회 시도한다.
for attempt in 1 2 3; do
  for m in gdrdrv nvidia_fs efa_nv_peermem nvidia_peermem nvidia_drm nvidia_modeset nvidia_uvm nvidia; do
    lsmod | grep -q "^${m} " && modprobe -r "$m" 2>/dev/null
  done
  lsmod | grep -qE "^nvidia " || break
  log "nvidia module still loaded after unload attempt ${attempt}: $(lsmod | grep -E '^nvidia ' | awk '{print "used_by=" $4}')"
  sleep 3
done
if lsmod | grep -qE "^nvidia "; then
  log "WARNING: nvidia module still in use (holders: $(fuser -v /dev/nvidia* 2>&1 | awk 'NR>1{print $NF}' | sort -u | tr '\n' ' ')); keeping current driver."
  restore_services; exit 0
fi

# --- 설치 ----------------------------------------------------------------------
log "Installing NVIDIA ${NVIDIA_DRIVER_VERSION} (${NVIDIA_KERNEL_MODULE_TYPE} kernel module)..."
( cd extracted && ./nvidia-installer -s --ui=none --no-questions --kernel-module-type="${NVIDIA_KERNEL_MODULE_TYPE}" \
    --no-x-check --no-nouveau-check --no-backup --install-libglvnd --tmpdir="${WORK}/tmp" ) 2>&1 | tail -5
RC=${PIPESTATUS[0]}

# nvidia 심볼에 의존하는 DKMS 모듈(gdrdrv, efa-nv-peermem)을 새 드라이버 헤더로 재빌드한다.
if [ "${RC}" -eq 0 ]; then
  for mv in $(dkms status 2>/dev/null | awk -F'[,/ ]+' '/^(gdrdrv|efa-nv-peermem)\//{print $1"/"$2}' | sort -u); do
    log "Rebuilding DKMS module ${mv} against the new driver..."
    dkms install "${mv}" -k "${KVER}" --force 2>&1 | tail -1
  done
fi

restore_services
NEW="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"
if [ "${RC}" -eq 0 ] && [ "${NEW}" = "${NVIDIA_DRIVER_VERSION}" ]; then
  log "Driver now: $(head -1 /proc/driver/nvidia/version)"
  log "Done."
else
  log "WARNING: installer rc=${RC}, driver now '${NEW}'. Node continues with whatever driver is loaded."
fi
rm -rf "${WORK}/extracted" "${WORK}/tmp"
exit 0
