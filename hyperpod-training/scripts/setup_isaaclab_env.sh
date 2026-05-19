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
#   sbatch /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/slurm-templates/rl/finetune_isaaclab.sbatch

set -e

ISAAC_SIM_VERSION="${ISAAC_SIM_VERSION:-4.5.0}"
CONTAINER_IMAGE="/fsx/enroot/data/isaaclab+latest.sqsh"
WORKSHOP_SRC="/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/isaac-lab-workshop"
WORKSHOP_DST="/fsx/scratch/isaaclab-workshop"

echo "=================================================="
echo "Isaac Lab Environment Setup for HyperPod"
echo "=================================================="
echo "Isaac Sim Version: ${ISAAC_SIM_VERSION}"
echo "Container Target: ${CONTAINER_IMAGE}"

# Step 1: Check prerequisites
echo ""
echo "[1/6] Checking prerequisites..."

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
echo "[2/6] Setting up Isaac Sim container..."

if [ -f "${CONTAINER_IMAGE}" ]; then
    echo "  Container already exists at ${CONTAINER_IMAGE}"
    echo "  To force re-import, delete it first: rm ${CONTAINER_IMAGE}"
else
    echo "  Importing nvcr.io/nvidia/isaac-sim:${ISAAC_SIM_VERSION} (~20GB, may take 10-15 min)..."

    mkdir -p /fsx/enroot/data
    export ENROOT_CACHE_PATH=/fsx/enroot
    export ENROOT_DATA_PATH=/fsx/enroot/data

    # Use NVMe for temp (FSx/Lustre doesn't support overlayfs whiteouts)
    NVME_TMP="/opt/dlami/nvme/enroot-tmp"
    sudo mkdir -p "${NVME_TMP}" 2>/dev/null || mkdir -p /tmp/enroot-tmp
    IMPORT_TMPDIR="${NVME_TMP:-/tmp/enroot-tmp}"

    sudo ENROOT_CACHE_PATH=/fsx/enroot ENROOT_DATA_PATH=/fsx/enroot/data \
        ENROOT_TEMP_PATH="${IMPORT_TMPDIR}" TMPDIR="${IMPORT_TMPDIR}" \
        enroot import --output "${CONTAINER_IMAGE}" \
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

        # Create pass-through rc script (Isaac Sim default runs runheadless.sh)
        cat > /fsx/scratch/isaaclab_rc.sh << 'RCEOF'
#!/bin/bash
cd /isaac-sim || exit 1
export PATH=/isaac-sim/kit/python/bin:/isaac-sim:$PATH
export LD_LIBRARY_PATH=/isaac-sim/kit/python/lib:/isaac-sim/kit/libs:$LD_LIBRARY_PATH
export ISAAC_SIM_PATH=/isaac-sim
export ISAAC_PATH=/isaac-sim
export CARB_APP_PATH=/isaac-sim/kit
export EXP_PATH=/isaac-sim/apps
source /isaac-sim/setup_python_env.sh
exec "$@"
RCEOF
        chmod +x /fsx/scratch/isaaclab_rc.sh
        echo "  Created pass-through rc script at /fsx/scratch/isaaclab_rc.sh"

        # Install packages via enroot start (avoids chroot FSx access issues)
        echo "  Installing Isaac Lab + LeIsaac packages..."
        sudo enroot start --root --rw --rc /fsx/scratch/isaaclab_rc.sh \
            --mount /fsx:/fsx --env ACCEPT_EULA=Y --env PRIVACY_CONSENT=Y \
            isaaclab bash -c "
                python3 -m pip install setuptools wheel 2>&1 | tail -1
                python3 -m pip install isaaclab rsl-rl-lib gymnasium pyzmq msgpack 2>&1 | tail -3
                python3 -m pip install -e /fsx/scratch/IsaacLab/source/isaaclab_tasks --no-deps 2>&1 | tail -3
                python3 -m pip install /fsx/scratch/leisaac/source/leisaac --no-deps 2>&1 | tail -3
            " || {
            echo "  WARNING: Package installation failed. Will retry on first sbatch run."
        }
    fi
