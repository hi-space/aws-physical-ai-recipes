#!/bin/bash
set -euo pipefail

FSX_DNS_NAME="${FSX_DNS_NAME:-}"
FSX_MOUNT_NAME="${FSX_MOUNT_NAME:-}"

if [ -z "$FSX_DNS_NAME" ] || [ -z "$FSX_MOUNT_NAME" ]; then
  echo "[setup_fsx] FSX_DNS_NAME or FSX_MOUNT_NAME not set. Skipping mount."
  exit 0
fi

echo "[setup_fsx] Mounting FSx at /fsx..."

apt-get update -y
apt-get install -y lustre-client-modules-aws lustre-client-modules-$(uname -r) || \
  apt-get install -y lustre-client-modules-aws

mkdir -p /fsx

mount -t lustre "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME}" /fsx

echo "${FSX_DNS_NAME}@tcp:/${FSX_MOUNT_NAME} /fsx lustre defaults,noatime,flock,_netdev 0 0" >> /etc/fstab

mkdir -p /fsx/datasets /fsx/checkpoints /fsx/scratch
chmod 777 /fsx/scratch

echo "[setup_fsx] FSx mounted at /fsx successfully."
