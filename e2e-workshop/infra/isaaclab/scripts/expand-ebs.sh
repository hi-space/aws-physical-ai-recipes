#!/usr/bin/env bash
# =============================================================================
# expand-ebs.sh — 실행 중인 EC2 인스턴스의 EBS 볼륨 확장
#
# 사용법 (DCV 인스턴스 내부에서 실행):
#   sudo ./scripts/expand-ebs.sh 500        # 500GB로 확장
#   sudo ./scripts/expand-ebs.sh            # 기본 500GB
#
# 사용법 (외부에서 인스턴스 ID 지정):
#   ./scripts/expand-ebs.sh 500 i-0abc123def
# =============================================================================
set -euo pipefail

NEW_SIZE="${1:-500}"
INSTANCE_ID="${2:-$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "")}"
REGION="${AWS_DEFAULT_REGION:-$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || aws configure get region 2>/dev/null || echo "us-east-1")}"

if [[ -z "$INSTANCE_ID" ]]; then
  echo "Error: 인스턴스 ID를 확인할 수 없습니다. 두 번째 인자로 지정하세요."
  echo "Usage: $0 [SIZE_GB] [INSTANCE_ID]"
  exit 1
fi

echo "=== EBS 볼륨 확장 ==="
echo "Instance: $INSTANCE_ID"
echo "Region:   $REGION"
echo "New Size: ${NEW_SIZE}GB"
echo ""

# 1. 루트 볼륨 ID 조회
VOLUME_ID=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName==`/dev/sda1`].Ebs.VolumeId' \
  --output text)

if [[ -z "$VOLUME_ID" || "$VOLUME_ID" == "None" ]]; then
  echo "Error: 루트 볼륨을 찾을 수 없습니다."
  exit 1
fi

CURRENT_SIZE=$(aws ec2 describe-volumes \
  --volume-ids "$VOLUME_ID" \
  --region "$REGION" \
  --query 'Volumes[0].Size' --output text)

echo "Volume:   $VOLUME_ID (현재 ${CURRENT_SIZE}GB)"

if (( CURRENT_SIZE >= NEW_SIZE )); then
  echo "이미 ${CURRENT_SIZE}GB — 확장 불필요"
  exit 0
fi

# 2. EBS 볼륨 크기 변경
echo ""
echo "→ ${CURRENT_SIZE}GB → ${NEW_SIZE}GB 변경 중..."
aws ec2 modify-volume \
  --volume-id "$VOLUME_ID" \
  --size "$NEW_SIZE" \
  --region "$REGION" \
  --output text --query 'VolumeModification.ModificationState'

# 3. 변경 완료 대기
echo "→ 볼륨 변경 대기 중..."
while true; do
  STATE=$(aws ec2 describe-volumes-modifications \
    --volume-ids "$VOLUME_ID" \
    --region "$REGION" \
    --query 'VolumesModifications[0].ModificationState' --output text 2>/dev/null || echo "completed")
  if [[ "$STATE" == "completed" || "$STATE" == "optimizing" ]]; then
    break
  fi
  sleep 5
done
echo "→ 볼륨 변경 완료 ($STATE)"

# 4. 파일시스템 확장 (인스턴스 내부에서 실행 시)
if [[ -f /etc/os-release ]]; then
  echo ""
  echo "→ 파티션 및 파일시스템 확장 중..."
  DEVICE=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /) 2>/dev/null || echo "nvme0n1")
  PART_NUM=$(lsblk -no MAJ:MIN $(findmnt -n -o SOURCE /) | awk -F: '{print $2}')
  
  sudo growpart /dev/"$DEVICE" "$PART_NUM" 2>/dev/null || true
  sudo resize2fs $(findmnt -n -o SOURCE /) 2>/dev/null || \
    sudo xfs_growfs / 2>/dev/null || true
  
  echo ""
  echo "=== 완료 ==="
  df -h /
else
  echo ""
  echo "=== 볼륨 확장 완료 ==="
  echo "인스턴스 내부에서 파일시스템 확장 필요:"
  echo "  sudo growpart /dev/nvme0n1 1"
  echo "  sudo resize2fs /dev/nvme0n1p1"
fi
