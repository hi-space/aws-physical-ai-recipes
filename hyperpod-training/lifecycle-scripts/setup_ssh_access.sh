#!/bin/bash
set -euo pipefail

echo "[setup_ssh] Configuring SSH access..."

# Use LIFECYCLE_BUCKET from parent (on_create.sh exports it), or detect from env/S3
if [ -z "${LIFECYCLE_BUCKET:-}" ]; then
  if [ -n "${SAGEMAKER_LIFECYCLE_CONFIG_S3_URI:-}" ]; then
    LIFECYCLE_BUCKET=$(echo "${SAGEMAKER_LIFECYCLE_CONFIG_S3_URI}" | sed 's|^s3://||' | cut -d/ -f1)
  else
    LIFECYCLE_BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'hyperpod-lifecycle-[^ ]*' | head -1 || true)
  fi
fi

if [ -z "$LIFECYCLE_BUCKET" ]; then
  echo "[setup_ssh] Could not determine lifecycle bucket. Skipping SSH setup."
  exit 0
fi

echo "[setup_ssh] Using bucket: ${LIFECYCLE_BUCKET}"

SSH_DIR="/home/ubuntu/.ssh"
mkdir -p "$SSH_DIR"
touch "$SSH_DIR/authorized_keys"

# Strategy: Try to download key from S3 first. If not found, generate and upload.
# This ensures compute nodes always get the head node's key.
if aws s3 cp "s3://${LIFECYCLE_BUCKET}/ssh/cluster_access_key" "$SSH_DIR/cluster_access_key" 2>/dev/null && \
   aws s3 cp "s3://${LIFECYCLE_BUCKET}/ssh/cluster_access_key.pub" "$SSH_DIR/cluster_access_key.pub" 2>/dev/null; then
  echo "[setup_ssh] Downloaded cluster access key from S3."
else
  # First node (head): generate and upload
  if [ ! -f "$SSH_DIR/cluster_access_key" ]; then
    ssh-keygen -t ed25519 -f "$SSH_DIR/cluster_access_key" -N "" -q
    echo "[setup_ssh] Generated cluster access key pair."
  fi
  aws s3 cp "$SSH_DIR/cluster_access_key" "s3://${LIFECYCLE_BUCKET}/ssh/cluster_access_key" 2>/dev/null || true
  aws s3 cp "$SSH_DIR/cluster_access_key.pub" "s3://${LIFECYCLE_BUCKET}/ssh/cluster_access_key.pub" 2>/dev/null || true
  echo "[setup_ssh] Uploaded cluster access key to S3."
fi

# Add cluster access public key to authorized_keys on all nodes
if [ -f "$SSH_DIR/cluster_access_key.pub" ]; then
  if ! grep -qf "$SSH_DIR/cluster_access_key.pub" "$SSH_DIR/authorized_keys" 2>/dev/null; then
    cat "$SSH_DIR/cluster_access_key.pub" >> "$SSH_DIR/authorized_keys"
  fi
fi

# Also authorize any user-provided public keys from S3
if aws s3 ls "s3://${LIFECYCLE_BUCKET}/ssh/user_keys/" 2>/dev/null; then
  mkdir -p /tmp/user_keys
  aws s3 cp "s3://${LIFECYCLE_BUCKET}/ssh/user_keys/" /tmp/user_keys/ --recursive 2>/dev/null || true
  for key in /tmp/user_keys/*.pub; do
    [ -f "$key" ] || continue
    if ! grep -qf "$key" "$SSH_DIR/authorized_keys" 2>/dev/null; then
      cat "$key" >> "$SSH_DIR/authorized_keys"
      echo "[setup_ssh] Added user key: $(basename "$key")"
    fi
  done
  rm -rf /tmp/user_keys
fi

chown -R ubuntu:ubuntu "$SSH_DIR"
chmod 700 "$SSH_DIR"
chmod 600 "$SSH_DIR/authorized_keys" "$SSH_DIR/cluster_access_key"
chmod 644 "$SSH_DIR/cluster_access_key.pub"

# Ensure sshd allows pubkey auth
if [ -f /etc/ssh/sshd_config ]; then
  sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
  systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true
fi

echo "[setup_ssh] SSH access configured."
