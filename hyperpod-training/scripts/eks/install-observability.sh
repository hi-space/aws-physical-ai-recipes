#!/usr/bin/env bash
# =============================================================================
# install-observability.sh — HyperPod 관측(observability) 추가 설치 (모듈 8, 모듈 11)
#
#   AMP 워크스페이스                                  : 메트릭 저장소
#   amazon-sagemaker-hyperpod-observability 애드온     : node/DCGM/kube-state/EFA exporter + OTel collector
#   Grafana                                           : 클러스터 안 Helm(기본) 또는 Amazon Managed Grafana
#
# CDK 스택(HyperPodEks-<ACCOUNT_ID>)에서 분리해 CLI 로 설치한다. 이 애드온은 리전마다 제공 여부가
# 다르고(2026-10-16 기준 ap-northeast-2 에 없음), 미지원 리전에서 CreateAddon 이 400 을 내면 CloudFormation
# 이 스택 전체를 롤백해 VPC·FSx·HyperPod 클러스터까지 함께 되돌린다. 추가 설치로 떼어 두면 관측 설치가
# 실패해도 클러스터는 그대로 남는다. task governance 애드온은 모든 리전에 있어 CDK 가 계속 만든다.
#
# 사용법:
#   ./scripts/eks/install-observability.sh [--region <region>] [--cluster <eks-cluster-name>]
#                                          [--grafana self-hosted|amg|none]
#
# 전제: CDK 스택 배포 완료(상시 시스템 노드 1대 이상), kubectl/helm, ./scripts/eks/kubeconfig.sh 실행.
# 삭제: ./scripts/eks/delete-observability.sh (CDK 가 수명주기를 모르므로 cdk destroy 로는 지워지지 않는다)
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EKS_DIR="${HERE}/../../eks"
ADDON_NAME="amazon-sagemaker-hyperpod-observability"
# Grafana 는 서브패스 /absproxy/3000/ 에서 서비스한다 (eks/grafana-values.yaml 주석 참고).
GRAFANA_NAMESPACE="grafana"
GRAFANA_PORT=3000
GRAFANA_SUB_PATH="/absproxy/${GRAFANA_PORT}/"
GRAFANA_CHART_VERSION="10.5.15"   # https://grafana.github.io/helm-charts — Grafana 12.3
DASHBOARD_CONFIGMAP="hyperpod-dashboards"
# CDK 의 cpu-c5-4x 상시 시스템 그룹(infra/lib/hyperpod-eks-stack.ts SYSTEM_GROUP_NAME).
SYSTEM_INSTANCE_TYPE="ml.c5.4xlarge"

WORKSHOP_REGION="${REGION:-}"
REGION=""
CLUSTER_NAME=""
GRAFANA_MODE="self-hosted"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --grafana) GRAFANA_MODE="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done
case "$GRAFANA_MODE" in
  self-hosted|amg|none) ;;
  *) echo "--grafana 는 self-hosted | amg | none 중 하나여야 합니다: '${GRAFANA_MODE}'" >&2; exit 1 ;;
esac
if [[ -z "$REGION" ]]; then
  REGION="${WORKSHOP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
fi
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
AMP_ALIAS="$CLUSTER_NAME"
OTEL_ROLE="${CLUSTER_NAME}-otel-collector"
GRAFANA_POD_ROLE="${CLUSTER_NAME}-grafana-pod"
GRAFANA_WS_ROLE="${CLUSTER_NAME}-grafana-workspace"

