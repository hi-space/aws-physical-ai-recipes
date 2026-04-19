#!/usr/bin/env bash
# Workshop GR00T + SO-ARM 101 — One-click environment setup
#
# 사전 조건: newton-setup/setup.sh 실행 완료 (~/venv311 활성화 상태)
#
# 실행하면:
#   1. Python 환경 확인 (venv311 활성화 여부)
#   2. IsaacLab RL + rsl_rl 설치
#   3. 워크숍 추가 의존성 설치 (pandas, pyarrow, boto3, pyzmq)
#   4. 워크숍 패키지 editable 설치 (pip install -e .)
#   5. SO-ARM 101 URDF + STL 다운로드 (TheRobotStudio 공식)
#   6. 등록된 Gym 환경 목록 출력하여 검증
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URDF_DIR="${SCRIPT_DIR}/src/workshop/robots/urdf"
VENV_DIR="$HOME/venv311"

echo "=== Workshop GR00T + SO-ARM 101 Setup ==="
echo ""

# ------------------------------------------------------------------
# Step 1: Python 환경 확인
# ------------------------------------------------------------------
echo "[1/6] Checking Python environment..."

if [ -z "${VIRTUAL_ENV:-}" ]; then
    if [ -f "${VENV_DIR}/bin/activate" ]; then
        echo "  Activating venv: ${VENV_DIR}"
        source "${VENV_DIR}/bin/activate"
    else
        echo "  ERROR: No venv found at ${VENV_DIR}"
        echo "  Run newton-setup/setup.sh first to create the Python environment."
        exit 1
    fi
fi

PYTHON_VER=$(python --version 2>&1)
echo "  Python: ${PYTHON_VER} ($(which python))"

python -c "import isaaclab" 2>/dev/null || {
    echo "  ERROR: isaaclab not installed in current environment."
    echo "  Run newton-setup/setup.sh first."
    exit 1
}
echo "  isaaclab: OK"
echo ""

# ------------------------------------------------------------------
# Step 2: IsaacLab RL + rsl_rl 설치 (newton-setup이 빠뜨린 패키지)
# ------------------------------------------------------------------
ISAACLAB_DIR="$HOME/environment/IsaacLab"
echo "[2/6] Installing IsaacLab RL packages..."

if python -c "import isaaclab_rl" 2>/dev/null; then
    echo "  isaaclab_rl: already installed"
else
    echo "  Installing isaaclab_rl[rsl-rl] from IsaacLab source..."
    pip install --no-deps --editable "${ISAACLAB_DIR}/source/isaaclab_rl"
fi

if python -c "import rsl_rl" 2>/dev/null; then
    echo "  rsl_rl: already installed"
else
    echo "  Installing rsl-rl-lib..."
    pip install --quiet "rsl-rl-lib==3.0.1"
fi
echo ""

# ------------------------------------------------------------------
# Step 3: 워크숍 추가 의존성 설치
# ------------------------------------------------------------------
echo "[3/6] Installing workshop dependencies..."
pip install --quiet pandas pyarrow boto3 pyzmq h5py
echo "  pandas, pyarrow, boto3, pyzmq, h5py: OK"
echo ""

# ------------------------------------------------------------------
# Step 4: 워크숍 패키지 editable 설치
# ------------------------------------------------------------------
echo "[4/6] Installing workshop package (editable)..."
cd "${SCRIPT_DIR}"
pip install --no-deps --editable .
echo "  workshop package: OK"
echo ""

# ------------------------------------------------------------------
# Step 4: SO-ARM 101 URDF + STL 다운로드
# ------------------------------------------------------------------
if [ -f "${URDF_DIR}/so_arm101.urdf" ]; then
    echo "[5/6] URDF already exists, skipping download."
    echo "  ${URDF_DIR}/so_arm101.urdf"
else
    echo "[5/6] Downloading SO-ARM 101 URDF from TheRobotStudio/SO-ARM100..."

    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "${TEMP_DIR}"' EXIT

    git clone --depth 1 --filter=blob:none --sparse \
        https://github.com/TheRobotStudio/SO-ARM100.git \
        "${TEMP_DIR}/SO-ARM100"

    cd "${TEMP_DIR}/SO-ARM100"
    git sparse-checkout set Simulation/SO101
    cd "${SCRIPT_DIR}"

    SRC="${TEMP_DIR}/SO-ARM100/Simulation/SO101"

    if [ ! -f "${SRC}/so101_new_calib.urdf" ]; then
        echo "  ERROR: URDF not found in TheRobotStudio repo."
        echo "  Download manually from: https://github.com/TheRobotStudio/SO-ARM100/tree/main/Simulation/SO101"
        echo "  Place files in: ${URDF_DIR}/"
        exit 1
    fi

    mkdir -p "${URDF_DIR}/assets"
    cp "${SRC}/so101_new_calib.urdf" "${URDF_DIR}/so_arm101.urdf"
    cp "${SRC}"/assets/*.stl "${URDF_DIR}/assets/"

    echo "  URDF: ${URDF_DIR}/so_arm101.urdf"
    echo "  STL:  $(ls "${URDF_DIR}/assets/"*.stl | wc -l) mesh files"
fi
echo ""

# ------------------------------------------------------------------
# Step 5: 설치 검증
# ------------------------------------------------------------------
echo "[6/6] Verifying registered environments..."
list_envs
echo ""

echo "=== Setup complete ==="
echo ""
echo "Quick start:"
echo ""
echo "  # Module 1 Fast Track: Download HF dataset"
echo "  download_hf -h"
echo ""
echo "  # Module 1 Deep Dive: Train RL policy"
echo "  train_rl --task Workshop-SO101-Reach-v0"
echo ""
echo "  # Module 2+3: GR00T finetuning + Closed-loop"
echo "  closed_loop --policy_host localhost --instruction 'lift the cube'"
