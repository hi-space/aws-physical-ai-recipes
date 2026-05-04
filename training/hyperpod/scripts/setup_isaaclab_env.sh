#!/bin/bash
# Setup Isaac Lab environment for RL training on HyperPod
#
# This script:
#   1. Imports Isaac Sim container from NGC via Enroot
#   2. Copies workshop task package (SO-101 Reach/Lift) into accessible location
#   3. Creates necessary directories for checkpoints and logs
#
# Prerequisites:
#   - FSx mounted at /fsx
#   - Enroot installed (available on HyperPod compute nodes)
#   - Network access to nvcr.io (NGC container registry)
#   - aws-physical-ai-recipes repo cloned at /fsx/scratch/aws-physical-ai-recipes
#
# Usage:
#   bash setup_isaaclab_env.sh
#
# After setup:
#   sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/rl/finetune_isaaclab.sbatch

set -e

ISAAC_SIM_VERSION="${ISAAC_SIM_VERSION:-4.5.0}"
CONTAINER_IMAGE="/fsx/enroot/data/isaaclab+latest.sqsh"
WORKSHOP_SRC="/fsx/scratch/aws-physical-ai-recipes/isaac-lab-workshop/exp/workshop"
WORKSHOP_DST="/fsx/scratch/isaaclab-workshop"

echo "=================================================="
echo "Isaac Lab Environment Setup for HyperPod"
echo "=================================================="
echo "Isaac Sim Version: ${ISAAC_SIM_VERSION}"
echo "Container Target: ${CONTAINER_IMAGE}"

# Step 1: Check prerequisites
echo ""
echo "[1/4] Checking prerequisites..."

if ! command -v enroot &>/dev/null; then
    echo "ERROR: enroot not found. This script must run on a HyperPod node."
    echo "  Enroot is pre-installed on compute nodes."
    echo "  If running from head node, submit as a SLURM job or SSH to compute node."
    exit 1
fi

if [ ! -d "/fsx" ]; then
    echo "ERROR: /fsx not mounted. FSx for Lustre is required."
    exit 1
fi

if [ ! -d "/fsx/scratch/aws-physical-ai-recipes" ]; then
    echo "ERROR: Recipe repository not found at /fsx/scratch/aws-physical-ai-recipes"
    echo "  Run: git clone --depth 1 https://github.com/hi-space/aws-physical-ai-recipes.git /fsx/scratch/aws-physical-ai-recipes"
    exit 1
fi

echo "  Prerequisites OK"

# Step 2: Import Isaac Sim container via Enroot
echo ""
echo "[2/4] Setting up Isaac Sim container..."

if [ -f "${CONTAINER_IMAGE}" ]; then
    echo "  Container already exists at ${CONTAINER_IMAGE}"
    echo "  To force re-import, delete it first: rm ${CONTAINER_IMAGE}"
else
    echo "  Importing nvcr.io/nvidia/isaac-sim:${ISAAC_SIM_VERSION} (~20GB, may take 10-15 min)..."

    mkdir -p /fsx/enroot/data /fsx/enroot/tmp
    export ENROOT_CACHE_PATH=/fsx/enroot
    export ENROOT_DATA_PATH=/fsx/enroot/data
    export TMPDIR=/fsx/enroot/tmp

    sudo enroot import --output "${CONTAINER_IMAGE}" \
        "docker://nvcr.io#nvidia/isaac-sim:${ISAAC_SIM_VERSION}" || {
        echo "  WARNING: Container import failed. Continuing with workspace setup..."
        echo "  Possible causes:"
        echo "    - Network access to nvcr.io blocked"
        echo "    - Insufficient disk space on /fsx (need ~20GB free)"
        echo "    - NGC authentication required (set NGC_API_KEY)"
        echo ""
        echo "  To import manually later:"
        echo "    sudo enroot import --output ${CONTAINER_IMAGE} docker://nvcr.io#nvidia/isaac-sim:${ISAAC_SIM_VERSION}"
        CONTAINER_IMPORT_FAILED=true
    }

    if [ "${CONTAINER_IMPORT_FAILED:-}" != "true" ]; then
        echo "  Container imported successfully: ${CONTAINER_IMAGE}"

        # Pre-create container rootfs (avoids slow first-run extraction during training)
        if ! enroot list 2>/dev/null | grep -q "^isaaclab$"; then
            echo "  Creating container rootfs (first time, ~5-10 min on FSx)..."
            sudo enroot create --name isaaclab "${CONTAINER_IMAGE}" || {
                echo "  WARNING: Container rootfs creation failed. Will be created on first sbatch run."
            }
        else
            echo "  Container rootfs already exists"
        fi

        # Patch entrypoint to pass through commands (default always runs runheadless.sh)
        ROOTFS_PATH="/fsx/enroot/data/isaaclab"
        if [ -d "${ROOTFS_PATH}" ]; then
            echo "  Patching container entrypoint for command passthrough..."
            sudo tee "${ROOTFS_PATH}/etc/rc" > /dev/null << 'RCEOF'
