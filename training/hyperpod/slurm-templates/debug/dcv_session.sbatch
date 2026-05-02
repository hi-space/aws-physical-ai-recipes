#!/bin/bash
#SBATCH --job-name=dcv-debug
#SBATCH --partition=debug
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
echo "=== DCV 접속 방법 ==="
echo "  1. SSM 포트포워딩:"
echo "     aws ssm start-session --target \$(scontrol show node \$(hostname) | grep -oP 'NodeAddr=\\K[^[:space:]]+') \\"
echo "       --document-name AWS-StartPortForwardingSession \\"
echo "       --parameters portNumber=${DCV_PORT},localPortNumber=${DCV_PORT}"
echo ""
echo "  2. 브라우저에서 접속:"
echo "     https://localhost:${DCV_PORT}"
echo ""

if [ -n "$CHECKPOINT" ]; then
  echo "  Checkpoint: ${CHECKPOINT}"
  echo "  Isaac Sim에서 모델 로드:"
  echo "    python /fsx/scratch/verify_in_sim.py --checkpoint ${CHECKPOINT}"
fi

echo ""
echo "세션 종료: scancel ${SLURM_JOB_ID}"

sleep infinity
