# AWS NVIDIA 로보틱스 레퍼런스 아키텍처

Amazon EKS 위에 NVIDIA OSMO와 검증된 로보틱스 워크플로를 배포하기 위한 AWS 레퍼런스 구현입니다.

이 리포는 스택의 AWS 측을 담당합니다: 보안이 적용된 EKS 랜딩 존, GPU 용량 관리, AWS 관리형 백엔드 서비스, OSMO 배포 래퍼, 워크플로 예제, 검증 산출물, 호환성 노트. NVIDIA OSMO는 외부에 고정(pin)된 의존성으로 남으며, 이 리포는 의도적으로 NVIDIA OSMO 소스·NVIDIA Terraform·로컬 OSMO 패치를 포함(vendor)하지 않습니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본이며, 이 환경에서 검증한 G6(NVIDIA L4) 폴백 경로를 함께 담았습니다. 상세 원문은 영문 README를 기준으로 삼으세요.

## 제공 범위

### AWS 인프라

- 프라이빗 서브넷 기반의 현행 표준 지원 Amazon EKS 베이스라인.
- OSMO용 AWS 네이티브 백엔드 서비스: Amazon RDS PostgreSQL, Amazon ElastiCache for Redis, Amazon S3, Amazon ECR, AWS KMS, IRSA.
- On-Demand G7e 인스턴스용 Karpenter GPU NodePool. 프라이빗 서브넷 배치, IMDSv2, 암호화된 gp3 루트 볼륨, 고정된 EKS AL2023 NVIDIA AMI 사용.
- 고정된 Helm 차트에서 설치되는 NVIDIA GPU Operator. EKS NVIDIA AMI를 쓰므로 드라이버/툴킷 설치는 비활성화.
- 고정된 Helm 차트에서 설치되는 AWS EFA 디바이스 플러그인. EFA 지원 GPU 노드에서 `vpc.amazonaws.com/efa`를 노출하기 위한 G7e GPU taint toleration 포함.

### OSMO 배포

- 고정된 OCI Helm 차트에서 설치되는 KAI Scheduler. OSMO 워크플로가 실제 `scheduling.run.ai` PodGroup CRD와 `kai-scheduler`를 사용하도록 함.
- 업스트림 `deploy-k8s.sh`를 호출하는 대신, 명시적 Helm 값으로 OSMO를 설치하는 배포 스크립트.
- 로컬 `kubectl port-forward` 접근을 위한 프라이빗 ClusterIP 서비스로 설치되는 OSMO Web UI.
- 클러스터·OSMO 서비스·백엔드 오퍼레이터 토큰·KAI 스케줄링·Karpenter 프로비저닝·GPU 런타임 경로의 재현성을 증명하는 CPU/GPU 스모크 경로.

### 검증된 로보틱스 워크플로

- OSMO CPU/GPU 스모크 워크플로.
- 체크포인트와 검증 산출물을 보존하는 NVIDIA GR00T 파인튜닝 워크플로.
- OpenPI LoRA 파인튜닝 예제.
- Cosmos Reason2 NIM 및 Cosmos 증강(augmentation) 예제.
- Isaac Lab / RSL-RL 검증 예제.
- 업스트림 OSMO 쿡북에서 가져온 멀티스테이지 nut pouring 파이프라인.

### 재현성

- `versions.yaml`과 `docs/`의 버전 고정 및 호환성 노트.

## 리포 구조

```text
infra/core/          AWS 레퍼런스 아키텍처 IaC
infra/ingress/       OSMO UI용 선택적 HTTPS admin ingress
infra/observability/ 선택적 AMP·AMG 관측성 루트
scripts/             preflight, deploy, validate, submit, cleanup, destroy 래퍼
examples/            자체 완결형 OSMO 예제 워크플로·문서·검증 산출물
docs/                아키텍처, 관측성, 재현성, 보안, 버전 매트릭스, 호환성
versions.yaml        고정된 외부 버전 및 테스트된 범위
```

## 사전 요구사항

- AWS CLI v2, Terraform, kubectl, Helm, jq, curl, git, 그리고 OSMO CLI.
- `nvcr.io/nvidia/osmo`의 고정된 OSMO 이미지에 접근 가능한 NGC API 키.
- 전체 nut pouring 파이프라인을 돌리려면 `HF_TOKEN` 환경변수 또는 읽을 수 있는 토큰 파일을 가리키는 `HF_TOKEN_FILE`.