fi

# Step 3: Prepare workshop task package
echo ""
echo "[3/6] Setting up workshop task package (SO-101 Reach/Lift)..."

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

# Step 4: Clone IsaacLab source (needed for isaaclab_rl.rsl_rl on PYTHONPATH)
echo ""
echo "[4/6] Setting up IsaacLab source..."

ISAACLAB_DIR="/fsx/scratch/IsaacLab"
if [ -d "${ISAACLAB_DIR}/source/isaaclab_rl" ]; then
    echo "  IsaacLab source already exists at ${ISAACLAB_DIR}"
else
    echo "  Cloning IsaacLab source (sparse checkout, source/ only)..."
    git clone --depth 1 --filter=blob:none --sparse \
        https://github.com/isaac-sim/IsaacLab.git "${ISAACLAB_DIR}" 2>/dev/null || true
    cd "${ISAACLAB_DIR}" && git sparse-checkout set source/ 2>/dev/null || true
    echo "  IsaacLab source ready at ${ISAACLAB_DIR}"
fi

# Step 5: Install LeIsaac for closed-loop evaluation
echo ""
echo "[5/6] Setting up LeIsaac (closed-loop evaluation)..."

LEISAAC_DIR="/fsx/scratch/leisaac"

if [ -d "${LEISAAC_DIR}" ]; then
    echo "  LeIsaac already exists at ${LEISAAC_DIR}, updating..."
    cd "${LEISAAC_DIR}" && git pull 2>/dev/null || true
else
    echo "  Cloning LeIsaac (with LFS assets)..."
    git clone https://github.com/lightwheelai/leisaac.git "${LEISAAC_DIR}"
fi

# Ensure Git LFS assets are downloaded (USD scenes for simulation)
cd "${LEISAAC_DIR}"
if ! find assets/scenes -name "*.usd" 2>/dev/null | grep -q .; then
    echo "  Downloading LFS assets (USD scenes)..."
    git lfs install
    git lfs pull
    # If assets were removed in latest commit, restore from history
    if ! find assets/scenes -name "*.usd" 2>/dev/null | grep -q .; then
        ASSET_COMMIT=$(git log --all --oneline -- assets/scenes/ | grep -v "clean" | head -1 | cut -d' ' -f1)
        if [ -n "${ASSET_COMMIT}" ]; then
            git checkout "${ASSET_COMMIT}" -- assets/scenes/ assets/robots/ 2>/dev/null || true
            git lfs checkout assets/ 2>/dev/null || true
        fi
    fi
fi

# Disable monkey_patch if isaaclab >= 2.1 (already has the termination fix)
if grep -q "^monkey_patch()" "${LEISAAC_DIR}/source/leisaac/leisaac/utils/monkey_patch.py" 2>/dev/null; then
    sed -i 's/^monkey_patch()$/# monkey_patch()  # disabled: isaaclab 2.1 already has this fix/' \
        "${LEISAAC_DIR}/source/leisaac/leisaac/utils/monkey_patch.py"
    echo "  Disabled monkey_patch (not needed with isaaclab 2.1+)"
fi

echo "  LeIsaac ready at ${LEISAAC_DIR}"

# Step 6: Create directories
echo ""
echo "[6/6] Creating directories..."
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
echo "  sbatch /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/slurm-templates/rl/finetune_isaaclab.sbatch"
echo ""
echo "Or with custom settings:"
echo "  TASK=Workshop-SO101-Lift-v0 MAX_ITERATIONS=500 sbatch finetune_isaaclab.sbatch"
echo ""
echo "Closed-loop evaluation (LeIsaac):"
echo "  sbatch /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/slurm-templates/vla/eval_closed_loop.sbatch"
echo "=================================================="