command -v kubectl >/dev/null || { echo "kubectl 이 없습니다. https://kubernetes.io/docs/tasks/tools/ 참고" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq 가 없습니다 (dnf install jq)" >&2; exit 1; }
if [[ "$GRAFANA_MODE" == "self-hosted" ]]; then
  command -v helm >/dev/null || { echo "helm 이 없습니다. https://helm.sh/docs/intro/install/ 참고" >&2; exit 1; }
  command -v envsubst >/dev/null || { echo "envsubst 가 없습니다 (dnf install gettext)" >&2; exit 1; }
fi
aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 \
  || { echo "EKS 클러스터 ${CLUSTER_NAME} 을 ${REGION} 에서 찾지 못했습니다. 먼저 CDK 스택을 배포하세요." >&2; exit 1; }

# 0) 리전 지원 확인. 결과가 비어 있으면 애드온이 그 리전에 아직 없다. 미지원 리전에서 설치를 시도하면
#    CreateAddon 이 "Addon ... is not supported in <k8s version>" 으로 거부하는데, 문구는 Kubernetes
#    버전을 가리키지만 실제 원인은 리전이라 eksVersion 을 낮춰도 똑같이 실패한다.
VERSIONS="$(aws eks describe-addon-versions --addon-name "$ADDON_NAME" --region "$REGION" \
  --query "addons[0].addonVersions[].addonVersion" --output text 2>/dev/null || true)"
if [[ -z "$VERSIONS" || "$VERSIONS" == "None" ]]; then
  cat >&2 <<EOF
${ADDON_NAME} 애드온은 ${REGION} 에 아직 없습니다.

HyperPod 관측 대시보드는 지원 리전(2026-10-16 실측: us-east-1, us-east-2, us-west-2, eu-west-1,
eu-central-1, ap-northeast-1, ap-southeast-1, ap-southeast-2, ap-south-1)에 배포한 클러스터에서만
설치할 수 있습니다. ${REGION} 에서는 대신 아래를 쓰세요.

  ./scripts/eks/install-dashboard-public.sh

AMP 와 애드온 대신 클러스터 안 kube-prometheus-stack + DCGM exporter(eks/dcgm-exporter.yaml)로 같은
Grafana 대시보드를 띄웁니다. GPU·노드·Kueue 패널이 모두 채워지므로 이 스크립트의 대체 경로입니다.

task governance(Kueue) 실습은 영향이 없습니다 — 해당 애드온은 모든 리전에 있고 CDK 가 이미 설치합니다.
EOF
  exit 1
fi
echo "클러스터: ${CLUSTER_NAME} (${REGION}), Grafana: ${GRAFANA_MODE}"

# 애드온 파드는 4xlarge 이상 HyperPod 노드가 1대 이상 있어야 스케줄된다.
NODES="$(kubectl get nodes --no-headers 2>/dev/null | wc -l)"
[[ "$NODES" -gt 0 ]] || { echo "노드가 0대입니다. 상시 시스템 그룹(cpu-c5-4x)이 Running 인지 확인하세요." >&2; exit 1; }

# 1) AMP 워크스페이스 — alias 는 유일하지 않으므로 같은 alias 가 있으면 재사용한다.
AMP_ID="$(aws amp list-workspaces --region "$REGION" --alias "$AMP_ALIAS" \
  --query "workspaces[?status.statusCode=='ACTIVE'].workspaceId | [0]" --output text 2>/dev/null || true)"
if [[ -n "$AMP_ID" && "$AMP_ID" != "None" ]]; then
  echo "AMP 워크스페이스 이미 존재: ${AMP_ID} (건너뜀)"
else
  AMP_ID="$(aws amp create-workspace --region "$REGION" --alias "$AMP_ALIAS" \
    --tags "Name=${CLUSTER_NAME}-AMP,ManagedBy=install-observability.sh" \
    --query workspaceId --output text)"
  echo "AMP 워크스페이스 생성: ${AMP_ID}"
  for _ in $(seq 1 60); do
    ST="$(aws amp describe-workspace --region "$REGION" --workspace-id "$AMP_ID" --query workspace.status.statusCode --output text)"
    [[ "$ST" == "ACTIVE" ]] && break
    sleep 5
  done
fi
AMP_ARN="$(aws amp describe-workspace --region "$REGION" --workspace-id "$AMP_ID" --query workspace.arn --output text)"
AMP_ENDPOINT="$(aws amp describe-workspace --region "$REGION" --workspace-id "$AMP_ID" --query workspace.prometheusEndpoint --output text)"

# 2) IAM 롤. pod identity 는 pods.eks.amazonaws.com 이 sts:AssumeRole + sts:TagSession 을 할 수 있어야 한다.
POD_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"pods.eks.amazonaws.com"},"Action":["sts:AssumeRole","sts:TagSession"]}]}'
ensure_role() { # <role-name> <trust-policy-json> <managed-policy-arn>...
  local name="$1" trust="$2"; shift 2
  if aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    echo "  IAM 롤 이미 존재: ${name}"
  else
    aws iam create-role --role-name "$name" --assume-role-policy-document "$trust" \
      --description "HyperPod observability (install-observability.sh)" >/dev/null
    echo "  IAM 롤 생성: ${name}"
  fi
  local arn
  for arn in "$@"; do
    aws iam attach-role-policy --role-name "$name" --policy-arn "$arn" >/dev/null
  done
}