`scripts/preflight.sh` 또는 `scripts/deploy-osmo.sh` 실행 전에 NGC API 키를 환경변수나 로컬 키 파일로 제공하세요:

```bash
export NGC_API_KEY="<your-ngc-api-key>"
```

배포 래퍼는 `~/.nvidia`의 원시 키나 `NGC_API_KEY_FILE`로 지정한 다른 파일 경로도 받습니다. NGC 키 파일은 커밋하지 마세요.

## 빠른 시작

```bash
cp infra/core/terraform.tfvars.example infra/core/terraform.tfvars
scripts/preflight.sh
scripts/deploy-infra.sh
scripts/deploy-karpenter.sh
scripts/deploy-gpu-operator.sh
scripts/deploy-efa-device-plugin.sh
scripts/deploy-osmo-sso-bootstrap.sh   # 최초 SSO 배포: 아래 노트 참고
scripts/validate-platform.sh
scripts/smoke-test.sh
```

6.3.1 SSO 게이트웨이에는 부트스트랩 순서 문제가 있습니다. `deploy-osmo.sh`는
`infra/cloudfront`의 `osmo_ui_cloudfront_domain` 출력을 요구하지만,
`infra/cloudfront`는 OSMO 배포 후에야 생기는 `osmo-gateway` Service
LoadBalancer가 있어야 합니다. `scripts/deploy-osmo-sso-bootstrap.sh`가 이
순환을 끊습니다: placeholder 콜백으로 `infra/cognito`를 apply하고,
`deploy-osmo.sh`를 한 번 돌려 게이트웨이 LoadBalancer를 만든 뒤, 그 LB를
오리진으로 `infra/cloudfront`를 apply하고, 마지막에 실제 CloudFront 호스트명으로
`infra/cognito`를 재적용하고 `deploy-osmo.sh`를 다시 실행합니다. 이후 배포에서는
CloudFront 도메인이 안정되므로 `scripts/deploy-osmo.sh`를 직접 실행하면 됩니다.
기본 리전이 아니면 `TF_WORKSPACE`를 export하고 `COGNITO_VAR_FILE` /
`CLOUDFRONT_VAR_FILE`을 해당 `terraform.<region>.tfvars`로 지정하세요.

`scripts/smoke-test.sh`는 기본으로 `examples/osmo-smoke/workflow.yaml`을 제출합니다. GPU 스모크 워크플로의 경우, OSMO 리소스 검증이 GPU 플랫폼 용량을 관측할 수 있도록 G7e 노드를 미리 워밍(prewarm)하세요:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/gpu-smoke/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=180 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

GPU 스모크 경로는 실시간 G7e(RTX PRO 6000) On-Demand 용량에 의존합니다.
`prewarm-gpu-node.sh`는 Karpenter가 실제 G7e 노드를 띄우도록 강제해 제출 전에
OSMO가 GPU 플랫폼을 등록하게 합니다. 등록된 노드가 없으면 OSMO는 워크플로를
`no resources in platform`으로 거부합니다. Karpenter는 항상 가장 저렴한 인스턴스
타입(예: `g7e.2xlarge`)부터 시도하고 `InsufficientInstanceCapacity` 시 큰
사이즈로 자동 확대하지 않으므로, 풀의 AZ에 On-Demand G7e 재고가 없으면 노드가
끝내 뜨지 않습니다. 풀을 더 많은 AZ로 분산(아래 참고)하거나 용량이 회복될 때
재시도하세요.

검증된 예제 워크플로는 [examples/](examples/README.md) 아래에 있습니다. 각 예제 폴더는 워크플로 정의·실행 방법·검증 산출물을 함께 보관합니다.

### 멀티리전 G7e AZ 선택

G7e(RTX PRO 6000)는 리전마다 서로 다른(때로는 비연속적인) AZ에서 제공되며, 단일
AZ의 On-Demand 용량은 고갈될 수 있습니다. `infra/core/main.tf`에
`g7e_azs_by_region` 맵이 있어 AZ 선택이 다음 순서로 해결됩니다: 명시적
`availability_zones` 변수 → 리전 맵 조회 → 자동 발견된 AZ. `availability_zones =
[]`로 두면 맵에 위임합니다. 현재 핀: `ap-northeast-2` = `[a, b]`, `us-east-1` =
`[b, d]`(비연속), `us-east-2` = `[a, b]`, `us-west-2` = `[a, b, c, d]`.

