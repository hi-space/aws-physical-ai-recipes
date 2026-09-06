#!/bin/bash
# Setup Isaac Lab environment for RL training on HyperPod
#
# This script:
#   1. Imports the Isaac Lab container (Isaac Sim 5.x + Isaac Lab 2.3, rsl_rl included) from NGC via Enroot
#   2. Copies workshop task package (SO-101 Reach/Lift) into accessible location
#   3. Clones LeIsaac (closed-loop evaluation) and installs it into the container
#   4. Creates necessary directories for checkpoints and logs
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

# nvcr.io/nvidia/isaac-lab:<tag> — Isaac Lab 2.3.0 bundles Isaac Sim 5.1 and installs
# isaaclab / isaaclab_rl / isaaclab_tasks / rsl_rl into the Isaac Sim Python (/isaac-sim/kit/python).
ISAAC_LAB_VERSION="${ISAAC_LAB_VERSION:-2.3.0}"
CONTAINER_URI="nvcr.io#nvidia/isaac-lab:${ISAAC_LAB_VERSION}"
CONTAINER_IMAGE="/fsx/enroot/data/isaaclab+latest.sqsh"
CONTAINER_VERSION_FILE="/fsx/enroot/data/isaaclab.version"
WORKSHOP_SRC="/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/isaac-lab-workshop"
WORKSHOP_DST="/fsx/scratch/isaaclab-workshop"

echo "=================================================="
echo "Isaac Lab Environment Setup for HyperPod"
echo "=================================================="
echo "Container:        nvcr.io/nvidia/isaac-lab:${ISAAC_LAB_VERSION}"
echo "Container Target: ${CONTAINER_IMAGE}"

# Step 1: Check prerequisites
echo ""
echo "[1/5] Checking prerequisites..."

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

# Step 2: Import Isaac Lab container via Enroot
echo ""
echo "[2/5] Setting up Isaac Lab container..."

export ENROOT_CACHE_PATH=/fsx/enroot
export ENROOT_DATA_PATH=/fsx/enroot/data
sudo mkdir -p /fsx/enroot/data   # /fsx/enroot is root-owned (enroot cache path); every enroot call below runs under sudo too

# A container left over from a different image version (e.g. the Isaac Sim 4.5 image)
# is removed so the rootfs and the sqsh always match ${ISAAC_LAB_VERSION}.
if [ -f "${CONTAINER_IMAGE}" ] && [ "$(cat "${CONTAINER_VERSION_FILE}" 2>/dev/null)" != "${ISAAC_LAB_VERSION}" ]; then
    echo "  Existing container is not isaac-lab:${ISAAC_LAB_VERSION} (version file: $(cat "${CONTAINER_VERSION_FILE}" 2>/dev/null || echo none)) — removing it."
    sudo ENROOT_DATA_PATH=/fsx/enroot/data enroot remove -f isaaclab 2>/dev/null || true
    sudo rm -f "${CONTAINER_IMAGE}" "${CONTAINER_VERSION_FILE}"
fi

if [ -f "${CONTAINER_IMAGE}" ]; then
    echo "  Container already exists at ${CONTAINER_IMAGE}"
    echo "  To force re-import, delete it first: rm ${CONTAINER_IMAGE} ${CONTAINER_VERSION_FILE}"
else
    echo "  Importing nvcr.io/nvidia/isaac-lab:${ISAAC_LAB_VERSION} (~15GB, may take 10-20 min)..."

    # Use NVMe for temp (FSx/Lustre doesn't support overlayfs whiteouts)
    NVME_TMP="/opt/dlami/nvme/enroot-tmp"
    sudo mkdir -p "${NVME_TMP}" 2>/dev/null || mkdir -p /tmp/enroot-tmp
    IMPORT_TMPDIR="${NVME_TMP:-/tmp/enroot-tmp}"

    sudo ENROOT_CACHE_PATH=/fsx/enroot ENROOT_DATA_PATH=/fsx/enroot/data \
        ENROOT_TEMP_PATH="${IMPORT_TMPDIR}" TMPDIR="${IMPORT_TMPDIR}" \
        enroot import --output "${CONTAINER_IMAGE}" "docker://${CONTAINER_URI}" || {
        echo "  WARNING: Container import failed. Continuing with workspace setup..."
        echo "  Possible causes:"
        echo "    - Network access to nvcr.io blocked"
        echo "    - Insufficient disk space on /fsx (need ~20GB free)"
        echo "    - NGC authentication required (write ~/.config/enroot/.credentials)"
        echo ""
        echo "  To import manually later:"
        echo "    sudo enroot import --output ${CONTAINER_IMAGE} docker://${CONTAINER_URI}"
        CONTAINER_IMPORT_FAILED=true
    }

    if [ "${CONTAINER_IMPORT_FAILED:-}" != "true" ]; then
        echo "${ISAAC_LAB_VERSION}" | sudo tee "${CONTAINER_VERSION_FILE}" > /dev/null
        echo "  Container imported successfully: ${CONTAINER_IMAGE}"
    fi
