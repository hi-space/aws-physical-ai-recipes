# CloudWatch Agent 모니터링 가이드

> Isaac Lab GPU 인스턴스의 CPU, Memory, Disk, GPU 리소스를 CloudWatch로 모니터링하기 위한 구성 가이드.

## 개요

Isaac Lab 학습 워크로드는 GPU 집약적이며, 학습 진행 중 시스템 리소스 상태를 외부에서 확인할 필요가 있다.
CloudWatch Agent를 DCV 인스턴스에 설치하여 다음 메트릭을 자동 수집한다:

- **CPU**: 사용률, I/O 대기
- **Memory**: 사용률, 사용량, 전체 용량
- **Disk**: 사용률, 사용량, 전체 용량
- **GPU**: GPU 사용률, GPU 메모리 사용률/사용량, 온도, 전력 소비

## 아키텍처

```
EC2 (DCV Instance)
├── CloudWatch Agent (systemd)
│   ├── CPU/Memory/Disk → procstat/mem/disk 플러그인
│   └── GPU → nvidia_gpu 플러그인 (NVML 직접 접근)
│
└──→ CloudWatch Metrics
     └── Namespace: IsaacLab/Monitoring
         ├── Dimensions: InstanceId, InstanceType
         └── 60초 간격 수집
```

## 수집 메트릭

### 시스템 메트릭

| 메트릭 | 단위 | 설명 |
|--------|------|------|
| `cpu_usage_active` | % | CPU 전체 사용률 (user + system + iowait 등) |
| `cpu_usage_iowait` | % | I/O 대기 비율 (디스크 병목 감지) |
| `mem_used_percent` | % | 메모리 사용률 |
| `mem_used` | Bytes | 메모리 사용량 |
| `mem_total` | Bytes | 전체 메모리 |
| `disk_used_percent` | % | 루트(/) 디스크 사용률 |
| `disk_used` | Bytes | 디스크 사용량 |
| `disk_total` | Bytes | 전체 디스크 용량 |

### GPU 메트릭 (nvidia_gpu 플러그인)

| 메트릭 | 단위 | 설명 |
|--------|------|------|
| `nvidia_smi_utilization_gpu` | % | GPU 코어 사용률 |
| `nvidia_smi_utilization_memory` | % | GPU 메모리 대역폭 사용률 |
| `nvidia_smi_memory_used` | MiB | GPU 메모리 사용량 |
| `nvidia_smi_memory_total` | MiB | GPU 메모리 전체 용량 |
| `nvidia_smi_temperature_gpu` | C | GPU 온도 |
| `nvidia_smi_power_draw` | W | GPU 전력 소비 |

> `nvidia_gpu` 플러그인은 CloudWatch Agent 1.300025.0 이상에서 기본 내장되어 있으며, NVML(NVIDIA Management Library)을 통해 GPU 메트릭을 직접 수집한다. DCGM Exporter나 별도의 nvidia-smi 파싱 스크립트가 필요 없다.

멀티 GPU 인스턴스(예: g6.12xlarge, 4x NVIDIA L4)에서는 각 GPU별로 메트릭이 개별 수집되며, `gpu` dimension으로 구분된다.

## CDK 변경 사항

### 1. IAM 권한

`dcv-instance.ts`의 IAM Role에 `CloudWatchAgentServerPolicy` 관리형 정책을 추가한다.

```typescript
managedPolicyArns: [
  'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
  'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess',
  'arn:aws:iam::aws:policy/AmazonElasticFileSystemFullAccess',
  'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy',  // 추가
],
```

이 정책은 다음 권한을 부여한다:

| 권한 | 용도 |
|------|------|
| `cloudwatch:PutMetricData` | 커스텀 메트릭 전송 |
| `logs:CreateLogGroup` | 로그 그룹 자동 생성 |
| `logs:CreateLogStream` | 로그 스트림 생성 |
| `logs:PutLogEvents` | 로그 이벤트 전송 |

### 2. UserData 스크립트