echo "IAM 롤:"
ensure_role "$OTEL_ROLE" "$POD_TRUST" \
  arn:aws:iam::aws:policy/AmazonPrometheusRemoteWriteAccess \
  arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
OTEL_ROLE_ARN="$(aws iam get-role --role-name "$OTEL_ROLE" --query Role.Arn --output text)"

# 3) Grafana — 애드온 설정에 AMG 워크스페이스 ARN 을 넘기려면 애드온보다 먼저 만들어야 한다.
GRAFANA_WS_ID=""
GRAFANA_URL=""
if [[ "$GRAFANA_MODE" == "amg" ]]; then
  # AMG 는 IAM Identity Center **조직** 인스턴스가 있는 계정에서만 만들어진다
  # (계정 인스턴스는 "SSO is not enabled in any region" 으로 거부된다).
  ensure_role "$GRAFANA_WS_ROLE" \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"grafana.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess \
    arn:aws:iam::aws:policy/service-role/AmazonGrafanaCloudWatchAccess
  GRAFANA_WS_ROLE_ARN="$(aws iam get-role --role-name "$GRAFANA_WS_ROLE" --query Role.Arn --output text)"
  GRAFANA_WS_ID="$(aws grafana list-workspaces --region "$REGION" \
    --query "workspaces[?name=='${CLUSTER_NAME}'].id | [0]" --output text 2>/dev/null || true)"
  if [[ -n "$GRAFANA_WS_ID" && "$GRAFANA_WS_ID" != "None" ]]; then
    echo "Grafana 워크스페이스 이미 존재: ${GRAFANA_WS_ID} (건너뜀)"
  else
    GRAFANA_WS_ID="$(aws grafana create-workspace --region "$REGION" \
      --workspace-name "$CLUSTER_NAME" \
      --workspace-description "HyperPod EKS observability dashboards" \
      --account-access-type CURRENT_ACCOUNT \
      --authentication-providers AWS_SSO \
      --permission-type CUSTOMER_MANAGED \
      --workspace-role-arn "$GRAFANA_WS_ROLE_ARN" \
      --workspace-data-sources PROMETHEUS CLOUDWATCH \
      --query workspace.id --output text)"
    echo "Grafana 워크스페이스 생성: ${GRAFANA_WS_ID}"
  fi
  GRAFANA_URL="https://$(aws grafana describe-workspace --region "$REGION" --workspace-id "$GRAFANA_WS_ID" \
    --query workspace.endpoint --output text)"
fi

# 4) 애드온 — 메트릭을 AMP 로 remote-write 하고 로그를 CloudWatch 로 보낸다. 콘솔의 "Quick install"
#    이 하는 일과 같다. podIdentityAssociations 로 OTel collector SA 에 위 롤을 붙인다.
CONFIG="$(jq -nc --arg arn "$AMP_ARN" --arg ep "$AMP_ENDPOINT" '
  {ampWorkspace: {arn: $arn, prometheusEndpoint: $ep},
   metricsProvider: {clusterMetrics: {level: "ADVANCED"}, nodeMetrics: {level: "ADVANCED"},
                     acceleratedComputeMetrics: {level: "ADVANCED"}, networkMetrics: {level: "BASIC"},
                     taskGovernanceMetrics: {level: "ADVANCED"}, trainingMetrics: {level: "ADVANCED"},
                     logging: {enabled: true}}}')"
if [[ -n "$GRAFANA_WS_ID" && "$GRAFANA_WS_ID" != "None" ]]; then
  CONFIG="$(jq -c --arg arn "arn:aws:grafana:${REGION}:${ACCOUNT_ID}:/workspaces/${GRAFANA_WS_ID}" \
    '.amgWorkspace = {arn: $arn}' <<<"$CONFIG")"
fi
PIA="$(jq -nc --arg arn "$OTEL_ROLE_ARN" \
  '[{roleArn: $arn, serviceAccount: "hyperpod-observability-operator-otel-collector"}]')"

if aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "애드온 ${ADDON_NAME} 업데이트"
  aws eks update-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" \
    --resolve-conflicts OVERWRITE --configuration-values "$CONFIG" --pod-identity-associations "$PIA" >/dev/null
else
  echo "애드온 ${ADDON_NAME} 설치"
  aws eks create-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" \
    --resolve-conflicts OVERWRITE --configuration-values "$CONFIG" --pod-identity-associations "$PIA" >/dev/null
