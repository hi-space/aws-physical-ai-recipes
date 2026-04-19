#!/bin/bash -e
# =============================================================================
# common.sh - 시스템 공통 설정 스크립트
# =============================================================================
# 시스템 업데이트, 데스크톱 환경, NICE DCV, ROS, Docker 설치 및
# DCV 설정과 비밀번호 설정을 수행한다.
#
# 입력 환경 변수:
#   REGION    - AWS 리전 (예: us-east-1)
#   SECRET_ID - Secrets Manager Secret ARN
# =============================================================================

# 로그 리다이렉션 설정 - 모든 출력을 /var/log/user-data.log에 기록
exec > >(tee /var/log/user-data.log) 2>&1

echo "===== [$(date)] START: common.sh ====="

# -----------------------------------------------------------------------------
# 1. dpkg lock 해제 대기
#    Ubuntu AMI 부팅 직후 unattended-upgrades가 dpkg lock을 잡고 있을 수 있다.
#    lock이 해제될 때까지 최대 5분간 대기한다.
# -----------------------------------------------------------------------------
echo "dpkg lock 해제 대기 중..."
for i in $(seq 1 60); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
    echo "dpkg lock 해제 확인 (${i}회 시도)"
    break
  fi
  echo "dpkg lock 사용 중... 5초 대기 (${i}/60)"
  sleep 5
done

# unattended-upgrades 비활성화 (이후 lock 충돌 방지)
systemctl stop unattended-upgrades 2>/dev/null || true
systemctl disable unattended-upgrades 2>/dev/null || true

# -----------------------------------------------------------------------------
# 1.5. AWS CLI v2 fallback 설치
#      DLAMI에는 사전 설치되어 있으므로 스킵됨.
#      일반 Ubuntu AMI로 배포하는 경우를 대비한 보험 로직.
# -----------------------------------------------------------------------------
if ! which aws > /dev/null 2>&1; then
  echo "AWS CLI가 설치되어 있지 않습니다. AWS CLI v2를 설치합니다..."
  apt-get install -y unzip
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/aws
  echo "AWS CLI v2 설치 완료: $(aws --version)"
fi

# -----------------------------------------------------------------------------
# 2. 시스템 업데이트 및 업그레이드
# -----------------------------------------------------------------------------
apt-get update && apt-get upgrade -y

# -----------------------------------------------------------------------------
# 2. 데스크톱 환경 설치
#    Ubuntu 24.04에서는 install-desktop.sh가 GDM을 설치하지 않을 수 있으므로
#    ubuntu-desktop을 직접 설치한다.
# -----------------------------------------------------------------------------
UBUNTU_VERSION=$(lsb_release -rs)
if echo "$UBUNTU_VERSION" | grep -q "24.04"; then
  apt-get install -y ubuntu-desktop
else
  wget https://raw.githubusercontent.com/aws-samples/robotics-boilerplate/main/install-desktop.sh
  bash ./install-desktop.sh
fi

# -----------------------------------------------------------------------------
# 3. NICE DCV 설치
#    install-dcv.sh는 Ubuntu 22.04/18.04만 지원하므로,
#    Ubuntu 24.04에서는 직접 DCV 패키지를 다운로드하여 설치한다.
# -----------------------------------------------------------------------------
if echo "$UBUNTU_VERSION" | grep -q "24.04"; then
  echo "Ubuntu 24.04 감지 - DCV 직접 설치 (DCV GL 포함)"
  wget -q https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-ubuntu2404-x86_64.tgz
  tar -xvzf nice-dcv-ubuntu2404-x86_64.tgz
  cd nice-dcv-*-x86_64
  apt-get install -y ./nice-dcv-server_*.deb
  apt-get install -y ./nice-dcv-web-viewer_*.deb
  apt-get install -y ./nice-xdcv_*.deb
  apt-get install -y ./nice-dcv-gl_*.deb
  usermod -aG video dcv || true
  systemctl enable dcvserver || true
  cd /root
else
  echo "Ubuntu 22.04 감지 - DCV 설치 (DCV GL 포함)"
  wget https://raw.githubusercontent.com/aws-samples/robotics-boilerplate/main/install-dcv.sh
  bash ./install-dcv.sh
  # DCV GL 추가 설치 (install-dcv.sh가 DCV GL을 설치하지 않는 경우 대비)
  if ! dpkg -l nice-dcv-gl 2>/dev/null | grep -q "^ii"; then
    echo "DCV GL 미설치 감지 - DCV GL을 추가 설치합니다..."
    wget -q https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY
    gpg --import NICE-GPG-KEY 2>/dev/null || true
    wget -q https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-ubuntu2204-x86_64.tgz
    tar -xzf nice-dcv-ubuntu2204-x86_64.tgz
    cd nice-dcv-*-x86_64
    apt-get install -y ./nice-dcv-gl*.deb
    cd /root
  fi
fi

# DCV GL 활성화 (nvidia-driver.sh에서 xorg.conf 생성 후 reboot 시 적용됨)
if which dcvgladmin > /dev/null 2>&1; then
  dcvgladmin disable 2>/dev/null || true
  dcvgladmin enable 2>/dev/null || true
  echo "DCV GL 활성화 완료"
