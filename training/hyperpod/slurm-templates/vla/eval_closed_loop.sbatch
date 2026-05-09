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
# Runs on a single HyperPod compute node (ml.g6e.12xlarge, 4x L40S):
#   GPU 0: GR00T Policy Server (ZMQ on configurable port)
#   GPU 1-3: Isaac Sim with LeIsaac PickOrange environment (headless)
#
# Prerequisites:
#   - GR00T venv with trained checkpoint at /fsx/envs/gr00t
#   - Isaac Sim container: /fsx/enroot/data/isaaclab+latest.sqsh
#   - LeIsaac installed in container rootfs
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
#   NUM_EPISODES: Number of evaluation episodes (default: 10)
#   MAX_STEPS_PER_EPISODE: Steps per episode before timeout (default: 1000)
#   POLICY_PORT: ZMQ port (default: 5556)

set -e

MODEL_PATH="${MODEL_PATH:-/fsx/checkpoints/vla/groot-so101-place-orange/checkpoint-2000}"
EMBODIMENT_TAG="${EMBODIMENT_TAG:-new_embodiment}"
MODALITY_CONFIG="${MODALITY_CONFIG:-/fsx/scratch/aws-physical-ai-recipes/training/hyperpod/configs/so101_modality.py}"
INSTRUCTION="${INSTRUCTION:-pick up the orange}"
NUM_EPISODES="${NUM_EPISODES:-10}"
MAX_STEPS_PER_EPISODE="${MAX_STEPS_PER_EPISODE:-1000}"
POLICY_PORT="${POLICY_PORT:-5556}"

GROOT_ENV="/fsx/envs/gr00t"
CONTAINER_NAME="isaaclab"
CONTAINER_IMAGE="/fsx/enroot/data/isaaclab+latest.sqsh"
LEISAAC_PKG="/fsx/scratch/leisaac"
METRICS_DIR="$(dirname "${MODEL_PATH}")"
METRICS_FILE="${METRICS_DIR}/metrics.json"

# HuggingFace token
if [ -z "${HF_TOKEN:-}" ] && [ -f /fsx/scratch/.hf_token ]; then
    export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
fi

echo "=================================================="
echo "GR00T Closed-loop Evaluation — LeIsaac PickOrange"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: $(hostname)"
echo "Model: ${MODEL_PATH}"
echo "Embodiment: ${EMBODIMENT_TAG}"
echo "Modality Config: ${MODALITY_CONFIG}"
echo "Instruction: ${INSTRUCTION}"
echo "Episodes: ${NUM_EPISODES}"
echo "Max Steps/Episode: ${MAX_STEPS_PER_EPISODE}"
echo "Port: ${POLICY_PORT}"
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
    echo "  Run setup_isaaclab_env.sh first."
    exit 1
fi

if [ ! -d "${GROOT_ENV}" ]; then
    echo "ERROR: GR00T venv not found: ${GROOT_ENV}"
    echo "  Run setup_groot_env.sh first."
    exit 1
fi

if [ ! -d "${LEISAAC_PKG}" ]; then
    echo "ERROR: LeIsaac not found at ${LEISAAC_PKG}"
    echo "  Run setup_isaaclab_env.sh to install LeIsaac."
    exit 1
fi

# --- Step 1: Start GR00T Policy Server (GPU 0) ---
echo ""
echo "[1/4] Starting GR00T Policy Server (port ${POLICY_PORT}, GPU 0)..."

fuser -k "${POLICY_PORT}/tcp" 2>/dev/null || true
sleep 1

source "${GROOT_ENV}/bin/activate"

CUDA_VISIBLE_DEVICES=0 python -m gr00t.eval.service \
    --model-path "${MODEL_PATH}" \
    --embodiment-tag "${EMBODIMENT_TAG}" \
    --modality-config-path "${MODALITY_CONFIG}" \
    --port "${POLICY_PORT}" \
    --device cuda:0 &
POLICY_PID=$!

# --- Step 2: Wait for server readiness (health check) ---
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
echo "[3/4] Running LeIsaac PickOrange closed-loop evaluation..."

# Create container rootfs if needed
if ! enroot list 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo "  Creating container rootfs..."
    sudo enroot create --name "${CONTAINER_NAME}" "${CONTAINER_IMAGE}"
fi

sudo enroot start --root \
    --rw \
    --mount /fsx:/fsx \
    --env ACCEPT_EULA=Y \
    --env PRIVACY_CONSENT=Y \
    --env NVIDIA_VISIBLE_DEVICES=1,2,3 \
    --env NVIDIA_DRIVER_CAPABILITIES=all \
    --env DISPLAY="" \
    --env PYTHONUNBUFFERED=1 \
    --env PYTHONPATH="${LEISAAC_PKG}/source:${LEISAAC_PKG}" \
    "${CONTAINER_NAME}" \
    bash -c "
cd ${LEISAAC_PKG}
python scripts/evaluation/run_groot_closed_loop.py \
    --task LeIsaac-SO101-PickOrange-v0 \
    --policy_host localhost \
    --policy_port ${POLICY_PORT} \
    --instruction '${INSTRUCTION}' \
    --num_episodes ${NUM_EPISODES} \
    --max_steps_per_episode ${MAX_STEPS_PER_EPISODE} \
    --headless \
    --metrics_output ${METRICS_FILE}
"

SIM_EXIT=$?

# --- Step 4: Cleanup and report ---
echo ""
echo "[4/4] Stopping policy server..."
kill ${POLICY_PID} 2>/dev/null
wait ${POLICY_PID} 2>/dev/null || true

echo ""
echo "=================================================="
if [ ${SIM_EXIT} -eq 0 ]; then
    echo "Closed-loop evaluation completed successfully!"
    if [ -f "${METRICS_FILE}" ]; then
        echo ""
        echo "Results (${METRICS_FILE}):"
        cat "${METRICS_FILE}"
    fi
else
    echo "Closed-loop evaluation failed (exit code: ${SIM_EXIT})"
fi
echo ""
echo "End: $(date)"
echo "=================================================="

exit ${SIM_EXIT}