mkdir -p "/isaac-sim" 2> /dev/null
cd "/isaac-sim" && unset OLDPWD || exit 1
export PATH=/isaac-sim/kit/python/bin:/isaac-sim:$PATH
export LD_LIBRARY_PATH=/isaac-sim/kit/python/lib:/isaac-sim/kit/libs:$LD_LIBRARY_PATH
export ISAAC_SIM_PATH=/isaac-sim
if [ -s /etc/rc.local ]; then . /etc/rc.local; fi
if [ $# -gt 0 ]; then exec "$@"; else exec /bin/sh -c /isaac-sim/runheadless.sh; fi
RCEOF

            # Install RL packages (uses chroot to avoid 5-min entrypoint startup)
            echo "  Installing Isaac Lab RL packages..."
            sudo cp /etc/resolv.conf "${ROOTFS_PATH}/etc/resolv.conf"
            sudo chroot "${ROOTFS_PATH}" /bin/bash -c \
                "export LD_LIBRARY_PATH=/isaac-sim/kit/python/lib:/isaac-sim/kit/libs:\$LD_LIBRARY_PATH && \
                 /isaac-sim/kit/python/bin/python3 -m pip install --no-build-isolation \
                 isaaclab rsl-rl-lib gymnasium pyzmq msgpack 2>&1 | tail -5" || {
                echo "  WARNING: Package installation failed. Will retry on first sbatch run."
            }
        fi
    fi
fi

# Step 3: Prepare workshop task package
echo ""
echo "[3/4] Setting up workshop task package (SO-101 Reach/Lift)..."

if [ -d "${WORKSHOP_SRC}" ]; then
    mkdir -p "${WORKSHOP_DST}"
    if [ ! -d "${WORKSHOP_DST}/src" ]; then
        cp -r "${WORKSHOP_SRC}/src" "${WORKSHOP_DST}/"
        cp -r "${WORKSHOP_SRC}/pyproject.toml" "${WORKSHOP_DST}/" 2>/dev/null || true
        echo "  Workshop package copied to ${WORKSHOP_DST}"
    else
        echo "  Workshop package already exists at ${WORKSHOP_DST}"
    fi
else
    echo "  WARNING: Workshop source not found at ${WORKSHOP_SRC}"
    echo "  SO-101 custom tasks will not be available."
    echo "  You can still use built-in Isaac Lab tasks (e.g., Isaac-Cartpole-v0)"
fi

# Step 4: Create directories
echo ""
echo "[4/4] Creating directories..."
mkdir -p /fsx/checkpoints/rl /fsx/scratch/logs
chmod 777 /fsx/checkpoints/rl 2>/dev/null || true
echo "  Directories ready"

echo ""
echo "=================================================="
if [ "${CONTAINER_IMPORT_FAILED:-}" = "true" ]; then
    echo "Setup partially complete (container import failed — see above)"
    echo ""
    echo "Workshop tasks and directories are ready."
    echo "Import the container manually before submitting RL jobs."
else
    echo "Setup complete!"
fi
echo ""
echo "Available tasks:"
echo "  - Workshop-SO101-Reach-v0 (5-DOF arm reaching)"
echo "  - Workshop-SO101-Lift-v0  (5-DOF arm + gripper lifting)"
echo "  - Isaac-Cartpole-v0       (built-in, no workshop package needed)"
echo ""
echo "Submit training:"
echo "  sbatch /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/slurm-templates/rl/finetune_isaaclab.sbatch"
echo ""
echo "Or with custom settings:"
echo "  TASK=Workshop-SO101-Lift-v0 MAX_ITERATIONS=500 sbatch finetune_isaaclab.sbatch"
echo "=================================================="