한 AZ가 용량 제약일 때 GPU 노드가 다른 AZ로 폴백할 수 있도록, Karpenter 프라이빗
서브넷을 EKS/스테이트풀 풋프린트보다 넓게 분산하세요. EKS + RDS는 앞의 `az_count`
개 AZ에 머물고, Karpenter 서브넷은 `karpenter_az_count`개에 걸칩니다:

```hcl
availability_zones = ["us-west-2a", "us-west-2b", "us-west-2c", "us-west-2d"]
az_count           = 2   # EKS + RDS는 a/b
karpenter_az_count = 4   # GPU 노드는 a/b/c/d 중 어디든
```

리전별 시작점은 `infra/core/terraform.<region>.tfvars.example`(`use1`, `use2`,
`usw2`)에 있으며, 각각 리전 suffix가 붙은 `project_name`을 써서 같은 계정
멀티리전 배포 시 account-global IAM 이름 충돌을 피합니다.

### Cognito SSO로 OSMO UI에 HTTPS 접속

`deploy-osmo-sso-bootstrap.sh` 경로는 OSMO UI를 CloudFront
(`https://<osmo-ui-cloudfront-domain>`) 뒤에 Amazon Cognito 싱글 사인온과 함께
게시합니다. 6.3.1에서는 UI·API 게이트웨이·envoy·oauth2-proxy가 `osmo-service`
릴리스로 통합되어 있습니다. 인증되지 않은 요청은 Cognito hosted 로그인 UI로
리다이렉트되고, 로그인 후 oauth2-proxy가 세션을 수립합니다.

접근은 두 계층으로 제한됩니다: `infra/cloudfront`의 WAF IP 허용 목록이 배포에
도달할 수 있는 대상을 통제하고, Cognito가 로그인할 수 있는 사용자를 통제합니다.
최초 접속 전에 Cognito user pool에 로그인 사용자(아이디/비밀번호)를 생성하세요:

```bash
POOL=$(terraform -chdir=infra/cognito output -raw user_pool_id)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL" \
  --username admin@example.com \
  --password '<강력한-비밀번호>' --permanent
```

그다음 화이트리스트에 등록된 IP에서 `https://<osmo-ui-cloudfront-domain>`을 열고
위 아이디/비밀번호로 로그인합니다. 도메인은 언제든 다음으로 조회할 수 있습니다:

```bash
terraform -chdir=infra/cloudfront output -raw osmo_ui_cloudfront_domain
```

### SSO 없이 로컬 접근

로컬 UI 접근을 위해 UI 포트포워드를 열어두세요:

```bash
kubectl -n osmo port-forward svc/osmo-ui 9001:80
```

그다음 <http://127.0.0.1:9001> 을 엽니다. 기본 UI 배포는 UI 파드에서 `osmo-service:80`으로 API 요청을 프록시합니다. 다른 프라이빗 엔드포인트를 쓰려면 `scripts/deploy-osmo.sh` 실행 전에 `OSMO_UI_API_HOSTNAME`을 오버라이드하세요.

로컬 CLI나 직접 API 접근을 위해서는 별도의 API 포트포워드를 열어두세요. 6.3.1에서
`osmo-service:80`은 self-signed TLS만 제공하므로, 평문 OSMO CLI 로그인 경로는
`osmo-internal-router`(API로 향하는 no-auth 평문 HTTP 경로)를 거쳐야 합니다:

```bash
kubectl -n osmo port-forward svc/osmo-internal-router 9000:80
```

## G6(NVIDIA L4) 용량 폴백 경로

G7e(RTX PRO 6000, 96GB)가 특정 리전에서 재고 부족(InsufficientInstanceCapacity)일 때, 이 리포는 G6(NVIDIA L4, 24GB)로 폴백하는 경로를 제공합니다. 기본 G7e 로직은 그대로 두고, 환경변수로 G6 경로를 추가로 켜는 방식입니다.

```bash
# 1) G6 NodePool 생성 (G7e EC2NodeClass 재사용, 단일 AZ 핀)
DEPLOY_G6_NODEPOOL=true scripts/deploy-karpenter.sh

# 2) OSMO에 g6-l4 플랫폼 등록
OSMO_CONFIGURE_G6_PLATFORM=true scripts/deploy-osmo.sh

# 3) G6 노드를 미리 워밍하여 OSMO 리소스 검증에 노출
GPU_PREWARM_INSTANCE_TYPE=g6.4xlarge \
  KARPENTER_NODEPOOL_NAME=aws-osmo-g6 \
  GPU_PREWARM_NAME=aws-osmo-g6-prewarm \
  scripts/prewarm-gpu-node.sh
```

