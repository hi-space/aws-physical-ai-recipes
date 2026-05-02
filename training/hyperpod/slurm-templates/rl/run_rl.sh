#!/bin/bash
set -euo pipefail

# Actor-Learner 동시 제출 스크립트
# Usage: ./run_rl.sh --env Isaac-Humanoid-v0 --num-actors 8

ENV_NAME="Isaac-Cartpole-v0"
NUM_ACTORS=8
EXPERIMENT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --env) ENV_NAME="$2"; shift 2;;
    --num-actors) NUM_ACTORS="$2"; shift 2;;
    --experiment) EXPERIMENT="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

EXPERIMENT="${EXPERIMENT:-rl-${ENV_NAME}-$(date +%Y%m%d-%H%M%S)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== RL Training: ${ENV_NAME} ==="
echo "  Actors: ${NUM_ACTORS}"
echo "  Experiment: ${EXPERIMENT}"

mkdir -p /fsx/scratch/logs

# 1. Learner 제출
LEARNER_JOB=$(sbatch --parsable \
  --export=ALL,ENV_NAME=${ENV_NAME},EXPERIMENT=${EXPERIMENT},NUM_ACTORS=${NUM_ACTORS} \
  "${SCRIPT_DIR}/learner.sbatch")
echo "  Learner job: ${LEARNER_JOB}"

# Learner 시작 대기
echo "  Waiting for learner to start..."
while [ "$(squeue -j ${LEARNER_JOB} -h -o %T)" = "PENDING" ]; do
  sleep 5
done
sleep 30

# Learner 노드 IP 조회
LEARNER_NODE=$(squeue -j ${LEARNER_JOB} -h -o %N)
RAY_HEAD_ADDR=$(srun --jobid=${LEARNER_JOB} --nodelist=${LEARNER_NODE} hostname -i 2>/dev/null | head -1)
echo "  Ray head: ${RAY_HEAD_ADDR}"

# 2. Actor 배열 제출
ACTOR_JOB=$(sbatch --parsable \
  --array=0-$((NUM_ACTORS-1)) \
  --export=ALL,RAY_HEAD_ADDR=${RAY_HEAD_ADDR},ENV_NAME=${ENV_NAME} \
  "${SCRIPT_DIR}/actor.sbatch")
echo "  Actor jobs: ${ACTOR_JOB} (array 0-$((NUM_ACTORS-1)))"

echo ""
echo "=== Submitted ==="
echo "  Monitor: squeue -u \$USER"
echo "  Cancel:  scancel ${LEARNER_JOB} ${ACTOR_JOB}"
echo "  Logs:    /fsx/scratch/logs/"
