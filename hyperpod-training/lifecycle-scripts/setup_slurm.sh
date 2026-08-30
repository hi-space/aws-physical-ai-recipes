#!/bin/bash
set -euo pipefail

echo "[setup_slurm] SLURM configuration is managed by HyperPod (SlurmConfigStrategy: Managed)."
echo "[setup_slurm] Partitions are auto-configured based on instance groups."

# Determine head node (slurmctld host) IP from slurm.conf
SLURMCTLD_HOST=""
if [ -f /opt/slurm/etc/slurm.conf ]; then
  SLURMCTLD_HOST=$(grep -oP 'SlurmctldHost=\S+\(\K[^)]+' /opt/slurm/etc/slurm.conf 2>/dev/null || true)
fi

# For compute nodes: ensure slurmd can find slurmctld and detect GPUs
if [ "${SAGEMAKER_INSTANCE_GROUP_NAME:-}" != "head" ] && [ -n "$SLURMCTLD_HOST" ]; then
  # Create environment file for slurmd configless mode
  mkdir -p /opt/slurm/etc/default
  echo "SLURMD_OPTIONS=--conf-server ${SLURMCTLD_HOST}" > /opt/slurm/etc/default/slurmd
  echo "[setup_slurm] Configured slurmd conf-server: ${SLURMCTLD_HOST}"

  # GPU gres 설정 - HyperPod 노드는 Slurm cloud/dynamic 노드라서 gres.conf의
  # AutoDetect=nvml을 slurmctld가 거부한다("Cannot use AutoDetect on cloud/dynamic node"
  # -> GPU 노드가 영구 POWERED_DOWN, 잡이 PENDING(Resources)에 고정).
  # nvidia-smi로 GPU 수를 세어 명시적으로 기술한다.
  if command -v nvidia-smi &>/dev/null; then
    GPU_COUNT=$(nvidia-smi --list-gpus 2>/dev/null | wc -l)
    if [ "$GPU_COUNT" -gt 0 ]; then
      : > /opt/slurm/etc/gres.conf
      for i in $(seq 0 $((GPU_COUNT-1))); do
        echo "Name=gpu File=/dev/nvidia${i}" >> /opt/slurm/etc/gres.conf
      done
      echo "[setup_slurm] Configured explicit gres for ${GPU_COUNT} GPU(s)."
    fi
  fi
elif [ -z "$SLURMCTLD_HOST" ] && [ "${SAGEMAKER_INSTANCE_GROUP_NAME:-}" != "head" ]; then
  # Fallback: discover head node IP from lifecycle bucket
  if [ -z "${LIFECYCLE_BUCKET:-}" ]; then
    LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
  fi
  if [ -n "$LIFECYCLE_BUCKET" ]; then
    HEAD_IP=$(aws s3 cp "s3://${LIFECYCLE_BUCKET}/config/head_ip.txt" - 2>/dev/null || true)
    if [ -n "$HEAD_IP" ]; then
      mkdir -p /opt/slurm/etc/default
      echo "SLURMD_OPTIONS=--conf-server ${HEAD_IP}" > /opt/slurm/etc/default/slurmd
      echo "[setup_slurm] Configured slurmd conf-server from S3: ${HEAD_IP}"
    fi
  fi
  if command -v nvidia-smi &>/dev/null; then
    # AutoDetect는 cloud/dynamic 노드에서 거부되므로 명시적 gres 기술 (위 주석 참고)
    GPU_COUNT=$(nvidia-smi --list-gpus 2>/dev/null | wc -l)
    if [ "$GPU_COUNT" -gt 0 ]; then
      : > /opt/slurm/etc/gres.conf
      for i in $(seq 0 $((GPU_COUNT-1))); do
        echo "Name=gpu File=/dev/nvidia${i}" >> /opt/slurm/etc/gres.conf
      done
    fi
  fi
else
  # Head node: save IP for compute nodes
  if [ -z "${LIFECYCLE_BUCKET:-}" ]; then
    LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
  fi
  if [ -n "$LIFECYCLE_BUCKET" ]; then
    # 이 업로드가 조용히 실패하면 compute 노드가 head IP를 못 찾아
    # slurmd가 DNS SRV 재시도 루프에 빠진다 - 재시도하고 결과를 명시적으로 남긴다.
    for attempt in 1 2 3; do
      if hostname -I | awk '{print $1}' | aws s3 cp - "s3://${LIFECYCLE_BUCKET}/config/head_ip.txt"; then
        echo "[setup_slurm] Saved head node IP to S3."
        break
      fi
      echo "[setup_slurm] WARNING: head_ip.txt upload failed (attempt ${attempt}/3)"
      sleep 5
    done
  fi
fi

echo "[setup_slurm] SLURM setup complete."
