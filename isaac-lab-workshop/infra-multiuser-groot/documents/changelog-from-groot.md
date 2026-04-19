# infra-multiuser-groot → isaac-lab-infra-templates-multiuser 변경 사항

`infra-multiuser-groot` 기반으로 배포 이슈를 수정한 버전이다.
변경이 없는 파일(`bin/isaac-lab-app.ts`, `isaac-lab-stack.ts`, `networking.ts`, `batch-infra.ts`, `efs-storage.ts`, `az-selector.ts`, `ami-mappings.ts`, `version-profiles.ts`)은 생략한다.

---

## 1. CDK 핵심 변경 — `lib/constructs/dcv-instance.ts`

### UserData 인라인 → S3 Asset 다운로드 방식 전환

| 항목 | infra-multiuser-groot (원본) | isaac-lab-infra-templates-multiuser (수정) |
|---|---|---|
| **UserData 전달 방식** | `readShellScript()`로 .sh 파일을 읽어 인라인 삽입 (Fn::Sub 치환) | `s3_assets.Asset`으로 S3에 업로드 후 UserData에서 `aws s3 cp` + `unzip`으로 다운로드 |
| **16KB 제한** | 스크립트 전체를 인라인하므로 EC2 UserData 16KB 제한에 걸릴 위험 | S3 Asset 방식으로 16KB 제한 회피 |
| **`readShellScript()` 함수** | 60줄짜리 헬퍼 (shebang 제거, 주석 제거, `${VAR}` → `$VAR` 변환) | 삭제 — 더 이상 필요 없음 |
| **스크립트 실행 방식** | 인라인된 스크립트 코드가 직접 실행 | `source /tmp/userdata-scripts/*.sh`로 실행 |
| **모듈 수** | 5개 (common, nvidia-driver, isaac-lab, efs-mount, groot) | 6개 (+`cloudwatch-agent.sh` 추가) |
| **Workshop 에셋** | 외부 S3 URL에서 `wget`으로 다운로드 | `s3_assets.Asset`으로 번들 → `/tmp`에서 `cp` |
| **IAM 정책** | — | `CloudWatchAgentServerPolicy` 추가 |

### 변경 상세

- **`import * as s3_assets from 'aws-cdk-lib/aws-s3-assets'`** 추가, `import * as fs from 'fs'` 삭제
- `readShellScript()` 함수 전체 삭제 (셸 변수 변환, shebang/주석 제거 로직)
- UserData 부트스트랩 로직 변경:
  ```bash
  # S3에서 스크립트 다운로드 후 순차 실행
  aws s3 cp ${UserdataScriptsUrl} /tmp/userdata-scripts.zip
  unzip -o /tmp/userdata-scripts.zip -d /tmp/userdata-scripts
  chmod +x /tmp/userdata-scripts/*.sh

  aws s3 cp ${WorkshopAssetsUrl} /tmp/workshop-assets.zip
  unzip -o /tmp/workshop-assets.zip -d /tmp/workshop-assets

  source /tmp/userdata-scripts/common.sh
  source /tmp/userdata-scripts/nvidia-driver.sh
  source /tmp/userdata-scripts/cloudwatch-agent.sh   # 신규
  source /tmp/userdata-scripts/isaac-lab.sh
  source /tmp/userdata-scripts/efs-mount.sh
  source /tmp/userdata-scripts/groot.sh
  ```
- Fn::Sub 치환 변수에 `UserdataScriptsUrl`, `WorkshopAssetsUrl` 추가

---

## 2. 신규 파일 — CloudWatch Agent 모니터링

### `assets/userdata/cloudwatch-agent.sh` (신규)

- CloudWatch Agent `.deb` 패키지를 AWS 공식 S3에서 다운로드하여 설치
- `IsaacLab/Monitoring` 네임스페이스로 메트릭 전송
- 수집 메트릭:
  - CPU: `cpu_usage_active`, `cpu_usage_iowait`
  - Memory: `mem_used_percent`, `mem_used`, `mem_total`
  - Disk: `disk_used_percent`, `disk_used`, `disk_total`
  - GPU (NVML): `nvidia_smi_utilization_gpu`, `nvidia_smi_utilization_memory`, `nvidia_smi_memory_used`, `nvidia_smi_memory_total`, `nvidia_smi_temperature_gpu`, `nvidia_smi_power_draw`