fi

if [ "${CONTAINER_IMPORT_FAILED:-}" != "true" ]; then
    # Pre-create container rootfs (avoids slow first-run extraction during training)
    if ! sudo ENROOT_DATA_PATH=/fsx/enroot/data enroot list 2>/dev/null | grep -q "^isaaclab$"; then
        echo "  Creating container rootfs (first time, ~5-10 min on FSx)..."
        sudo ENROOT_DATA_PATH=/fsx/enroot/data enroot create --name isaaclab "${CONTAINER_IMAGE}" || {
            echo "  WARNING: Container rootfs creation failed. Will be created on first sbatch run."
        }
    else
        echo "  Container rootfs already exists"
    fi

    # Pass-through rc script: the image's default entrypoint would start Isaac Sim itself.
    # Isaac Sim lives at /isaac-sim inside the isaac-lab image; Isaac Lab at /workspace/isaaclab.
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
fi

# Step 3: Prepare workshop task package
echo ""
echo "[3/5] Setting up workshop task package (SO-101 Reach/Lift)..."

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

# Step 4: LeIsaac for closed-loop evaluation
echo ""
echo "[4/5] Setting up LeIsaac (closed-loop evaluation)..."

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
    # Slurm 잡(root) 컨텍스트에서는 HOME이 비어 있어 git lfs가
    # "fatal: $HOME not set"으로 실패한다 - 명시적으로 지정한다.
    export HOME="${HOME:-/root}"
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
    sed -i 's/^monkey_patch()$/# monkey_patch()  # disabled: isaaclab 2.1+ already has this fix/' \
        "${LEISAAC_DIR}/source/leisaac/leisaac/utils/monkey_patch.py"
    echo "  Disabled monkey_patch (not needed with isaaclab 2.1+)"
fi

echo "  LeIsaac ready at ${LEISAAC_DIR}"

# Extra Python packages inside the container: MLflow tracking (train_isaaclab.py) and
# LeIsaac + its ZMQ transport (eval_closed_loop.sbatch). isaaclab / rsl_rl / gymnasium
# already ship in the isaac-lab image. "numpy<2" is pinned in the same resolve: Isaac Sim's
# compiled extensions are built against numpy 1.26 and fail to import under numpy 2.x.
if [ "${CONTAINER_IMPORT_FAILED:-}" != "true" ]; then
    echo "  Installing MLflow + LeIsaac packages into the container..."
    sudo ENROOT_DATA_PATH=/fsx/enroot/data enroot start --root --rw --rc /fsx/scratch/isaaclab_rc.sh \
        --mount /fsx:/fsx --env ACCEPT_EULA=Y --env PRIVACY_CONSENT=Y \
        isaaclab bash -c "
            python3 -m pip install --no-cache-dir \"numpy<2\" mlflow sagemaker-mlflow pyzmq msgpack 2>&1 | tail -2
            # Build from a scratch copy: enroot drops CAP_DAC_OVERRIDE, so container root cannot
            # write leisaac.egg-info into the ubuntu-owned checkout on /fsx (Permission denied).
            rm -rf /tmp/leisaac-src && cp -r /fsx/scratch/leisaac/source/leisaac /tmp/leisaac-src
            python3 -m pip install --no-cache-dir --no-deps /tmp/leisaac-src 2>&1 | tail -2
            rm -rf /tmp/leisaac-src
            python3 -c 'import importlib.metadata as m, numpy; assert numpy.__version__.startswith(\"1.\"), \"numpy must stay <2 for Isaac Sim: \" + numpy.__version__; print(\"  isaaclab\", m.version(\"isaaclab\"), \"rsl-rl-lib\", m.version(\"rsl-rl-lib\"), \"mlflow\", m.version(\"mlflow\"), \"leisaac\", m.version(\"leisaac\"), \"numpy\", numpy.__version__)'
        " || {
        echo "  WARNING: Package installation failed. finetune_isaaclab.sbatch retries on first run."
    }
fi

# Step 5: Create directories
echo ""
echo "[5/5] Creating directories..."
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
