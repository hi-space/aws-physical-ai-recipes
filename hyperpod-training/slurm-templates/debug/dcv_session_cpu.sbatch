#!/bin/bash
#SBATCH --job-name=dcv-cpu
#SBATCH --partition=cpu
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=1
#SBATCH --time=4:00:00
#SBATCH --output=/fsx/scratch/logs/dcv-cpu-%j.out
#SBATCH --error=/fsx/scratch/logs/dcv-cpu-%j.err

# DCV 세션 on a CPU node — watch a MuJoCo policy live in the DCV desktop (workshop S3.10)
#
# CPU counterpart of debug/dcv_session.sbatch. CPU nodes (cpu-*) get an xfce desktop + DCV server
# from lifecycle-scripts/setup_dcv.sh and auto-dcv.service creates the 'workspace' virtual session
# at boot; DCV virtual sessions render through Mesa (llvmpipe), no GPU needed. This job checks
# that the session is alive, prints the SSM port-forwarding command (the node has no public IP),
# prints the viewer command to run inside the desktop, and then parks on the node.
#
# It asks for a single CPU so a training job (train_mujoco.sbatch, which uses the whole node's
# vCPUs through SubprocVecEnv but only requests 1 task) can still be scheduled alongside it.
#
# Usage (head node):
#   sbatch dcv_session_cpu.sbatch
#   CHECKPOINT=/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_200000_steps.zip sbatch dcv_session_cpu.sbatch
#   tail -f /fsx/scratch/logs/dcv-cpu-<JOB_ID>.out
#
# Environment Variables:
#   TASK:       Gymnasium task ID (default: Workshop-SO101-Reach-MuJoCo-v0)
#   CHECKPOINT: model .zip shown in the viewer hint (default: .../reach-mujoco/SO101_Reach/model_best.zip)
#
# HyperPod SSM target format: sagemaker-cluster:<CLUSTER_ID>_<INSTANCE_GROUP>-<EC2_INSTANCE_ID>

TASK="${TASK:-Workshop-SO101-Reach-MuJoCo-v0}"
CHECKPOINT="${CHECKPOINT:-/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip}"
DCV_PORT=8443
DCV_SESSION="workspace"
DCV_USER="ubuntu"
DCV_PASSWORD="hyperpod"   # set by lifecycle-scripts/setup_dcv.sh
VENV_DIR="${VENV_DIR:-/fsx/envs/mujoco}"
SCRIPT_DIR="/fsx/scratch/aws-physical-ai-recipes/hyperpod-training/examples/rl"

echo "=== DCV Session (CPU node) ==="
echo "  Node: $(hostname)  ($(nproc) vCPU, no GPU, software OpenGL)"

# --- DCV server / virtual session (created at boot by auto-dcv.service; recreate if missing) ---
if ! command -v dcv >/dev/null 2>&1 || ! systemctl is-active --quiet dcvserver; then
  echo "  ERROR: DCV server is not running on this node."
  echo "  This node was provisioned before setup_dcv.sh learned to install DCV on CPU nodes."
  echo "  Redeploy the lifecycle scripts (npx cdk deploy in hyperpod-training/infra) and scale the"
  echo "  cpu group 0 -> 1 again so the node boots with the new script (check /var/log/setup-dcv.log)."
  exit 1
fi
if ! sudo dcv list-sessions 2>/dev/null | grep -q "'${DCV_SESSION}'"; then
  echo "  DCV session '${DCV_SESSION}' not found, creating."
  sudo dcv create-session "${DCV_SESSION}" --type virtual --owner "${DCV_USER}" --name "HyperPod Workspace" \
    || echo "  WARNING: dcv create-session failed. Check: sudo systemctl status dcvserver auto-dcv"
fi
echo "  DCV session: ${DCV_SESSION} (owner: ${DCV_USER})"

# --- SSM target ---
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
              for i in (g.get("Instances") or []) if i.get("InstanceId") == instance_id), "cpu-c5-4x")
print(cluster_id, group)
PY
)
SSM_TARGET="sagemaker-cluster:${CLUSTER_ID}_${GROUP_NAME}-${INSTANCE_ID}"

echo ""
echo "=== How to connect ==="
echo "  The DCV server listens on port 8443 on this node (private subnet, no public IP)."
echo "  SSM port forwarding brings that port onto the machine where you run the command."
echo ""
echo "  A) From the module-1 workstation, in a [code-server] terminal:"
echo "     aws ssm start-session --region ${REGION} \\"
echo "       --target ${SSM_TARGET} \\"
echo "       --document-name AWS-StartPortForwardingSession \\"
echo "       --parameters portNumber=${DCV_PORT},localPortNumber=8444"
echo "     Leave it running, then open in your laptop browser (keep the trailing slash):"
echo "       <CodeServerUrl>/proxy/8445/"
echo "     8444 = this node's DCV on the workstation; 8445 = dcv-tls-bridge on the workstation,"
echo "     which code-server's /proxy/ can reach (it speaks plain HTTP, DCV speaks TLS only)."
echo ""
echo "  B) From your LOCAL machine (AWS CLI v2 + Session Manager plugin):"
echo "     same command with localPortNumber=${DCV_PORT}, then open https://localhost:${DCV_PORT}"
echo "     (accept the self-signed certificate)."
echo ""
echo "  Log in to the DCV desktop:  username: ${DCV_USER}    password: ${DCV_PASSWORD}"
echo ""
echo "=== Watch the policy (terminal inside the DCV desktop) ==="
if [ -f "${CHECKPOINT}" ]; then
  echo "  Checkpoint: ${CHECKPOINT}"
else
  echo "  WARNING: checkpoint not found yet: ${CHECKPOINT}"
  echo "  (ls /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/ — training may still be running)"
fi
echo "    source ${VENV_DIR}/bin/activate"
echo "    python ${SCRIPT_DIR}/play_mujoco.py --viewer \\"
echo "      --task ${TASK} --checkpoint ${CHECKPOINT} --episodes 5"
echo "  Before/after comparison (fresh policy with exploration noise):"
echo "    python ${SCRIPT_DIR}/play_mujoco.py --viewer --untrained --episodes 2"
echo ""
echo "To end the session: scancel ${SLURM_JOB_ID}"

sleep infinity