`assets/userdata/cloudwatch-agent.sh`가 UserData 실행 순서 [3/6]으로 추가된다.

```
[1/6] common.sh          - 시스템 업데이트, 데스크톱, DCV, ROS2, Docker
[2/6] nvidia-driver.sh    - NVIDIA 드라이버 설치/업그레이드
[3/6] cloudwatch-agent.sh - CloudWatch Agent 설치 및 시작 ← 추가
[4/6] isaac-lab.sh        - Isaac Lab Docker 이미지 빌드
[5/6] efs-mount.sh        - EFS 마운트 및 모델 다운로드
[6/6] groot.sh            - GR00T 추론 서버 (선택)
```

nvidia-driver.sh 이후에 실행되어야 NVIDIA 드라이버(NVML)가 준비된 상태에서 `nvidia_gpu` 플러그인이 정상 동작한다.

### 3. Agent 설정 파일

`assets/cloudwatch/amazon-cloudwatch-agent.json`에 수집 대상 메트릭과 네임스페이스를 정의한다.

- **네임스페이스**: `IsaacLab/Monitoring` (CloudWatch 콘솔에서 커스텀 네임스페이스로 조회)
- **수집 간격**: 60초 (비용과 세분화 간 균형)
- **자동 차원**: `InstanceId`, `InstanceType`이 모든 메트릭에 자동 태깅

## 배포 후 확인

### 1. Agent 상태 확인

SSH 또는 DCV로 인스턴스에 접속한 후:

```bash
# Agent 상태 확인
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status

# 응답 예시
{
  "status": "running",
  "starttime": "2025-01-15T10:30:00+00:00",
  "configstatus": "configured",
  "cwoc_status": "stopped",
  "cwoc_starttime": "",
  "cwoc_configstatus": "not configured",
  "version": "1.300049.1"
}
```

### 2. Agent 로그 확인

문제 발생 시 로그를 확인한다:

```bash
# Agent 로그
tail -f /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log

# GPU 플러그인 관련 로그 필터링
grep -i nvidia /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```

### 3. CloudWatch 콘솔 확인

1. AWS Console → CloudWatch → Metrics → All metrics
2. Custom namespaces에서 `IsaacLab/Monitoring` 선택
3. `InstanceId` 차원으로 필터링하여 메트릭 확인

> 메트릭은 Agent 시작 후 약 1-2분 후부터 CloudWatch에 표시된다.

### 4. CLI로 메트릭 확인

```bash
# 최근 GPU 사용률 조회
aws cloudwatch get-metric-statistics \
  --namespace "IsaacLab/Monitoring" \
  --metric-name "nvidia_smi_utilization_gpu" \
  --dimensions Name=InstanceId,Value=<INSTANCE_ID> \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Average
```

## 비용

| 항목 | 예상 비용 |
|------|----------|
| 커스텀 메트릭 (14개 메트릭 × GPU 4개 포함) | ~$4.20/월 ($0.30/메트릭) |
| PutMetricData API 호출 | ~$0.01/월 |
| **합계** | **~$5/월** |

> 첫 10개 커스텀 메트릭은 무료 티어에 포함될 수 있다. 실제 비용은 GPU 수와 메트릭 수에 따라 달라진다.

## 트러블슈팅

### Agent가 시작되지 않는 경우

```bash
# systemd 서비스 상태 확인
sudo systemctl status amazon-cloudwatch-agent

# 수동 시작
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
```

### GPU 메트릭이 수집되지 않는 경우

1. NVIDIA 드라이버 정상 설치 확인: `nvidia-smi`
2. Agent 버전 확인: `amazon-cloudwatch-agent-ctl -a status` (1.300025.0 이상 필요)
3. Agent 로그에서 nvidia 관련 오류 확인

### IAM 권한 오류

CloudWatch 메트릭 전송 실패 시:
```bash
# 인스턴스 프로필에 CloudWatchAgentServerPolicy 포함 여부 확인
aws iam list-attached-role-policies --role-name <ROLE_NAME>
```
