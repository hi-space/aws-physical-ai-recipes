#!/bin/bash -e
# =============================================================================
# nvidia-driver.sh - NVIDIA 드라이버 및 컨테이너 툴킷 설치 스크립트
# =============================================================================
# NVIDIA GPU 드라이버, nvidia-container-toolkit, nvidia-persistenced를 설치한다.
# DLAMI에 사전 설치된 드라이버 버전에 따라 적절히 처리한다.
#
# nvidia-xconfig는 사용하지 않는다. 멀티 GPU 환경에서 --enable-all-gpus가
# 4개 Screen을 생성하여 DCV와 충돌하므로, DCV 최적화 xorg.conf를 직접 생성한다.
#
# 입력 환경 변수:
#   NVIDIA_DRIVER_VERSION - NVIDIA 드라이버 메이저 버전 (예: '570')
# =============================================================================

echo "===== [$(date)] START: nvidia-driver.sh ====="

# -----------------------------------------------------------------------------
# 1. NVIDIA 드라이버 설치/교체
# -----------------------------------------------------------------------------
if nvidia-smi > /dev/null 2>&1; then
  INSTALLED_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
  INSTALLED_MAJOR=$(echo "$INSTALLED_VER" | cut -d. -f1)
  echo "NVIDIA 드라이버 감지: ${INSTALLED_VER} (메이저: ${INSTALLED_MAJOR}), 요청: ${NVIDIA_DRIVER_VERSION}"

  if [ "$INSTALLED_MAJOR" = "$NVIDIA_DRIVER_VERSION" ]; then
    echo "드라이버 메이저 버전 일치. 설치를 건너뜁니다."
  elif [ "$INSTALLED_MAJOR" = "550" ] && [ "$NVIDIA_DRIVER_VERSION" = "570" ]; then
    echo "DLAMI 550 드라이버 감지. apt로 570 업그레이드합니다..."
    apt-get update
    apt-get install -y nvidia-driver-${NVIDIA_DRIVER_VERSION}-server
    apt-mark hold nvidia-driver-${NVIDIA_DRIVER_VERSION}-server || true
    echo "nvidia-driver-${NVIDIA_DRIVER_VERSION}-server 업그레이드 완료"
  else
    echo "드라이버 메이저 버전 불일치 (${INSTALLED_MAJOR} != ${NVIDIA_DRIVER_VERSION}). 교체합니다..."
    nvidia-uninstall --silent 2>/dev/null || true
    dkms remove nvidia/${INSTALLED_VER} --all 2>/dev/null || true
    apt-get remove --purge -y "nvidia-fabricmanager*" 2>/dev/null || true
    apt-get update
    apt-get install -y nvidia-driver-${NVIDIA_DRIVER_VERSION}-server || true
    apt-mark hold nvidia-driver-${NVIDIA_DRIVER_VERSION}-server || true
    echo "nvidia-driver-${NVIDIA_DRIVER_VERSION}-server 교체 완료"
  fi
else
  echo "NVIDIA 드라이버 미설치. nvidia-driver-${NVIDIA_DRIVER_VERSION}-server를 설치합니다..."
  apt-get update
  apt-get install -y nvidia-driver-${NVIDIA_DRIVER_VERSION}-server
  apt-mark hold nvidia-driver-${NVIDIA_DRIVER_VERSION}-server || true
fi

# -----------------------------------------------------------------------------
# 2. DCV 최적화 xorg.conf 생성 (Ubuntu 22.04/24.04 모두)
#    lspci로 첫 번째 NVIDIA GPU의 PCI BusID를 조회한다.
#    nvidia-smi는 드라이버 교체 직후 커널 모듈 불일치로 실패할 수 있으므로 사용하지 않는다.
# -----------------------------------------------------------------------------
GPU_PCI_SLOT=$(lspci | grep -i nvidia | head -1 | cut -d' ' -f1)
if [ -n "$GPU_PCI_SLOT" ]; then
  # lspci 형식: 38:00.0 → PCI:56:0:0 (16진수 → 10진수)
  BUS_HEX=$(echo "$GPU_PCI_SLOT" | cut -d: -f1)
  DEV_HEX=$(echo "$GPU_PCI_SLOT" | cut -d: -f2 | cut -d. -f1)
  FUNC_NUM=$(echo "$GPU_PCI_SLOT" | cut -d. -f2)
  BUS_DEC=$((16#$BUS_HEX))
  DEV_DEC=$((16#$DEV_HEX))
  echo "첫 번째 GPU BusID: PCI:${BUS_DEC}:${DEV_DEC}:${FUNC_NUM}"

  cat > /etc/X11/xorg.conf << XORGEOF
Section "ServerLayout"
    Identifier     "Layout0"
    Screen      0  "Screen0" 0 0
    InputDevice    "Keyboard0" "CoreKeyboard"
    InputDevice    "Mouse0" "CorePointer"
EndSection

Section "InputDevice"
    Identifier     "Keyboard0"
    Driver         "kbd"
EndSection

Section "InputDevice"
    Identifier     "Mouse0"
    Driver         "mouse"
EndSection

Section "Monitor"
    Identifier     "Monitor0"
    VendorName     "Unknown"
    ModelName      "Unknown"
EndSection

Section "Device"
    Identifier     "Device0"
    Driver         "nvidia"
    BusID          "PCI:${BUS_DEC}:${DEV_DEC}:${FUNC_NUM}"
    Option         "HardDPMS" "false"
EndSection

Section "Screen"
    Identifier     "Screen0"
    Device         "Device0"
    Monitor        "Monitor0"
    DefaultDepth    24
    SubSection     "Display"
        Virtual     4096 2160
        Depth       24
    EndSubSection
EndSection
XORGEOF
  echo "DCV 최적화 xorg.conf 생성 완료"
else
  echo "lspci에서 NVIDIA GPU를 찾을 수 없습니다. xorg.conf 생성을 건너뜁니다."
fi

# -----------------------------------------------------------------------------
# 3. nvidia-container-toolkit 설치 (DLAMI에 사전 설치된 경우 스킵)
# -----------------------------------------------------------------------------
if which nvidia-ctk > /dev/null 2>&1; then
  echo "nvidia-container-toolkit이 이미 설치되어 있습니다."
else
  echo "nvidia-container-toolkit을 설치합니다..."
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update
  apt-get install -y nvidia-container-toolkit
fi

# -----------------------------------------------------------------------------
# 4. Docker 재시작 + nvidia-persistenced 활성화
# -----------------------------------------------------------------------------
systemctl restart docker || true
systemctl enable nvidia-persistenced || true
systemctl start nvidia-persistenced || true

echo "===== [$(date)] END: nvidia-driver.sh ====="