관련 기본값은 `versions.yaml`에 있습니다: `karpenter_g6_nodepool_name`(기본 `aws-osmo-g6`), `g6_instance_types`(기본 `g6.2xlarge,g6.4xlarge,g6.8xlarge`). AZ는 `KARPENTER_G6_ZONE`(기본 `ap-northeast-2a`)으로 오버라이드할 수 있습니다.

G6 노드에서 검증된 예제 워크플로:

- `examples/cosmos-reason2-nim/workflow-g6.yaml` — Cosmos Reason2 NIM. L4의 24GB에 맞추기 위해 `NIM_MAX_MODEL_LEN`(기본 32768)으로 컨텍스트 길이를 제한합니다. NIM 기본 256K 컨텍스트는 KV 캐시가 약 29GiB 필요해 L4에서 실패하므로, 이 값이 핵심입니다.
- `examples/isaaclab-rsl-rl-video/workflow-g6.yaml` — Isaac Lab RSL-RL 학습(영상 렌더링 비활성).
- `examples/isaaclab-rsl-rl-video/workflow-g6-video.yaml` — 위와 동일하되 영상 렌더링 활성. play.py에 `--enable_cameras`를 추가해 headless 환경에서도 오프스크린 비디오 녹화가 되도록 했습니다.
- `examples/gr00t-finetune/workflow-g6.yaml` — GR00T 파인튜닝(L4에 맞춰 리소스·튜닝 범위 축소).

참고: L4(24GB)는 Cosmos Reason2 같은 추론(VLM) 워크로드에는 충분하지만, Cosmos Predict/Transfer 계열의 diffusion 생성 워크로드에는 부적합합니다(A100/H100/G7e 필요).

## EFA 모드

베이스라인은 AWS EFA 디바이스 플러그인을 설치하여 EFA 지원 G7e 노드가 `vpc.amazonaws.com/efa`를 노출할 수 있게 합니다. 플러그인 설치는 EFA 미지원 클러스터·노드에서도 안전합니다: 업스트림 차트는 지원되는 인스턴스 라벨에서만 DaemonSet을 스케줄하므로, `g7e.2xlarge`·`g7e.4xlarge` 같은 미지원 인스턴스는 EFA 리소스를 등록하지 않습니다.

워크플로가 EFA 또는 NCCL/RDMA 검증을 명시적으로 필요로 할 때 EFA 활성 모드를 사용하세요:

```bash
scripts/deploy-efa-device-plugin.sh
GPU_PREWARM_INSTANCE_TYPE=g7e.12xlarge scripts/prewarm-gpu-node.sh
OSMO_VALIDATE_EFA_DEVICE_PLUGIN=true \
  OSMO_VALIDATE_EFA_NODE=true \
  scripts/validate-platform.sh
```

멀티노드 EFA 검증은 Kubernetes 네이티브 NCCL 벤치마크로 실행합니다:

```bash
KUBE_CONTEXT=<your-context> examples/g7e-efa-nccl-benchmark/run.sh
```

이 NCCL 벤치마크는 전송(transport) 검사입니다. in-place와 out-of-place all-reduce 라인은 입력·출력 버퍼가 같은 메모리를 공유하는지만 다르므로 비슷한 성능이 예상됩니다. EFA 유무에 따른 학습 wall-clock을 비교하려면 DDP 벤치마크를 실행하세요:

```bash
KUBE_CONTEXT=<your-context> examples/g7e-efa-ddp-benchmark/run.sh
```

검증된 DDP 실행은 `g7e.12xlarge` 2노드, 노드당 1 GPU, rank당 256 MiB 그래디언트 페이로드를 사용했습니다. EFA는 NCCL Libfabric/GDRDMA를 사용해 12스텝을 `0.129초`에 완료했고, EFA 미사용 비교(`NCCL_NET=Socket` 강제)는 같은 스텝을 `1.371초`에 완료했습니다.

코어 Terraform 모듈은 EKS 노드 보안 그룹에 자기참조(self-referenced) 전체 트래픽 인그레스·이그레스를 엽니다. EFA/NCCL 트래픽은 일반적인 Kubernetes 파드 TCP 포트를 넘어 노드 간 통신을 요구하기 때문입니다.

일반적인 단일 노드 GPU 예제나 작은 G7e 사이즈에는 EFA 비활성 모드를 사용하세요. 이 모드에서는 `scripts/deploy-efa-device-plugin.sh`를 건너뛰고, 워크플로 파드 리소스에 `vpc.amazonaws.com/efa`를 요청하지 않으며, `OSMO_VALIDATE_EFA_NODE=false`로 둡니다.

