#!/bin/bash -e
# =============================================================================
# cloudwatch-agent.sh - CloudWatch Agent 설치 및 구성 스크립트
# =============================================================================
# CloudWatch Agent를 설치하고 CPU, Memory, Disk, GPU 메트릭을 수집하도록 구성한다.
# nvidia_gpu 플러그인은 NVML을 사용하므로 NVIDIA 드라이버 설치 후에 실행해야 한다.
#
# 입력 환경 변수: 없음 (독립 실행 가능)
# =============================================================================

echo "===== [$(date)] START: cloudwatch-agent.sh ====="

# -----------------------------------------------------------------------------
# 1. CloudWatch Agent 설치
#    AWS 공식 S3에서 .deb 패키지를 다운로드하여 설치한다.
# -----------------------------------------------------------------------------
CW_AGENT_DEB="/tmp/amazon-cloudwatch-agent.deb"

if which amazon-cloudwatch-agent-ctl > /dev/null 2>&1; then
  echo "CloudWatch Agent가 이미 설치되어 있습니다."
else
  echo "CloudWatch Agent를 설치합니다..."
  ARCH=$(dpkg --print-architecture)
  wget -q "https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/${ARCH}/latest/amazon-cloudwatch-agent.deb" \
    -O "$CW_AGENT_DEB"
  dpkg -i "$CW_AGENT_DEB"
  rm -f "$CW_AGENT_DEB"
  echo "CloudWatch Agent 설치 완료"
fi

# -----------------------------------------------------------------------------
# 2. CloudWatch Agent 설정 파일 배포
#    CPU, Memory, Disk, GPU 메트릭을 60초 간격으로 수집한다.
#    nvidia_gpu 플러그인은 NVML을 통해 GPU 메트릭을 직접 수집한다.
# -----------------------------------------------------------------------------
CW_CONFIG_DIR="/opt/aws/amazon-cloudwatch-agent/etc"
CW_CONFIG_FILE="${CW_CONFIG_DIR}/amazon-cloudwatch-agent.json"

mkdir -p "$CW_CONFIG_DIR"

cat > "$CW_CONFIG_FILE" << 'CWEOF'
{
  "metrics": {
    "namespace": "IsaacLab/Monitoring",
    "metrics_collected": {
      "cpu": {
        "measurement": ["cpu_usage_active", "cpu_usage_iowait"],
        "metrics_collection_interval": 60,
        "totalcpu": true,
        "resources": ["*"]
      },
      "mem": {
        "measurement": ["mem_used_percent", "mem_used", "mem_total"],
        "metrics_collection_interval": 60
      },
      "disk": {
        "measurement": ["disk_used_percent", "disk_used", "disk_total"],
        "metrics_collection_interval": 60,
        "resources": ["/"],
        "ignore_file_system_types": ["tmpfs", "devtmpfs", "squashfs", "overlay"]
      },
      "nvidia_gpu": {
        "measurement": [
          "nvidia_smi_utilization_gpu",
          "nvidia_smi_utilization_memory",
          "nvidia_smi_memory_used",
          "nvidia_smi_memory_total",
          "nvidia_smi_temperature_gpu",
          "nvidia_smi_power_draw"
        ],
        "metrics_collection_interval": 60
      }
    },
    "append_dimensions": {
      "InstanceId": "${!aws:InstanceId}",
      "InstanceType": "${!aws:InstanceType}"
    }
  }
}
CWEOF

echo "CloudWatch Agent 설정 파일 배포 완료: ${CW_CONFIG_FILE}"

# -----------------------------------------------------------------------------
# 3. CloudWatch Agent 시작
#    amazon-cloudwatch-agent-ctl로 설정 파일을 적용하고 에이전트를 시작한다.
# -----------------------------------------------------------------------------
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c "file:${CW_CONFIG_FILE}"

echo "CloudWatch Agent 시작 완료"

echo "===== [$(date)] END: cloudwatch-agent.sh ====="
