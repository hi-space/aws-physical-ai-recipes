# AWS Managed Observability

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

이 선택적 Terraform root는 OSMO를 위한 AWS 관리형 관측성 경로를 배포합니다:

- Amazon Managed Service for Prometheus (AMP) workspace.
- 클러스터 내 Prometheus가 AMP로 `remote_write` 메트릭을 전송할 수 있도록 허용하는 IRSA 역할.
- 짧은 로컬 보존 기간과 AMP SigV4 `remote_write`로 구성된 `prometheus-community/kube-prometheus-stack`.
- `AWS_SSO`를 사용하는 AWS IAM Identity Center 기반의 Amazon Managed Grafana (AMG) workspace.
- AMP 데이터 소스 및 대시보드를 프로비저닝하기 위해 `scripts/deploy-observability.sh`가 사용하는 AMG 서비스 계정.

AMG는 로컬 Grafana 사용자명 또는 비밀번호를 생성하지 않습니다. 브라우저 접근을 위해서는 `admin_user_ids`, `admin_group_ids`, `editor_group_ids`, 또는 `viewer_group_ids`를 통해 IAM Identity Center 사용자 또는 그룹 ID를 제공해야 합니다.

## 브라우저 로그인

Grafana 브라우저 로그인을 위한 IAM 사용자나 IAM 비밀번호를 생성하지 마세요. `AWS_SSO`를 사용하면 AMG는 AWS IAM Identity Center 사용자 및 그룹을 사용합니다. Terraform은 `aws_grafana_role_association`을 통해 해당 ID에 Grafana 역할을 부여합니다.

IAM Identity Center가 이미 활성화되어 있다면 identity store와 사용자 또는 그룹 ID를 다음과 같이 확인하세요:

```bash
IDENTITY_CENTER_REGION="us-east-1"

aws sso-admin list-instances \
  --region "${IDENTITY_CENTER_REGION}" \
  --query 'Instances[].{InstanceArn:InstanceArn,IdentityStoreId:IdentityStoreId}' \
  --output table

IDENTITY_STORE_ID="d-xxxxxxxxxx"

aws identitystore list-users \
  --identity-store-id "${IDENTITY_STORE_ID}" \
  --region "${IDENTITY_CENTER_REGION}" \
  --query 'Users[].{UserName:UserName,DisplayName:DisplayName,UserId:UserId}' \
  --output table

aws identitystore list-groups \
  --identity-store-id "${IDENTITY_STORE_ID}" \
  --region "${IDENTITY_CENTER_REGION}" \
  --query 'Groups[].{DisplayName:DisplayName,GroupId:GroupId}' \
  --output table
```

선택한 ID를 `infra/observability/terraform.tfvars`에 입력합니다:

```hcl
admin_user_ids = [
  "11111111-2222-3333-4444-555555555555"
]

admin_group_ids = [
  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
]
```

`scripts/deploy-observability.sh`가 완료되면 `amg_workspace_url` 출력값을 열어 접속합니다. 브라우저 로그인은 IAM Identity Center를 통해 이루어집니다. 배포 래퍼가 생성한 서비스 계정 토큰은 데이터 소스 및 대시보드의 API 프로비저닝 전용이며, 사람이 사용하는 로그인 자격증명이 아니고 의도적으로 단기 수명으로 설정됩니다.

```bash
cp infra/observability/terraform.tfvars.example infra/observability/terraform.tfvars

terraform -chdir=infra/core output -raw cluster_name
terraform -chdir=infra/core output -raw cluster_oidc_issuer_url
terraform -chdir=infra/core output -raw cluster_oidc_provider_arn

scripts/deploy-observability.sh -auto-approve
```

배포 래퍼는 이 Terraform root를 적용하고, 기존 OSMO Helm 릴리스에 OSMO PodMonitor 리소스를 활성화하며, 단기 수명 AMG 서비스 계정 토큰을 생성하고, AMP 데이터 소스를 프로비저닝하고, `dashboards/`에서 고정된 OSMO 대시보드를 가져오며, `AWS OSMO Overview` 대시보드를 생성하고, OSMO 백엔드 `grafana_url`을 업데이트합니다.

`dashboards/`의 대시보드 JSON 파일은 NVIDIA OSMO `c2c30e55f84969fff55d51cd2044a03d40d6a1a5`의 `docs/deployment_guide/dashboards/`에서 복사한 것입니다.

upstream 대시보드 JSON은 `cluster` 레이블을 기대하며, 워크로드 DCGM 메트릭에 Prometheus Operator가 내보낸 레이블(예: `exported_namespace`, `exported_pod`, `exported_container`)을 사용합니다. 이 Terraform root는 AMP remote write 전에 Prometheus `externalLabels.cluster`를 `cluster_name`으로 설정합니다. 배포 래퍼는 DCGM ServiceMonitor를 Prometheus Operator 기본값인 `honorLabels: false` 상태로 유지하므로, exporter에서 제공한 워크로드 레이블이 대상 레이블을 덮어쓰지 않고 `exported_*` 레이블로 노출됩니다.

## 대시보드 범위

`AWS OSMO Overview`는 AWS 운영 대시보드입니다. AMG AMP 데이터 소스를 통해 `up{namespace="osmo"}`로 스크랩 상태를 조회하므로 배포 직후부터 데이터가 표시되어야 합니다.

또한 `count_over_time(kube_pod_info{namespace="osmo-workflows"}[24h])`를 기반으로 최근 워크플로우 pod 뷰를 포함합니다.