작업을 마쳤으면 레퍼런스 환경을 삭제하세요:

```bash
scripts/destroy.sh
```

## 현재 범위

이 레퍼런스는 NVIDIA OSMO를 위한 AWS 통합 계층에 초점을 둡니다. 범용 NVIDIA 로보틱스 플랫폼 배포판이 아니며, NVIDIA 로보틱스·피지컬 AI 워크로드를 위한 재현 가능한 AWS 인프라, EKS GPU 스케줄링, OSMO 배포, 검증된 워크플로 실행을 시연합니다.

현재 베이스라인은 S3 기반 OSMO 워크플로·데이터셋 스토리지와 워크플로별 임시(ephemeral) 태스크 스토리지를 사용합니다.

HTTPS admin UI 접근은 `infra/ingress` 아래에서 선택적으로 제공됩니다. 이 Terraform 루트는 AWS Load Balancer Controller를 설치하고, ACM 인증서를 요청하며, `osmo-ui`를 위한 ALB 기반 Kubernetes Ingress를 만들고, Route 53 레코드를 게시합니다. 명시적인 도메인 이름, 호스티드 존 ID, 그리고 공개(0.0.0.0/0)가 아닌 소스 CIDR 허용 목록이 필요합니다.

도메인 없이 HTTPS 접근이 필요하면 `infra/cloudfront`를 사용하세요. OSMO UI ALB와 Grafana ALB 앞에 CloudFront 배포를 배치하고, 공유 WAF WebACL로 화이트리스트 IP만 허용합니다. CloudFront 기본 인증서(`*.cloudfront.net`)를 사용하므로 커스텀 도메인이나 Route 53 호스티드 존 없이도 브라우저 인증서 경고가 발생하지 않습니다. 배포 후 OSMO 백엔드의 Grafana URL을 CloudFront 엔드포인트로 업데이트하세요:

```bash
GRAFANA_URL=https://<grafana-cloudfront-domain>.cloudfront.net scripts/update-grafana-url.sh
```

AWS 관리형 관측성은 [infra/observability/](infra/observability/README.md)와 [docs/observability.md](docs/observability.md)를 참고하세요. 배포 가능한 경로는 OSMO의 Prometheus·Grafana 관측성 흐름을 Amazon Managed Service for Prometheus와 Amazon Managed Grafana로 매핑합니다.

전체 NVIDIA nut pouring 쿡북은 외부 고정 의존성으로 취급됩니다. GPU 스모크 경로가 성공한 뒤 래퍼를 통해 실행하세요:

```bash
export HF_TOKEN_FILE="$HOME/.huggingface/token"
scripts/run-nut-pouring.sh
```

nut pouring 래퍼는 기본으로 `g7e.24xlarge`를 워밍합니다. 업스트림 GR00T 파인튜닝 워크플로가 `cpu: 64`, `memory: 512Gi`, `gpu: 1`을 요청하기 때문입니다. 래퍼는 업스트림 리소스 요청을 보존하고, AWS G7e OSMO 플랫폼을 추가하며, 6단계 실행이 무인으로 완료될 수 있도록 step 01의 대화형 `sleep infinity` 홀드만 제거하고, 워크플로 완료 시 Karpenter GPU 노드 정리를 검증합니다.

Cosmos 증강 경로를 제한적으로 검증하려면 `NUT_POURING_MAX_DEMOS=1` 등 작은 값을 설정하세요. 전체 업스트림 쿡북 실행을 원하면 설정하지 않고 둡니다.

임시(ad hoc) GPU 정리 확인은 다음을 실행하세요:

```bash
scripts/wait-gpu-node-cleanup.sh
```

## 업스트림 전략

NVIDIA OSMO는 외부에 고정된 채로 유지됩니다. 이 리포는 NVIDIA Terraform과 문서를 참고 자료로만 사용합니다. AWS 특화 구현, 보안 기본값, 배포 스크립트, 검증 기록은 이 리포에 둡니다.

[NVIDIA/OSMO PR #894](https://github.com/NVIDIA/OSMO/pull/894)와 관련된 AWS 호환성 노트는 [docs/osmo-compatibility.md](docs/osmo-compatibility.md)를 참고하세요.

검증 기록은 해당 워크플로나 선택적 인프라 루트 옆에 보관합니다. 예: `examples/<name>/validation.md`, `infra/ingress/README.md`.
