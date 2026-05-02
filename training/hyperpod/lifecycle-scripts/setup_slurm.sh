#!/bin/bash
set -euo pipefail

echo "[setup_slurm] Configuring SLURM partitions..."

NODE_TYPE="${SAGEMAKER_INSTANCE_GROUP_NAME:-unknown}"

if [ "$NODE_TYPE" = "head" ]; then
  cat >> /opt/slurm/etc/slurm.conf <<'SLURM_PARTITIONS'

# Partition definitions
PartitionName=sim Default=NO MaxTime=INFINITE State=UP
PartitionName=train Default=YES MaxTime=INFINITE State=UP
PartitionName=debug Default=NO MaxTime=4:00:00 State=UP

# Autoscaling
SuspendTime=600
ResumeTimeout=900
SuspendTimeout=300
SLURM_PARTITIONS

  systemctl restart slurmctld
  echo "[setup_slurm] SLURM partitions configured on head node."
else
  echo "[setup_slurm] Worker node ($NODE_TYPE). No partition config needed."
fi