fi
for _ in $(seq 1 60); do
  ST="$(aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" \
    --query addon.status --output text)"
  case "$ST" in
    ACTIVE) echo "  애드온 ACTIVE"; break ;;
    CREATE_FAILED|UPDATE_FAILED|DEGRADED)
      echo "  애드온 상태 ${ST}:" >&2
      aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" \
        --query 'addon.health.issues' --output json >&2
      exit 1 ;;
  esac
  sleep 10
done

# 5) in-cluster Grafana — AMP 를 SigV4 로 읽는 데이터소스 + 커뮤니티 대시보드(DCGM, Node Exporter,
#    Kubernetes Views) + 워크숍 전용 task governance 대시보드(eks/grafana-dashboards).
if [[ "$GRAFANA_MODE" == "self-hosted" ]]; then
  echo "in-cluster Grafana (Helm ${GRAFANA_CHART_VERSION}):"
  ensure_role "$GRAFANA_POD_ROLE" "$POD_TRUST" arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess
  GRAFANA_POD_ROLE_ARN="$(aws iam get-role --role-name "$GRAFANA_POD_ROLE" --query Role.Arn --output text)"

  kubectl create namespace "$GRAFANA_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  EXISTING_PIA="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --namespace "$GRAFANA_NAMESPACE" --service-account grafana \
    --query "associations[0].associationId" --output text 2>/dev/null || true)"
  if [[ -n "$EXISTING_PIA" && "$EXISTING_PIA" != "None" ]]; then
    echo "  pod identity 이미 존재: ${EXISTING_PIA}"
  else
    aws eks create-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
      --namespace "$GRAFANA_NAMESPACE" --service-account grafana --role-arn "$GRAFANA_POD_ROLE_ARN" >/dev/null
    echo "  pod identity 생성: ${GRAFANA_NAMESPACE}/grafana → ${GRAFANA_POD_ROLE}"
  fi

  # 대시보드 JSON 은 values 에 인라인하지 않고 ConfigMap 으로 넣는다 (values 로 넘기면 JSON 안의
  # Go 템플릿 문자 {{ }} 가 Helm 에서 렌더링된다).
  kubectl create configmap "$DASHBOARD_CONFIGMAP" -n "$GRAFANA_NAMESPACE" \
    --from-file="${EKS_DIR}/grafana-dashboards" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update grafana >/dev/null
  export AMP_ENDPOINT REGION SYSTEM_INSTANCE_TYPE DASHBOARD_CONFIGMAP
  envsubst '${AMP_ENDPOINT} ${REGION} ${SYSTEM_INSTANCE_TYPE} ${DASHBOARD_CONFIGMAP}' \
    < "${EKS_DIR}/grafana-values.yaml" \
    | helm upgrade --install grafana grafana/grafana \
        --version "$GRAFANA_CHART_VERSION" \
        --namespace "$GRAFANA_NAMESPACE" \
        --values - --wait --timeout 10m >/dev/null
  echo "  Helm 릴리스 grafana 배포 완료"
fi

echo ""
echo "== 관측 설치 완료 =="
echo "AMP 워크스페이스 : ${AMP_ID}"
echo "AMP 엔드포인트   : ${AMP_ENDPOINT}"
case "$GRAFANA_MODE" in
  self-hosted)
    echo "Grafana 접속:"
    echo "  kubectl port-forward -n ${GRAFANA_NAMESPACE} svc/grafana ${GRAFANA_PORT}:80"
    echo "  → https://<CodeServerUrl>${GRAFANA_SUB_PATH} (로컬이면 http://localhost:${GRAFANA_PORT}${GRAFANA_SUB_PATH})"
    echo "  user admin, password:"
    echo "  kubectl get secret -n ${GRAFANA_NAMESPACE} grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo"
    ;;
  amg)
    echo "Grafana 워크스페이스: ${GRAFANA_WS_ID}"
    echo "  ./scripts/eks/grafana-user.sh <IdC-username> --region ${REGION}   # 사용자 할당 후"
    echo "  ${GRAFANA_URL}"
    ;;
  none) echo "Grafana 없음 (AMP 만). 나중에 --grafana self-hosted 로 다시 실행하면 추가된다" ;;
esac
echo ""
echo "메트릭이 차기까지 2~3분 걸린다. 확인: kubectl get pods -n aws-hyperpod"
