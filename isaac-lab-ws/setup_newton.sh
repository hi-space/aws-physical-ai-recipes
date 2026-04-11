#!/usr/bin/env bash
# IsaacLab feature/newton 브랜치 원클릭 셋업 스크립트
# Ubuntu 22.04 + Python 3.11 + isaacsim 5.1.0
#
# 사용법:
#   cd ~/docs && bash setup_newton.sh
#
# 완료 후:
#   source ~/.bashrc
#   cd ~/environment/IsaacLab
#   python scripts/reinforcement_learning/skrl/train.py --task=Isaac-Ant-v0

set -e

VENV_DIR="$HOME/venv311"
DOCS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISAACLAB_DIR="$HOME/environment/IsaacLab"
NVIDIA_INDEX="https://pypi.nvidia.com"

# 색상 출력
info()  { echo -e "\033[1;34m[INFO]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m $*"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $*"; exit 1; }

# ============================================================
# 0. IsaacLab 디렉토리 확인 및 파일 복사
# ============================================================
if [ ! -d "$ISAACLAB_DIR" ]; then
    error "IsaacLab 디렉토리가 없음: $ISAACLAB_DIR"
fi

info "requirements_newton.txt → $ISAACLAB_DIR 복사"
cp "$DOCS_DIR/requirements_newton.txt" "$ISAACLAB_DIR/requirements_newton.txt"
ok "파일 복사 완료"

# ============================================================
# 1. Python 3.11
# ============================================================
info "Python 3.11 확인 중..."
if command -v python3.11 &>/dev/null; then
    ok "python3.11 이미 설치됨: $(python3.11 --version)"
else
    info "deadsnakes PPA에서 Python 3.11 설치 중..."
    sudo add-apt-repository ppa:deadsnakes/ppa -y
    sudo apt-get update
    sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
    ok "Python 3.11 설치 완료"
fi

# python 심볼릭 링크 (isaaclab.sh가 python을 호출)
if ! command -v python &>/dev/null; then
    info "'python' 심볼릭 링크 생성..."
    sudo ln -sf /usr/bin/python3 /usr/bin/python
fi

# ============================================================
# 2. venv 생성
# ============================================================
if [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/activate" ]; then
    ok "venv 이미 존재: $VENV_DIR"
else
    info "Python 3.11 venv 생성: $VENV_DIR"
    python3.11 -m venv "$VENV_DIR"
    ok "venv 생성 완료"
fi

source "$VENV_DIR/bin/activate"
info "venv 활성화됨: $(python --version) @ $(which python)"

# ============================================================
# 3. ~/.bashrc 환경변수 설정
# ============================================================
info "~/.bashrc 환경변수 설정 중..."

append_if_missing() {
    local marker="$1"
    local content="$2"
    if ! grep -qF "$marker" "$HOME/.bashrc" 2>/dev/null; then
        echo "" >> "$HOME/.bashrc"
        echo "$content" >> "$HOME/.bashrc"
        info "  추가됨: $marker"
    else
        info "  이미 있음: $marker"
    fi
}

append_if_missing "ACCEPT_EULA=Y" "# NVIDIA Omniverse EULA
export ACCEPT_EULA=Y"

append_if_missing "OMNI_KIT_ACCEPT_EULA=YES" "export OMNI_KIT_ACCEPT_EULA=YES"

append_if_missing "source ~/venv311/bin/activate" "# Isaac Lab venv (Python 3.11)
source ~/venv311/bin/activate"

append_if_missing "LAUNCH_OV_APP" "# IsaacLab: SimulationApp 모드 강제 (pxr import 필요)
export LAUNCH_OV_APP=1"

# 현재 셸에도 적용
export ACCEPT_EULA=Y
export OMNI_KIT_ACCEPT_EULA=YES
export LAUNCH_OV_APP=1

ok "환경변수 설정 완료"

# ============================================================
# 4. pip 의존성 설치 (requirements_newton.txt)
# ============================================================
info "pip 의존성 설치 중 (시간이 걸릴 수 있습니다)..."

REQUIREMENTS="$ISAACLAB_DIR/requirements_newton.txt"
if [ ! -f "$REQUIREMENTS" ]; then
    error "requirements_newton.txt를 찾을 수 없음: $REQUIREMENTS"
fi

pip install --upgrade pip
pip install --no-build-isolation flatdict==4.0.1
pip install -r "$REQUIREMENTS" --extra-index-url "$NVIDIA_INDEX"

ok "pip 의존성 설치 완료"

# ============================================================
# 5. IsaacLab 패키지 설치
# ============================================================
info "IsaacLab 패키지 설치 중..."

cd "$ISAACLAB_DIR"

# isaaclab.sh --install로 설치 가능한 것들 먼저
info "  ./isaaclab.sh --install 실행..."
TERM=${TERM:-xterm} ./isaaclab.sh --install 2>&1 | tail -5

# 핵심 패키지 수동 설치 (omniverseclient 의존성 우회)
MANUAL_PACKAGES=(
    "source/isaaclab"
    "source/isaaclab_experimental"
    "source/isaaclab_newton"
)

for pkg in "${MANUAL_PACKAGES[@]}"; do
    pkg_name=$(basename "$pkg")
    if pip show "$pkg_name" &>/dev/null; then
        info "  $pkg_name 이미 설치됨, 건너뜀"
    else
        info "  $pkg_name 설치 중 (--no-deps)..."
        pip install --no-deps --editable "$pkg"
    fi
done

ok "IsaacLab 패키지 설치 완료"

# ============================================================
# 6. 설치 검증
# ============================================================
info "설치 검증 중..."

echo ""
echo "=== 설치된 isaaclab 패키지 ==="
pip list 2>/dev/null | grep -i isaaclab
echo ""

python -c "from isaaclab.app import AppLauncher; print('[OK] isaaclab import 성공')" 2>&1

echo ""
echo "=== 핵심 패키지 버전 ==="
python -c "
import importlib
pkgs = ['isaacsim', 'newton', 'warp', 'torch', 'skrl', 'mujoco', 'mujoco_warp']
for p in pkgs:
    try:
        m = importlib.import_module(p)
        v = getattr(m, '__version__', '(버전 없음)')
        print(f'  {p}: {v}')
    except ImportError:
        print(f'  {p}: [NOT INSTALLED]')
" 2>&1

echo ""
ok "============================================"
ok " 셋업 완료!"
ok ""
ok " 학습 실행:"
ok "   source ~/.bashrc"
ok "   cd $ISAACLAB_DIR"
ok "   python scripts/reinforcement_learning/skrl/train.py --task=Isaac-Ant-v0"
ok "============================================"
