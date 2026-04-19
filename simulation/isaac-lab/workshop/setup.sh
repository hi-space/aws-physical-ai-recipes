#!/usr/bin/env bash
# Workshop GR00T + SO-ARM 101 — One-click environment setup
#
# 1. Download SO-101 URDF + STL from TheRobotStudio (official)
# 2. Install Python dependencies via uv
# 3. Verify registered Isaac Lab environments
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URDF_DIR="${SCRIPT_DIR}/src/workshop/robots/urdf"

echo "=== Workshop GR00T + SO-ARM 101 Setup ==="
echo ""

if [ -f "${URDF_DIR}/so_arm101.urdf" ]; then
    echo "[1/3] URDF already exists, skipping download."
else
    echo "[1/3] Downloading SO-ARM 101 URDF from TheRobotStudio/SO-ARM100..."

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

echo "[2/3] Installing Python dependencies (uv sync)..."
cd "${SCRIPT_DIR}"
uv sync
echo ""

echo "[3/3] Verifying registered environments..."
uv run list_envs
echo ""

echo "=== Setup complete ==="
echo ""
echo "Quick start:"
echo ""
echo "  # Module 1 Fast Track: Download HF dataset"
echo "  uv run download_hf -h"
echo ""
echo "  # Module 1 Deep Dive: Train RL policy"
echo "  uv run train_rl --task Workshop-SO101-Reach-v0"
echo ""
echo "  # Module 2+3: GR00T finetuning + Closed-loop"
echo "  uv run closed_loop --policy_host localhost --instruction 'lift the cube'"
