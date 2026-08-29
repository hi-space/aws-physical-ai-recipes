#!/bin/bash
#SBATCH --job-name=dcv-debug
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --gpus-per-node=1
#SBATCH --time=4:00:00
#SBATCH --output=/fsx/scratch/logs/dcv-%j.out
#SBATCH --error=/fsx/scratch/logs/dcv-%j.err

# DCV 시각화 세션 — Isaac Sim GUI로 학습된 모델 검증

CHECKPOINT="${CHECKPOINT:-}"

echo "=== DCV Debug Session ==="
echo "  Node: $(hostname)"
echo "  GPU:  $(nvidia-smi --query-gpu=name --format=csv,noheader)"

dcv create-session --type virtual --name debug-session
DCV_PORT=8443

NODE_IP=$(hostname -i)
echo ""
echo "=== How to connect ==="
echo "  1. SSM port forwarding:"
echo "     aws ssm start-session --target \$(scontrol show node \$(hostname) | grep -oP 'NodeAddr=\\K[^[:space:]]+') \\"
echo "       --document-name AWS-StartPortForwardingSession \\"
echo "       --parameters portNumber=${DCV_PORT},localPortNumber=${DCV_PORT}"
echo ""
echo "  2. Open in your browser:"
echo "     https://localhost:${DCV_PORT}"
echo ""

if [ -n "$CHECKPOINT" ]; then
  echo "  Checkpoint: ${CHECKPOINT}"
  echo "  Load the model in Isaac Sim (from a terminal on the DCV desktop):"
  echo "    sudo enroot start --root --rw --mount /fsx:/fsx \\"
  echo "      --env ACCEPT_EULA=Y --env PRIVACY_CONSENT=Y --env DISPLAY \\"
  echo "      --env PYTHONPATH=/fsx/scratch/isaaclab-workshop/src:/fsx/scratch/IsaacLab/source/isaaclab_rl:/fsx/scratch/IsaacLab/source/isaaclab_tasks \\"
  echo "      isaaclab /isaac-sim/kit/python/bin/python3 \\"
  echo "      /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl/play_isaaclab.py \\"
  echo "      --checkpoint ${CHECKPOINT} --num_envs 4"
fi

echo ""
echo "To end the session: scancel ${SLURM_JOB_ID}"

sleep infinity
