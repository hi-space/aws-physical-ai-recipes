#!/bin/bash
#SBATCH --job-name=rl-actor
#SBATCH --partition=sim
#SBATCH --nodes=1
#SBATCH --gpus-per-node=4
#SBATCH --time=24:00:00
#SBATCH --output=/fsx/scratch/logs/actor-%j-%a.out
#SBATCH --error=/fsx/scratch/logs/actor-%j-%a.err

# IsaacLab RL Actor (headless simulation)
# Ray worker로 learner에 연결하여 environment step 실행

RAY_HEAD_ADDR="${RAY_HEAD_ADDR:?Set RAY_HEAD_ADDR to learner node IP}"
ENV_NAME="${ENV_NAME:-Isaac-Cartpole-v0}"

srun --container-image=nvcr.io/nvidia/isaac-sim:4.5.0 \
     --container-mounts=/fsx:/fsx \
     bash -c "
       pip install ray[default] && \
       ray start --address=${RAY_HEAD_ADDR}:6379 --block
     "
