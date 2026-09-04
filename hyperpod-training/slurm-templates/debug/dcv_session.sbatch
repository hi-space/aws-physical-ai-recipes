#!/bin/bash
#SBATCH --job-name=dcv-debug
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --gpus-per-node=1
#SBATCH --time=4:00:00
#SBATCH --output=/fsx/scratch/logs/dcv-%j.out
#SBATCH --error=/fsx/scratch/logs/dcv-%j.err

# DCV 시각화 세션 — Isaac Sim GUI로 학습된 모델 검증
#
# debug 노드에는 lifecycle-scripts/setup_dcv.sh 가 DCV 서버를 설치하고,
# auto-dcv.service 가 부팅 시 'workspace' 가상 세션(owner: ubuntu)을 만들어 둔다.
# 이 job은 세션이 살아 있는지 확인하고, 접속에 필요한 SSM target을 계산해
# 로그로 출력한 뒤 노드를 점유(sleep)한다.
#
# HyperPod 노드의 SSM target 형식:
#   sagemaker-cluster:<CLUSTER_ID>_<INSTANCE_GROUP>-<EC2_INSTANCE_ID>
# (private IP나 EC2 instance-id 단독으로는 접속되지 않는다)

CHECKPOINT="${CHECKPOINT:-}"
DCV_PORT=8443
DCV_SESSION="workspace"
DCV_USER="ubuntu"
DCV_PASSWORD="hyperpod"   # setup_dcv.sh 가 설정하는 DCV 로그인 비밀번호

echo "=== DCV Debug Session ==="
echo "  Node: $(hostname)"
echo "  GPU:  $(nvidia-smi --query-gpu=name --format=csv,noheader)"

# --- DCV 가상 세션 확인 (부팅 시 auto-dcv.service 가 만든 세션 재사용) ---
if ! sudo dcv list-sessions 2>/dev/null | grep -q "'${DCV_SESSION}'"; then
  echo "  DCV session '${DCV_SESSION}' not found — creating."
  sudo dcv create-session "${DCV_SESSION}" --type virtual --owner "${DCV_USER}" --name "HyperPod Workspace" \
    || echo "  WARNING: dcv create-session failed. Check: sudo systemctl status dcvserver auto-dcv"
fi
echo "  DCV session: ${DCV_SESSION} (owner: ${DCV_USER})"

# --- SSM target 계산 ---
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
imds() { curl -s -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" "http://169.254.169.254/latest/meta-data/$1"; }
INSTANCE_ID=$(imds instance-id)
REGION=$(imds placement/region)

read -r CLUSTER_ID GROUP_NAME < <(python3 - "${INSTANCE_ID}" <<'PY'
import json, sys
cfg = json.load(open("/opt/ml/config/resource_config.json"))
cluster_id = cfg["ClusterConfig"]["ClusterArn"].rsplit("/", 1)[-1]
instance_id = sys.argv[1]
group = next((g["Name"] for g in cfg["InstanceGroups"]
              for i in (g.get("Instances") or []) if i.get("InstanceId") == instance_id), "debug")
print(cluster_id, group)
PY
)
SSM_TARGET="sagemaker-cluster:${CLUSTER_ID}_${GROUP_NAME}-${INSTANCE_ID}"

echo ""
echo "=== How to connect ==="
echo "  1. On your LOCAL machine (AWS CLI v2 + Session Manager plugin), forward the DCV port:"
echo "     aws ssm start-session --region ${REGION} \\"
echo "       --target ${SSM_TARGET} \\"
echo "       --document-name AWS-StartPortForwardingSession \\"
echo "       --parameters portNumber=${DCV_PORT},localPortNumber=${DCV_PORT}"
echo ""
echo "  2. Open in your browser (accept the self-signed certificate):"
echo "     https://localhost:${DCV_PORT}"
echo ""
echo "  3. Log in to the DCV desktop:"
echo "     username: ${DCV_USER}    password: ${DCV_PASSWORD}"
echo ""

if [ -n "$CHECKPOINT" ]; then
  echo "  Checkpoint: ${CHECKPOINT}"
  echo "  Load the model in Isaac Sim (from a terminal on the DCV desktop; match --task to what you trained):"
  echo "    xhost +si:localuser:root"
  echo "    sudo enroot start --root --rw --mount /fsx:/fsx \\"
  echo "      --mount /tmp/.X11-unix:/tmp/.X11-unix \\"
  echo "      --env ACCEPT_EULA=Y --env PRIVACY_CONSENT=Y --env DISPLAY \\"
  echo "      --env PYTHONPATH=/fsx/scratch/isaaclab-workshop/src \\"
  echo "      isaaclab /isaac-sim/kit/python/bin/python3 \\"
  echo "      /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl/play_isaaclab.py \\"
  echo "      --task Workshop-SO101-Reach-v0 --checkpoint ${CHECKPOINT} --num_envs 4"
fi

echo ""
echo "To end the session: scancel ${SLURM_JOB_ID}"

sleep infinity
