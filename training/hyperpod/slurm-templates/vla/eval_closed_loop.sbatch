#!/bin/bash
#SBATCH --job-name=groot-closed-loop
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:4
#SBATCH --time=1:00:00
#SBATCH --output=/fsx/scratch/logs/closed-loop-%j.out
#SBATCH --error=/fsx/scratch/logs/closed-loop-%j.err

# GR00T Closed-loop Evaluation with LeIsaac PickOrange
#
# Runs on a single HyperPod compute node (4x GPU):
#   GPU 0: GR00T Policy Server (ZMQ, gr00t.eval.run_gr00t_server)
#   GPU 1-3: Isaac Sim with LeIsaac PickOrange environment (headless)
#
# Prerequisites:
#   - GR00T venv at /fsx/envs/gr00t (run setup_groot_env.sh)
#   - Isaac Sim container: /fsx/enroot/data/isaaclab+latest.sqsh (run setup_isaaclab_env.sh)
#   - LeIsaac at /fsx/scratch/leisaac
#   - Trained GR00T checkpoint
#
# Usage:
#   sbatch eval_closed_loop.sbatch
#   MODEL_PATH=/fsx/checkpoints/vla/groot-so101-place-orange/checkpoint-2000 sbatch eval_closed_loop.sbatch
#
# Environment Variables:
#   MODEL_PATH: GR00T checkpoint path (default: /fsx/checkpoints/vla/groot-so101-place-orange/checkpoint-2000)
#   EMBODIMENT_TAG: Embodiment tag (default: new_embodiment)
#   MODALITY_CONFIG: Modality config path
#   INSTRUCTION: Language instruction (default: "pick up the orange")
#   EVAL_ROUNDS: Number of evaluation episodes (default: 10)
#   POLICY_PORT: ZMQ port for policy server (default: 5555)

set -e

MODEL_PATH="${MODEL_PATH:-/fsx/checkpoints/vla/groot-so101-place-orange/checkpoint-2000}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-NEW_EMBODIMENT}"
MODALITY_CONFIG="${MODALITY_CONFIG:-/fsx/scratch/aws-physical-ai-recipes/training/hyperpod/configs/so101_modality.py}"
INSTRUCTION="${INSTRUCTION:-pick up the orange}"
EVAL_ROUNDS="${EVAL_ROUNDS:-10}"
POLICY_PORT="${POLICY_PORT:-5555}"

GROOT_ENV="/fsx/envs/gr00t"
GROOT_REPO="/fsx/scratch/Isaac-GR00T"
CONTAINER_IMAGE="/fsx/enroot/data/isaaclab+latest.sqsh"
LEISAAC_PKG="/fsx/scratch/leisaac"
ISAACLAB_SRC="/fsx/scratch/IsaacLab"

echo "=================================================="
echo "GR00T Closed-loop Evaluation — LeIsaac PickOrange"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: $(hostname)"
echo "Model: ${MODEL_PATH}"
echo "Embodiment: ${EMBODIMENT_TAG}"
echo "Modality Config: ${MODALITY_CONFIG}"
echo "Instruction: ${INSTRUCTION}"
echo "Eval Rounds: ${EVAL_ROUNDS}"
echo "Policy Port: ${POLICY_PORT}"
echo "Start: $(date)"
echo "=================================================="

mkdir -p /fsx/scratch/logs

# --- Validate prerequisites ---
if [ ! -d "${MODEL_PATH}" ]; then
    echo "ERROR: Model checkpoint not found: ${MODEL_PATH}"
    echo "  Run VLA training first or set MODEL_PATH."
    exit 1
fi

if [ ! -f "${CONTAINER_IMAGE}" ]; then
    echo "ERROR: Isaac Sim container not found: ${CONTAINER_IMAGE}"
    echo "  Run: bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_isaaclab_env.sh"
    exit 1
fi

if [ ! -d "${GROOT_ENV}" ]; then
    echo "ERROR: GR00T venv not found: ${GROOT_ENV}"
    echo "  Run: bash /fsx/scratch/aws-physical-ai-recipes/training/hyperpod/scripts/setup_groot_env.sh"
    exit 1
fi

if [ ! -d "${LEISAAC_PKG}" ]; then
    echo "ERROR: LeIsaac not found at ${LEISAAC_PKG}"
    echo "  Run: git clone https://github.com/lightwheelai/leisaac.git ${LEISAAC_PKG}"
    exit 1
fi

