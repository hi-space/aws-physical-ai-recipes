#!/bin/bash
#SBATCH --job-name=isaaclab-video
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gres=gpu:1
#SBATCH --time=0:30:00
#SBATCH --output=/fsx/scratch/logs/isaaclab-video-%j.out
#SBATCH --error=/fsx/scratch/logs/isaaclab-video-%j.err

# Record the learned policy as an mp4 (+ gif) without a display.
#
# Runs play_isaaclab.py --video inside the Isaac Lab container on any GPU node:
# Isaac Sim renders the scene offscreen and gymnasium's RecordVideo writes the frames.
# Useful when no DCV/debug node is available, or to keep a recording of a run.
#
# Prerequisites: a finished training job (finetune_isaaclab.sbatch prepares the container).
#
# Usage:
#   sbatch record_video.sbatch                                   # Reach, model_best.pt
#   TASK=Workshop-SO101-Lift-v0 CHECKPOINT=/fsx/checkpoints/rl/lift/SO101_Lift/model_best.pt \
#     sbatch record_video.sbatch
#
# Environment Variables:
#   TASK          Isaac Lab task ID (default: Workshop-SO101-Reach-v0)
#   CHECKPOINT    checkpoint path (default: /fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt)
#   NUM_ENVS      environments in view (default: 4)
#   VIDEO_LENGTH  steps to record, 50 steps = 1 s (default: 900)
#   VIDEO_DIR     output directory (default: <checkpoint dir>/videos — synced to S3 by the FSx DRA)

set -euo pipefail

TASK="${TASK:-Workshop-SO101-Reach-v0}"
CHECKPOINT="${CHECKPOINT:-/fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt}"
NUM_ENVS="${NUM_ENVS:-4}"
VIDEO_LENGTH="${VIDEO_LENGTH:-900}"
VIDEO_DIR="${VIDEO_DIR:-$(dirname "${CHECKPOINT}")/videos}"
WORKSHOP_PKG="/fsx/scratch/isaaclab-workshop/src"
SCRIPT_DIR="/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl"

echo "Task: ${TASK}  Checkpoint: ${CHECKPOINT}  Envs: ${NUM_ENVS}  Steps: ${VIDEO_LENGTH}  Out: ${VIDEO_DIR}"
[ -f "${CHECKPOINT}" ] || { echo "ERROR: checkpoint not found: ${CHECKPOINT}"; exit 1; }
mkdir -p "${VIDEO_DIR}"

sudo enroot start --root --rw \
    --mount /fsx:/fsx \
    --env ACCEPT_EULA=Y --env PRIVACY_CONSENT=Y \
    --env PYTHONPATH="${WORKSHOP_PKG}" --env PYTHONUNBUFFERED=1 \
    --env NVIDIA_VISIBLE_DEVICES=all --env NVIDIA_DRIVER_CAPABILITIES=all \
    isaaclab \
    /isaac-sim/kit/python/bin/python3 "${SCRIPT_DIR}/play_isaaclab.py" \
        --task "${TASK}" --checkpoint "${CHECKPOINT}" --num_envs "${NUM_ENVS}" \
        --video --video_length "${VIDEO_LENGTH}" --video_dir "${VIDEO_DIR}"

# Companion gif (15 fps, 640 px wide) for docs/chat; skipped if ffmpeg is not on the node.
MP4="$(ls -t "${VIDEO_DIR}"/*.mp4 2>/dev/null | head -1 || true)"
if [ -n "${MP4}" ] && command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y -loglevel error -i "${MP4}" \
        -vf "fps=15,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
        "${MP4%.mp4}.gif"
    echo "GIF: ${MP4%.mp4}.gif"
fi
echo "MP4: ${MP4}"
ls -la "${VIDEO_DIR}"