fi

# -----------------------------------------------------------------------------
# 4. ROS2 설치 (공식 저장소 사용)
#    ROS2_DISTRO 환경 변수로 배포판 결정 (humble/jazzy)
#    외부 install-ros.sh 스크립트 대신 직접 설치
# -----------------------------------------------------------------------------
echo "ROS2 ${ROS2_DISTRO} 설치 시작..."

# locale 설정
apt-get install -y locales
locale-gen en_US en_US.UTF-8 || true
update-locale LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
export LANG=en_US.UTF-8

# ROS2 GPG 키 및 저장소 등록
apt-get install -y software-properties-common curl
curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key -o /usr/share/keyrings/ros-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu $(. /etc/os-release && echo $UBUNTU_CODENAME) main" | tee /etc/apt/sources.list.d/ros2.list > /dev/null

# ROS2 설치
apt-get update
apt-get install -y ros-${ROS2_DISTRO}-desktop

# rosdep 초기화
# Ubuntu 24.04(Jazzy)에서는 python3-rosdep2 apt 패키지가 없고,
# DLAMI에 pip3도 미설치이므로 python3-pip 설치 후 pip로 rosdep 설치
if apt-cache show python3-rosdep2 2>/dev/null | grep -q "^Package:"; then
  apt-get install -y python3-rosdep2
else
  apt-get install -y python3-pip
  pip3 install --break-system-packages rosdep
fi
rosdep init 2>/dev/null || true
rosdep update || true

# ROS2 환경 설정을 .bashrc에 추가
echo "source /opt/ros/${ROS2_DISTRO}/setup.bash" >> /home/ubuntu/.bashrc

# -----------------------------------------------------------------------------
# 5. Docker 설치 (External_Script)
# -----------------------------------------------------------------------------
wget https://raw.githubusercontent.com/aws-samples/robotics-boilerplate/main/install-docker.sh
bash ./install-docker.sh

# ubuntu 사용자를 docker 그룹에 추가 (sudo 없이 docker 명령 실행 가능)
usermod -aG docker ubuntu || true

# 터미널 모노스페이스 폰트 설정 (DCV에서 글자 간격이 넓어지는 문제 방지)
runuser -l ubuntu -c "gsettings set org.gnome.desktop.interface monospace-font-name 'Mono Regular 12'" 2>/dev/null || true

# -----------------------------------------------------------------------------
# 6. DCV 설정 파일 작성
# -----------------------------------------------------------------------------
cat << 'EOF' > /etc/dcv/dcv.conf
[license]
[log]
[session-management]
create-session=true
[session-management/defaults]
[session-management/automatic-console-session]
owner = "ubuntu"
user = "ubuntu"
[display]
[connectivity]
web-port=8443
[security]
[clipboard]
primary-selection-paste=true
primary-selection-copy=true
EOF

# -----------------------------------------------------------------------------
# 7. 그래픽 관련 패키지 설치 및 GPU 설정
#    Ubuntu 24.04는 기본 Wayland 모드이므로 DCV를 위해 X11로 전환한다.
#    GPU X 설정은 NVIDIA 드라이버 설치 후에 실행해야 하므로
#    nvidia-driver.sh에서 처리한다.
# -----------------------------------------------------------------------------
apt install -y mesa-utils openbox
if echo "$UBUNTU_VERSION" | grep -q "24.04"; then
  echo "Ubuntu 24.04 - Wayland 비활성화 + GDM AutomaticLogin 설정"
  # GDM이 설치되어 있으면 설정 적용
  if [ -f /etc/gdm3/custom.conf ]; then
    sed -i '/\[daemon\]/a WaylandEnable=false\nAutomaticLoginEnable=true\nAutomaticLogin=ubuntu' /etc/gdm3/custom.conf 2>/dev/null || true
  fi
  systemctl set-default graphical.target || true
  systemctl enable gdm 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# 8. graphics-restart systemd 서비스 생성 및 활성화
#    DCV 서버 시작 후 그래픽 타겟을 재시작하여 디스플레이를 초기화한다.
# -----------------------------------------------------------------------------
cat << 'EOF' > /etc/systemd/system/graphics-restart.service
[Unit]
Description=Restart graphical.target
After=dcvserver.service

[Service]
ExecStart=/usr/bin/systemctl isolate graphical.target

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload || true
systemctl enable graphics-restart.service || true

# -----------------------------------------------------------------------------
# 9. Secrets Manager에서 비밀번호 조회 및 ubuntu 사용자 비밀번호 설정
#    Ubuntu 24.04에서 SSSD PAM 간섭으로 chpasswd가 실패할 수 있으므로
#    usermod --password로 직접 설정한다.
# -----------------------------------------------------------------------------
PASS=$(aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --output text --query SecretString --region ${REGION} | jq -r .password)
HASH=$(echo "$PASS" | openssl passwd -6 -stdin)
usermod --password "$HASH" ubuntu || true

echo "===== [$(date)] END: common.sh ====="