- 60초 간격 수집, `InstanceId`/`InstanceType` 디멘션 자동 추가

### `assets/cloudwatch/amazon-cloudwatch-agent.json` (신규)

- 위 스크립트에서 사용하는 CloudWatch Agent 설정 파일의 참조 복사본

---

## 3. 셸 스크립트 호환성 수정

### `assets/userdata/common.sh` — python3-rosdep2 설치

Ubuntu 24.04(Jazzy)에서 `python3-rosdep2` apt 패키지가 존재하지 않는 문제 대응.

```diff
- apt-get install -y python3-rosdep2
+ if apt-cache show python3-rosdep2 2>/dev/null | grep -q "^Package:"; then
+   apt-get install -y python3-rosdep2
+ else
+   apt-get install -y python3-pip
+   pip3 install --break-system-packages rosdep
+ fi
+ rosdep init 2>/dev/null || true
```

### `assets/userdata/groot.sh` — pip3 미설치 대응

Ubuntu 24.04 DLAMI에 pip3가 미설치된 경우를 처리.

```diff
- pip3 install -q huggingface_hub
+ if ! which pip3 > /dev/null 2>&1; then
+   apt-get install -y python3-pip
+ fi
+ pip3 install --break-system-packages -q huggingface_hub
```

### `assets/userdata/isaac-lab.sh` — Workshop 에셋 & EULA 처리

**에셋 다운로드 방식 변경:**
```diff
- wget https://ws-assets-prod-iad-r-pdx-f3b3f9f1a7d6a3d0.s3.us-west-2.amazonaws.com/.../Dockerfile
- wget https://ws-assets-prod-iad-r-pdx-f3b3f9f1a7d6a3d0.s3.us-west-2.amazonaws.com/.../distributed_run.bash
+ cp /tmp/workshop-dockerfile Dockerfile
+ cp /tmp/workshop-distributed-run distributed_run.bash
```

**Isaac Sim EULA 버전 분기:**
```diff
- sed -i '/^FROM/a ENV ACCEPT_EULA=Y\nUSER root' Dockerfile
+ MAJOR_VER=$(echo "${ISAAC_SIM_VERSION}" | cut -d. -f1)
+ if [ "${MAJOR_VER}" -ge 5 ] 2>/dev/null; then
+   sed -i '/^FROM/a ENV ACCEPT_EULA=Y\nENV OMNI_KIT_ACCEPT_EULA=YES\nUSER root' Dockerfile
+ else
+   :
+ fi
```

---

## 4. Workshop Dockerfile 변경 — `assets/workshop/Dockerfile`

| 항목 | 원본 | 수정 |
|---|---|---|
| 빌드 방식 | 최소 (`COPY . /workspace/IsaacLab` + `pip install -e .`) | 풀 빌드 (`_isaac_sim` 심볼릭 링크 + `isaaclab.sh --install`) |
| 시스템 패키지 | 없음 | `build-essential`, `cmake`, `git`, `libglib2.0-0` |
| 환경 변수 | 없음 | `ISAACSIM_ROOT_PATH`, `ISAACLAB_PATH`, `DEBIAN_FRONTEND`, `TERM` |
| 유저/셸 | 기본값 | `USER root`, `SHELL ["/bin/bash", "-c"]` |

---

## 요약

| 카테고리 | 변경 내용 |
|---|---|
| **UserData 16KB 제한 해결** | 인라인 스크립트 → S3 Asset 번들 다운로드 방식으로 전환 |
| **CloudWatch Agent 추가** | GPU/CPU/메모리/디스크 모니터링 (nvidia_gpu 플러그인 포함) |
| **Ubuntu 24.04 호환성** | `python3-rosdep2` fallback, `pip3` 미설치 대응, `--break-system-packages` 플래그 |
| **외부 URL 의존성 제거** | Workshop 에셋을 `wget` 외부 S3 → 리포 내장 S3 Asset으로 전환 |
| **Isaac Sim EULA 분기** | 무조건 추가 → 5.x 이상에서만 `ACCEPT_EULA` + `OMNI_KIT_ACCEPT_EULA` |
| **Dockerfile 보강** | 최소 `pip install` → 풀 빌드 환경 (`isaaclab.sh --install`) |
