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

  # Enable GPU auto-detection via NVML
  if command -v nvidia-smi &>/dev/null; then
    echo "AutoDetect=nvml" > /opt/slurm/etc/gres.conf
    echo "[setup_slurm] Configured GPU auto-detection (NVML)."
  fi
elif [ -z "$SLURMCTLD_HOST" ] && [ "${SAGEMAKER_INSTANCE_GROUP_NAME:-}" != "head" ]; then
  # Fallback: discover head node IP from lifecycle bucket
  LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
  if [ -n "$LIFECYCLE_BUCKET" ]; then
    HEAD_IP=$(aws s3 cp "s3://${LIFECYCLE_BUCKET}/config/head_ip.txt" - 2>/dev/null || true)
    if [ -n "$HEAD_IP" ]; then
      mkdir -p /opt/slurm/etc/default
      echo "SLURMD_OPTIONS=--conf-server ${HEAD_IP}" > /opt/slurm/etc/default/slurmd
      echo "[setup_slurm] Configured slurmd conf-server from S3: ${HEAD_IP}"
    fi
  fi
  if command -v nvidia-smi &>/dev/null; then
    echo "AutoDetect=nvml" > /opt/slurm/etc/gres.conf
  fi
else
  # Head node: save IP for compute nodes
  LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
  if [ -n "$LIFECYCLE_BUCKET" ]; then
    hostname -I | awk '{print $1}' | aws s3 cp - "s3://${LIFECYCLE_BUCKET}/config/head_ip.txt" 2>/dev/null || true
    echo "[setup_slurm] Saved head node IP to S3."
  fi
fi

echo "[setup_slurm] SLURM setup complete."