GPU Operator 네임스페이스가 존재하는 경우 배포 래퍼가 `nvidia-dcgm-exporter` ServiceMonitor도 생성하므로, GPU 워크플로우 실행 후 `AWS OSMO Overview`에서 DCGM GPU 사용률, 프레임버퍼, 전력, 온도 메트릭을 확인할 수 있습니다.

가져온 upstream OSMO 대시보드는 워크로드별로 구성됩니다:

- `Workflow Resources`는 활성 워크플로우 pod(주로 `osmo-workflows`)의 리소스 및 GPU 메트릭을 보여줍니다. 실행 중인 워크플로우 pod가 없으면 데이터가 표시되지 않는 것이 정상입니다.
- `Backend Operator`는 백엔드 operator pod 리소스와 함께 큐, 이벤트, 잡 메트릭을 보여줍니다. 백엔드 리소스 패널은 OSMO 백엔드 pod가 스크랩될 때 채워지며, 큐 및 잡 패널은 백엔드 활동이 해당 메트릭을 방출한 이후에만 채워집니다.
- `Observability Dashboard`는 upstream OSMO 서비스 대시보드입니다. 고정된 JSON이 upstream 네임스페이스 및 메트릭 규칙을 전제하므로, 로컬 배포 환경이 그 규칙에 맞지 않는 경우 upstream 참조용으로만 사용하세요.

## 런타임 검증

상태: 2026-05-05 수동 통과 후, 이 Terraform root 추가 전이었으며 2026-05-06 GPU 메트릭으로 재검증.

검증 범위:

- `ap-northeast-2`의 AMP workspace `ws-41a61aa8-e5cb-4196-aa2f-12abae537904`.
- 클러스터 내 Prometheus `remoteWrite`가 SigV4를 사용해 AMP workspace 엔드포인트로 구성됨.
- OSMO PodMonitor 리소스 `otel-monitor`와 `osmo-backend-otel-monitor`.
- DCGM exporter ServiceMonitor `nvidia-dcgm-exporter`.
- `up{namespace="osmo"}`에 대한 직접 AMP 쿼리에서 다섯 개의 정상 OSMO 타겟이 반환됨.
- AMP Prometheus 데이터 소스가 있는 AMG workspace `g-9d381a8099`.
- `up{namespace="osmo"}`에 대한 AMG 데이터 소스 프록시 쿼리에서 동일한 다섯 개의 정상 OSMO 타겟이 반환됨.
- 관측성 설정 후 워크플로우 `aws-osmo-smoke-9` 제출; AMG 데이터 소스 프록시가 24시간 동안 `aws-osmo-smoke-9`를 포함한 21개의 `osmo-workflows` pod 시리즈를 반환.
- 관측성 설정 후 GPU 워크플로우 `aws-osmo-gpu-smoke-3` 제출; 워크플로우가 `NVIDIA RTX PRO 6000 Blackwell Server Edition`에서 120초 CUDA burn을 실행하고 219초 만에 완료됨.
- AMP에 대한 AMG 데이터 소스 프록시 쿼리가 1시간 최댓값 DCGM 수치를 반환: `DCGM_FI_DEV_GPU_UTIL=100`, `DCGM_FI_DEV_FB_USED=1070`, `DCGM_FI_DEV_POWER_USAGE=537.003`, `DCGM_FI_DEV_GPU_TEMP=67`.
- DCGM `honorLabels` 제거 후 upstream 대시보드 레이블 형식 재검증: AMP가 Kubernetes 메트릭에서 `cluster="aws-osmo-dev-repro-eks"`를, `osmo-workflows`의 GPU pod에 대한 DCGM 메트릭에서 `exported_namespace="osmo-workflows"`, `exported_pod`, `exported_container`를 반환함.
- OSMO `Workflow Resources` 및 `Backend Operator` 대시보드와 `AWS OSMO Overview` 대시보드 가져오기 완료.
- OSMO 백엔드 `default`의 `grafana_url`이 AMG workspace URL로 설정됨.

실제 검증에서는 AMG 인증에 `AWS_SSO`를 사용하고, API 프로비저닝에는 단기 수명 서비스 계정 토큰을 사용했습니다. 로컬 AMG id/비밀번호는 존재하지 않습니다.

## GPU 시각적 검증

아래 AMG 패널 캡처는 `aws-osmo-gpu-smoke-3` 완료 후 `AWS OSMO Overview` 대시보드에서 촬영한 것입니다. 동일한 수치가 [gpu-smoke-observability.json](validation/gpu-smoke-observability.json)에 기록되어 있습니다.

수동으로 재현하려면:

- AMG workspace `g-9d381a8099`를 열고 `AWS OSMO Overview` 대시보드를 선택합니다.
- GPU smoke 실행 직후 시간 범위를 `Last 1 hour`로 설정하거나, `aws-osmo-gpu-smoke-3`의 경우 `2026-05-06 14:04:27-14:06:28 KST` 주변의 절대 범위를 사용합니다.
- GPU 패널은 `exported_namespace="osmo-workflows"`로 DCGM 메트릭을 조회하므로 exporter pod 자체가 아닌 워크로드 pod 메트릭을 보여줍니다.
- Grafana Explore에서 동등한 필터는 AMP 데이터 소스에 대해 `DCGM_FI_DEV_GPU_UTIL{exported_namespace="osmo-workflows"}`입니다.

![GPU utilization](validation/10-grafana-gpu-utilization-panel.png)

![GPU framebuffer used](validation/11-grafana-gpu-framebuffer-panel.png)

![GPU power usage](validation/12-grafana-gpu-power-panel.png)

![GPU temperature](validation/13-grafana-gpu-temperature-panel.png)
