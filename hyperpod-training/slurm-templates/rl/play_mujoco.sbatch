#!/bin/bash
#SBATCH --job-name=mujoco-play
#SBATCH --partition=cpu
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --time=0:30:00
#SBATCH --output=/fsx/scratch/logs/mujoco-play-%j.out
#SBATCH --error=/fsx/scratch/logs/mujoco-play-%j.err

# Evaluate a trained SO-101 MuJoCo policy and record it as mp4/gif on a CPU node (module 9B)
#
# Runs play_mujoco.py: a few deterministic episodes → success rate / final distance, plus an
# offscreen-rendered video written next to the checkpoint (synced to S3 by the FSx data
# repository association, so it can be downloaded to the workstation and viewed in code-server).
#
# Usage:
#   sbatch play_mujoco.sbatch
#   CHECKPOINT=/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_200000_steps.zip sbatch play_mujoco.sbatch
#   CHECKPOINT=untrained EPISODES=2 sbatch play_mujoco.sbatch   # "before training" reference video
#
# Environment Variables:
#   TASK: Gymnasium task ID (default: Workshop-SO101-Reach-MuJoCo-v0)
#   CHECKPOINT: model .zip (default: /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip),
#               or the word "untrained" to render a freshly initialised policy (videos/untrained.{mp4,gif})
#   EPISODES: episodes to run (default: 5, 10 s each)
#   VIDEO_DIR: output dir (default: <checkpoint dir>/videos)
#   MUJOCO_GL: offscreen OpenGL backend, egl (default) or osmesa

set -e

TASK="${TASK:-Workshop-SO101-Reach-MuJoCo-v0}"
CHECKPOINT="${CHECKPOINT:-/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip}"
EPISODES="${EPISODES:-5}"
VIDEO_DIR="${VIDEO_DIR:-}"
export MUJOCO_GL="${MUJOCO_GL:-egl}"

VENV_DIR="${VENV_DIR:-/fsx/envs/mujoco}"
SCRIPT_DIR="/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl"
export MUJOCO_MENAGERIE_DIR="${MUJOCO_MENAGERIE_DIR:-/fsx/scratch/mujoco_menagerie}"

echo "=================================================="
echo "MuJoCo Policy Evaluation + Video (CPU)"
echo "=================================================="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: ${SLURM_NODELIST}"
echo "Task: ${TASK}"
echo "Checkpoint: ${CHECKPOINT}"
echo "Episodes: ${EPISODES}"
echo "Start: $(date)"
echo "=================================================="

if [ ! -x "${VENV_DIR}/bin/python" ]; then
    echo "ERROR: venv not found at ${VENV_DIR}. Run scripts/setup_mujoco_env.sh on the head node first."
    exit 1
fi
if [ "${CHECKPOINT}" = "untrained" ]; then
    # No checkpoint to sit next to, so give the video an explicit home (still synced to S3).
    MODEL_ARGS="--untrained --video_dir ${VIDEO_DIR:-/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/videos}"
else
    if [ ! -f "${CHECKPOINT}" ]; then
        echo "ERROR: checkpoint not found: ${CHECKPOINT}"
        echo "  ls /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/  to see what training produced"
        exit 1
    fi
    MODEL_ARGS="--checkpoint ${CHECKPOINT}"
    [ -n "${VIDEO_DIR}" ] && MODEL_ARGS="${MODEL_ARGS} --video_dir ${VIDEO_DIR}"
fi

# Offscreen rendering needs Mesa's software OpenGL. HyperPod CPU nodes do not ship it, so
# install it on first use (idempotent; the node has passwordless sudo for ubuntu).
if [ "${MUJOCO_GL}" = "egl" ] && ! dpkg -s libegl1 libgl1-mesa-dri >/dev/null 2>&1; then
    echo "Installing Mesa EGL libraries for offscreen rendering..."
    sudo apt-get update -qq && sudo apt-get install -y -qq libegl1 libgl1-mesa-dri libglvnd0 >/dev/null
fi
if [ "${MUJOCO_GL}" = "osmesa" ] && ! dpkg -s libosmesa6 >/dev/null 2>&1; then
    echo "Installing OSMesa for offscreen rendering..."
    sudo apt-get update -qq && sudo apt-get install -y -qq libosmesa6 >/dev/null
fi

source "${VENV_DIR}/bin/activate"
export PYTHONUNBUFFERED=1

EXIT_CODE=0
python "${SCRIPT_DIR}/play_mujoco.py" \
    --task "${TASK}" \
    --episodes "${EPISODES}" \
    ${MODEL_ARGS} || EXIT_CODE=$?

echo ""
echo "=================================================="
if [ ${EXIT_CODE} -eq 0 ]; then
    echo "Evaluation completed successfully"
else
    echo "Evaluation failed with exit code: ${EXIT_CODE}"
fi
echo "End: $(date)"
echo "=================================================="

exit ${EXIT_CODE}
