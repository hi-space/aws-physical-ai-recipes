#!/usr/bin/env bash
# =============================================================================
# expand-ebs.sh — EC2 EBS volume expansion (online, no reboot required)
#
# Usage (inside EC2 instance):
#   sudo bash expand-ebs.sh 500        # expand to 500GB
#   sudo bash expand-ebs.sh            # default 500GB
#
# Usage (external, specify instance ID):
#   bash expand-ebs.sh 500 i-0abc123def
# =============================================================================
set -euo pipefail

NEW_SIZE="${1:-500}"
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || echo "")
INSTANCE_ID="${2:-$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")}"
REGION="${AWS_DEFAULT_REGION:-$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || aws configure get region 2>/dev/null || echo "us-east-1")}"

if [[ -z "$INSTANCE_ID" ]]; then
  echo "Error: Cannot detect instance ID. Pass it as second argument."
  echo "Usage: $0 [SIZE_GB] [INSTANCE_ID]"
  exit 1
fi

echo "=== EBS Volume Expansion ==="
echo "Instance: $INSTANCE_ID"
echo "Region:   $REGION"
echo "Target:   ${NEW_SIZE}GB"
echo ""

# 1. Find root volume
ROOT_DEVICE_NAME=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].RootDeviceName' \
  --output text)

VOLUME_ID=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName==\`${ROOT_DEVICE_NAME}\`].Ebs.VolumeId" \
  --output text)

if [[ -z "$VOLUME_ID" || "$VOLUME_ID" == "None" ]]; then
  echo "Error: Cannot find root volume. (RootDeviceName: $ROOT_DEVICE_NAME)"
  exit 1
fi

CURRENT_SIZE=$(aws ec2 describe-volumes \
  --volume-ids "$VOLUME_ID" \
  --region "$REGION" \
  --query 'Volumes[0].Size' --output text)

echo "Volume:   $VOLUME_ID (current: ${CURRENT_SIZE}GB)"

# 2. Modify volume (skip if already target size)
if (( CURRENT_SIZE < NEW_SIZE )); then
  echo ""
  echo "Modifying volume: ${CURRENT_SIZE}GB -> ${NEW_SIZE}GB..."
  aws ec2 modify-volume \
    --volume-id "$VOLUME_ID" \
    --size "$NEW_SIZE" \
    --region "$REGION" \
    --output text --query 'VolumeModification.ModificationState'

  # 3. Wait for modification
  echo "Waiting for volume modification..."
  for i in $(seq 1 60); do
    STATE=$(aws ec2 describe-volumes-modifications \
      --volume-ids "$VOLUME_ID" \
      --region "$REGION" \
      --query 'VolumesModifications[0].ModificationState' --output text 2>/dev/null || echo "completed")
    if [[ "$STATE" == "completed" || "$STATE" == "optimizing" ]]; then
      break
    fi
    if [[ "$STATE" == "failed" ]]; then
      echo "Error: Volume modification failed."
      exit 1
    fi
    sleep 5
  done
  echo "Volume modification done ($STATE)"
else
  echo "Volume already ${CURRENT_SIZE}GB (>= ${NEW_SIZE}GB), skipping modify."
fi

# 4. Expand filesystem (always attempt when running inside instance)
if [[ -f /etc/os-release ]]; then
  echo ""
  echo "Expanding partition and filesystem..."
  ROOT_DEV=$(findmnt -n -o SOURCE /)
  DEVICE=$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null || echo "")
  PART_NUM=$(echo "$ROOT_DEV" | grep -o '[0-9]*$')

  if [[ -n "$PART_NUM" && -n "$DEVICE" ]]; then
    growpart /dev/"$DEVICE" "$PART_NUM" 2>/dev/null || true
  fi
  resize2fs "$ROOT_DEV" 2>/dev/null || \
    xfs_growfs / 2>/dev/null || true

  echo ""
  echo "=== Done ==="
  df -h /
else
  echo ""
  echo "=== Volume expanded ==="
  echo "Run inside instance to expand filesystem:"
  echo "  growpart /dev/nvme0n1 1"
  echo "  resize2fs /dev/nvme0n1p1"
fi
