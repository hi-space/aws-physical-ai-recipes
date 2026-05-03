#!/bin/bash
#SBATCH --job-name=rl-learner
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --time=48:00:00
#SBATCH --output=/fsx/scratch/logs/learner-%j.out
#SBATCH --error=/fsx/scratch/logs/learner-%j.err

# RL Learner (Ray head node + training loop)

ENV_NAME="${ENV_NAME:-Isaac-Cartpole-v0}"
EXPERIMENT="${EXPERIMENT:-rl-$(date +%Y%m%d-%H%M%S)}"
MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:?Set MLflow tracking URI}"
NUM_ACTORS="${NUM_ACTORS:-8}"

export MLFLOW_TRACKING_URI

srun --container-image=nvcr.io/nvidia/isaac-sim:4.5.0 \
     --container-mounts=/fsx:/fsx \
     bash -c "
       pip install ray[default] mlflow && \
       ray start --head --port=6379 && \
       python /fsx/scratch/train_isaaclab.py \
         --env ${ENV_NAME} \
         --experiment ${EXPERIMENT} \
         --num-actors ${NUM_ACTORS} \
         --checkpoint-dir /fsx/checkpoints/rl/${EXPERIMENT}
     "

echo "Learner finished. Ray head address: $(hostname -i):6379"
