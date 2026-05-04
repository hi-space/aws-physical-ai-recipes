#!/bin/bash
#SBATCH --job-name=groot-closed-loop
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:1
#SBATCH --time=1:00:00
#SBATCH --output=/fsx/scratch/logs/closed-loop-%j.out
#SBATCH --error=/fsx/scratch/logs/closed-loop-%j.err

# GR00T Closed-loop Evaluation in Isaac Sim
#
# Runs two processes on the same GPU node:
#   1. GR00T Policy Server (ZMQ on port 5555) — serves fine-tuned model
#   2. Isaac Sim client (run_closed_loop.py) — sends observations, receives actions
#
# Prerequisites:
#   - Isaac Sim container imported: /fsx/enroot/data/isaaclab+latest.sqsh
#   - GR00T venv with trained checkpoint
#   - Workshop task package at /fsx/scratch/isaaclab-workshop/src
#
# Usage:
#   sbatch eval_closed_loop.sbatch
#   MODEL_PATH=/fsx/checkpoints/vla/groot-demo_data/checkpoint-10 sbatch eval_closed_loop.sbatch
#
# Environment Variables:
#   MODEL_PATH: GR00T checkpoint path (default: /fsx/checkpoints/vla/groot-demo_data/checkpoint-2000)
#   EMBODIMENT_TAG: Embodiment tag (default: NEW_EMBODIMENT)
#   INSTRUCTION: Language instruction (default: "pick up the cube")
#   NUM_STEPS: Simulation steps (default: 3000)
#   POLICY_PORT: ZMQ port (default: 5555)

set -e

MODEL_PATH="${MODEL_PATH:-/fsx/checkpoints/vla/groot-demo_data/checkpoint-2000}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT}"
INSTRUCTION="${INSTRUCTION:-pick up the cube}"
NUM_STEPS="${NUM_STEPS:-3000}"
POLICY_PORT="${POLICY_PORT:-5556}"

GROOT_ENV="/fsx/envs/gr00t"
CONTAINER_IMAGE="/fsx/enroot/data/isaaclab+latest.sqsh"
CONTAINER_NAME="isaaclab"
SCRIPT_DIR="/fsx/scratch/aws-physical-ai-recipes/training/hyperpod/examples/vla"
WORKSHOP_PKG="/fsx/scratch/isaaclab-workshop/src"

# HuggingFace token
if [ -z "${HF_TOKEN:-}" ] && [ -f /fsx/scratch/.hf_token ]; then
    export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
fi

echo "=================================================="
echo "GR00T Closed-loop Evaluation in Isaac Sim"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: $(hostname)"
echo "Model: ${MODEL_PATH}"
echo "Embodiment: ${EMBODIMENT_TAG}"
echo "Instruction: ${INSTRUCTION}"
echo "Steps: ${NUM_STEPS}"
echo "Port: ${POLICY_PORT}"
echo "Start: $(date)"
echo "=================================================="

mkdir -p /fsx/scratch/logs

# Validate prerequisites
if [ ! -d "${MODEL_PATH}" ]; then
    echo "ERROR: Model checkpoint not found: ${MODEL_PATH}"
    echo "  Run training first or set MODEL_PATH to a valid checkpoint."
    exit 1
fi

if [ ! -f "${CONTAINER_IMAGE}" ]; then
    echo "ERROR: Isaac Sim container not found: ${CONTAINER_IMAGE}"
    echo "  Run setup_isaaclab_env.sh first."
    exit 1
fi

if [ ! -d "${GROOT_ENV}" ]; then
    echo "ERROR: GR00T venv not found: ${GROOT_ENV}"
    echo "  Run setup_groot_env.sh first."
    exit 1
fi

# --- Step 1: Start GR00T Policy Server in background ---
echo ""
echo "[1/3] Starting GR00T Policy Server (port ${POLICY_PORT})..."

# Kill any leftover processes from previous runs
fuser -k "${POLICY_PORT}/tcp" 2>/dev/null || true
sudo pkill -9 -f "isaac-sim/kit/python" 2>/dev/null || true
sudo pkill -9 -f "policy_server.py" 2>/dev/null || true
sleep 2

source "${GROOT_ENV}/bin/activate"

python "${SCRIPT_DIR}/policy_server.py" \
    --model-path "${MODEL_PATH}" \
    --embodiment-tag "${EMBODIMENT_TAG}" \
    --port "${POLICY_PORT}" \
    --device cuda:0 &
POLICY_PID=$!

# Wait for server to be ready (model + Cosmos vision encoder loading takes ~2-3 min)
echo "  Waiting for policy server to load model (PID: ${POLICY_PID})..."
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
        break
    fi
    sleep 1
done

if ! kill -0 ${POLICY_PID} 2>/dev/null; then
    echo "  ERROR: Policy server is not running."
    exit 1
fi

# --- Step 2: Run Isaac Sim closed-loop evaluation ---
echo ""
echo "[2/3] Running Isaac Sim closed-loop evaluation..."

# Create container rootfs if needed
if ! enroot list 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo "  Creating container rootfs (first time, ~5-10 min)..."
    sudo enroot create --name "${CONTAINER_NAME}" "${CONTAINER_IMAGE}"
fi

ROOTFS_PATH="/fsx/enroot/data/${CONTAINER_NAME}"

# Run closed-loop client inside Isaac Sim container
sudo enroot start --root \
    --rw \
    --mount /fsx:/fsx \
    --env ACCEPT_EULA=Y \
    --env PRIVACY_CONSENT=Y \
    --env PYTHONPATH="${WORKSHOP_PKG}" \
    --env NVIDIA_VISIBLE_DEVICES=all \
    --env NVIDIA_DRIVER_CAPABILITIES=all \
    --env GIT_PYTHON_REFRESH=quiet \
    --env PYTHONUNBUFFERED=1 \
    --env DISPLAY="" \
    "${CONTAINER_NAME}" \
    bash /isaac-sim/python.sh \
        "${WORKSHOP_PKG}/workshop/scripts/run_closed_loop.py" \
        --policy_host localhost \
        --policy_port "${POLICY_PORT}" \
        --instruction "${INSTRUCTION}" \
        --num_steps "${NUM_STEPS}" \
        --headless \
        --enable_cameras

SIM_EXIT=$?

# --- Step 3: Cleanup ---
echo ""
echo "[3/3] Stopping policy server..."
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