# --- Step 1: Start GR00T Policy Server (GPU 0) ---
echo ""
echo "[1/3] Starting GR00T Policy Server (port ${POLICY_PORT}, GPU 0)..."

fuser -k "${POLICY_PORT}/tcp" 2>/dev/null || true
sleep 2
fuser -k -9 "${POLICY_PORT}/tcp" 2>/dev/null || true
sleep 1

source "${GROOT_ENV}/bin/activate"
cd "${GROOT_REPO}"

CUDA_VISIBLE_DEVICES=0 python -m gr00t.eval.run_gr00t_server \
    --model-path "${MODEL_PATH}" \
    --embodiment-tag "${EMBODIMENT_TAG}" \
    --modality-config-path "${MODALITY_CONFIG}" \
    --port "${POLICY_PORT}" \
    --device cuda:0 &
POLICY_PID=$!

# --- Step 2: Wait for server readiness (ZMQ ping) ---
echo "  Waiting for policy server (PID: ${POLICY_PID})..."
SERVER_READY=false
for i in $(seq 1 180); do
    if ! kill -0 ${POLICY_PID} 2>/dev/null; then
        echo "  ERROR: Policy server crashed during startup."
        wait ${POLICY_PID} 2>/dev/null
        exit 1
    fi
    if python -c "
import zmq, msgpack, sys
ctx = zmq.Context()
s = ctx.socket(zmq.REQ)
s.setsockopt(zmq.RCVTIMEO, 2000)
s.setsockopt(zmq.SNDTIMEO, 2000)
s.connect('tcp://localhost:${POLICY_PORT}')
s.send(msgpack.packb({'endpoint': 'ping'}))
r = msgpack.unpackb(s.recv())
sys.exit(0 if r.get(b'status') == b'ok' or r.get('status') == 'ok' else 1)
" 2>/dev/null; then
        echo "  Policy server ready! (took ${i}s)"
        SERVER_READY=true
        break
    fi
    sleep 1
done

if [ "${SERVER_READY}" != "true" ]; then
    echo "  ERROR: Policy server not ready after 180s. Killing."
    kill ${POLICY_PID} 2>/dev/null
    exit 1
fi

# --- Step 3: Run LeIsaac PickOrange closed-loop evaluation (GPU 1-3) ---
echo ""
echo "[3/3] Running LeIsaac PickOrange closed-loop evaluation..."

# Create container rootfs if needed
if ! sudo enroot list 2>/dev/null | grep -q "^isaaclab$"; then
    echo "  Creating container rootfs from ${CONTAINER_IMAGE}..."
    sudo enroot create --name isaaclab "${CONTAINER_IMAGE}"
fi

# Write pass-through entrypoint (Isaac Sim container default runs runheadless.sh)
cat > /tmp/isaaclab_rc.sh << 'RCEOF'
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
chmod +x /tmp/isaaclab_rc.sh

sudo enroot start --root \
    --rw \
    --rc /tmp/isaaclab_rc.sh \
    --mount /fsx:/fsx \
    --env ACCEPT_EULA=Y \
    --env PRIVACY_CONSENT=Y \
    --env NVIDIA_VISIBLE_DEVICES=1,2,3 \
    --env NVIDIA_DRIVER_CAPABILITIES=all \
    --env DISPLAY="" \
    --env PYTHONUNBUFFERED=1 \
    --env PYTHONPATH="/fsx/scratch/leisaac/source/leisaac:/fsx/scratch/IsaacLab/source/isaaclab_tasks" \
    isaaclab \
    python3 /fsx/scratch/leisaac/scripts/evaluation/policy_inference.py \
        --task LeIsaac-SO101-PickOrange-v0 \
        --policy_type gr00tn1.6 \
        --policy_host localhost \
        --policy_port "${POLICY_PORT}" \
        --policy_language_instruction "${INSTRUCTION}" \
        --policy_action_horizon 16 \
        --eval_rounds "${EVAL_ROUNDS}" \
        --headless \
        --enable_cameras

SIM_EXIT=$?

# --- Cleanup ---
echo ""
echo "Stopping policy server..."
kill ${POLICY_PID} 2>/dev/null
wait ${POLICY_PID} 2>/dev/null || true

echo ""
echo "=================================================="
if [ ${SIM_EXIT} -eq 0 ]; then
    echo "Closed-loop evaluation completed successfully!"
else
    echo "Closed-loop evaluation failed (exit code: ${SIM_EXIT})"
fi
echo "End: $(date)"
echo "=================================================="

exit ${SIM_EXIT}
