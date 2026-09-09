#!/bin/bash
# Setup the MuJoCo (CPU) RL environment on HyperPod — module 9B
#
# This script:
#   1. Creates a Python venv on FSx (/fsx/envs/mujoco) shared by every node
#   2. Installs CPU-only PyTorch, MuJoCo, Gymnasium, Stable-Baselines3, TensorBoard, imageio
#   3. Checks out the SO-101 MJCF (google-deepmind/mujoco_menagerie, pinned commit) to FSx
#   4. Installs the workshop task package (Workshop-SO101-Reach-MuJoCo-v0) into the venv
#   5. Creates checkpoint/log directories and runs a 50-step smoke rollout
#
# Unlike setup_isaaclab_env.sh (15 GB container import, must run on a GPU node) this only
# downloads a few hundred MB of wheels, so it runs on the head node directly — no srun needed.
#
# Prerequisites:
#   - FSx mounted at /fsx
#   - Network access to PyPI, download.pytorch.org and github.com
#   - aws-physical-ai-recipes at /fsx/scratch/aws-physical-ai-recipes
#
# Usage (head node):
#   bash /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/scripts/setup_mujoco_env.sh
#
# After setup:
#   sbatch /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/slurm-templates/rl/train_mujoco.sbatch

set -euo pipefail

# Slurm 노드에서는 ubuntu 사용자가 sudo 로 root 소유 /fsx 경로를 만들지만, EKS Job 컨테이너(root, sudo 없음)에서도
# 같은 스크립트를 쓰므로 sudo 가 없으면 그냥 실행한다.
SUDO="$(command -v sudo || true)"

VENV_DIR="${VENV_DIR:-/fsx/envs/mujoco}"
RECIPES_DIR="${RECIPES_DIR:-/fsx/scratch/aws-physical-ai-recipes}"
WORKSHOP_PKG="${RECIPES_DIR}/hyperpod-training/mujoco-workshop"
MENAGERIE_DIR="${MUJOCO_MENAGERIE_DIR:-/fsx/scratch/mujoco_menagerie}"
MENAGERIE_REPO="https://github.com/google-deepmind/mujoco_menagerie.git"
# Keep in sync with mujoco-workshop/src/mujoco_workshop/assets.py
MENAGERIE_COMMIT="ac6b2b09983786f3036cab1000221017fa2193b4"
MODEL_SUBDIR="robotstudio_so101"

echo "=================================================="
echo "MuJoCo (CPU) RL Environment Setup for HyperPod"
echo "=================================================="
echo "venv:       ${VENV_DIR}"
echo "task pkg:   ${WORKSHOP_PKG}"
echo "menagerie:  ${MENAGERIE_DIR}/${MODEL_SUBDIR} @ ${MENAGERIE_COMMIT:0:7}"

# Step 1: prerequisites
echo ""
echo "[1/5] Checking prerequisites..."
if ! mountpoint -q /fsx; then
    echo "ERROR: /fsx is not mounted. Run this on a HyperPod node (head node is fine)."
    exit 1
fi
if [ ! -d "${WORKSHOP_PKG}" ]; then
    echo "ERROR: ${WORKSHOP_PKG} not found. Download the workshop code to /fsx/scratch first (module 9B)."
    exit 1
fi
if ! python3 -c "import venv, ensurepip" 2>/dev/null; then
    echo "python3-venv missing, installing (sudo apt-get)..."
    ${SUDO} apt-get update -qq && ${SUDO} apt-get install -y -qq python3-venv
fi
command -v git >/dev/null || { echo "ERROR: git not found"; exit 1; }
echo "Prerequisites OK ($(python3 --version), $(nproc) CPUs)"

# Step 2: directories
echo ""
echo "[2/5] Creating directories..."
${SUDO} mkdir -p /fsx/envs /fsx/checkpoints/rl /fsx/scratch/logs
${SUDO} chmod 777 /fsx/envs /fsx/checkpoints/rl /fsx/scratch/logs
echo "Directories ready."

# Step 3: SO-101 MJCF from mujoco_menagerie (sparse checkout — the full repo is ~1 GB of meshes)
echo ""
echo "[3/5] Fetching SO-101 MJCF (mujoco_menagerie/${MODEL_SUBDIR})..."
if [ -f "${MENAGERIE_DIR}/${MODEL_SUBDIR}/scene.xml" ] && \
   [ "$(git -C "${MENAGERIE_DIR}" rev-parse HEAD 2>/dev/null)" = "${MENAGERIE_COMMIT}" ]; then
    echo "Already present at the pinned commit, skipping."
else
    rm -rf "${MENAGERIE_DIR}"
    git clone --quiet --filter=blob:none --no-checkout --sparse "${MENAGERIE_REPO}" "${MENAGERIE_DIR}"
    git -C "${MENAGERIE_DIR}" sparse-checkout set "${MODEL_SUBDIR}"
    git -C "${MENAGERIE_DIR}" checkout --quiet "${MENAGERIE_COMMIT}"
    echo "Checked out ${MODEL_SUBDIR} ($(du -sh --apparent-size "${MENAGERIE_DIR}/${MODEL_SUBDIR}" | cut -f1))."
fi

# Step 4: venv + packages
echo ""
echo "[4/5] Creating venv and installing packages (CPU-only torch, ~3 min)..."
if [ ! -x "${VENV_DIR}/bin/python" ]; then
    python3 -m venv "${VENV_DIR}"
fi
# --no-cache-dir: the head node root volume is small; wheels go straight into the FSx venv.
"${VENV_DIR}/bin/pip" install --quiet --no-cache-dir --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
"${VENV_DIR}/bin/pip" install --quiet --no-cache-dir \
    "mujoco>=3.1.3,<4" "gymnasium[mujoco]>=1.0,<2" "stable-baselines3>=2.3,<3" \
    tensorboard "imageio[ffmpeg]" "numpy<3"
"${VENV_DIR}/bin/pip" install --quiet --no-cache-dir -e "${WORKSHOP_PKG}"
echo "Packages installed:"
"${VENV_DIR}/bin/python" - <<'PY'
import importlib.metadata as m
for p in ("torch", "mujoco", "gymnasium", "stable-baselines3", "mujoco-workshop"):
    print(f"  {p:22s} {m.version(p)}")
PY

# Step 5: smoke rollout (50 random steps) — proves the MJCF loads and the task ID is registered
echo ""
echo "[5/5] Smoke test: 50 random steps in Workshop-SO101-Reach-MuJoCo-v0..."
MUJOCO_MENAGERIE_DIR="${MENAGERIE_DIR}" "${VENV_DIR}/bin/python" - <<'PY'
import time, gymnasium as gym, mujoco_workshop  # noqa: F401
env = gym.make("Workshop-SO101-Reach-MuJoCo-v0")
obs, info = env.reset(seed=0)
t = time.time()
for _ in range(50):
    obs, r, term, trunc, info = env.step(env.action_space.sample())
print(f"verify: env OK (obs dim {obs.shape[0]}, {int(50 / (time.time() - t))} steps/s single process, "
      f"distance to target {info['distance']*100:.1f} cm)")
PY

echo ""
echo "=================================================="
echo "Setup complete!"
echo "=================================================="
echo "Next: submit a training job from the head node:"
echo "  sbatch ${RECIPES_DIR}/hyperpod-training/slurm-templates/rl/train_mujoco.sbatch"
