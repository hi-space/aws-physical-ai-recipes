#!/usr/bin/env bash
# =============================================================================
# delete-observability.sh — install-observability.sh 가 만든 리소스 삭제
#
# install-observability.sh 는 CDK 밖에서 리소스를 만들므로 `cdk destroy` 로는 지워지지 않는다.
# AMP 워크스페이스는 비어 있어도 과금되므로 실습이 끝나면 cdk destroy 전에 이것을 먼저 돌린다.
#
# 삭제 순서: Helm 릴리스 → pod identity → 애드온 → AMG 워크스페이스 → AMP 워크스페이스 → IAM 롤.
# 리소스 이름은 설치 스크립트와 같은 규칙(<cluster-name> 접두어)으로 찾는다.
#
# 사용법:
#   ./scripts/eks/delete-observability.sh [--region <region>] [--cluster <eks-cluster-name>] [--yes]
# =============================================================================
set -euo pipefail

ADDON_NAME="amazon-sagemaker-hyperpod-observability"
GRAFANA_NAMESPACE="grafana"

WORKSHOP_REGION="${REGION:-}"
REGION=""
CLUSTER_NAME=""
ASSUME_YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$REGION" ]]; then
  REGION="${WORKSHOP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
fi
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
AMP_ALIAS="$CLUSTER_NAME"
ROLES=("${CLUSTER_NAME}-otel-collector" "${CLUSTER_NAME}-grafana-pod" "${CLUSTER_NAME}-grafana-workspace")

echo "삭제 대상 (${CLUSTER_NAME}, ${REGION}):"
echo "  Helm 릴리스 grafana (네임스페이스 ${GRAFANA_NAMESPACE}) + pod identity"
echo "  EKS 애드온 ${ADDON_NAME}"
echo "  Grafana 워크스페이스 ${CLUSTER_NAME} (AMG 모드로 설치했을 때)"
echo "  AMP 워크스페이스 alias ${AMP_ALIAS} — 메트릭도 함께 사라진다"
echo "  IAM 롤 ${ROLES[*]}"
if [[ "$ASSUME_YES" != true ]]; then
  read -r -p "계속할까요? [y/N] " ANSWER
  [[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]] || { echo "중단"; exit 0; }
fi

# 1) in-cluster Grafana. kubectl 컨텍스트가 없거나 클러스터가 이미 사라졌으면 건너뛴다.
if kubectl get namespace "$GRAFANA_NAMESPACE" >/dev/null 2>&1; then
  helm uninstall grafana -n "$GRAFANA_NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete namespace "$GRAFANA_NAMESPACE" --wait=false >/dev/null 2>&1 || true
  echo "Helm 릴리스 grafana + 네임스페이스 삭제"
fi

# 2) pod identity — Grafana 쪽만 스크립트가 직접 만들었다. OTel collector 쪽은 애드온이 소유하므로
#    애드온 삭제 시 함께 사라진다.
PIA_ID="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
  --namespace "$GRAFANA_NAMESPACE" --service-account grafana \
  --query "associations[0].associationId" --output text 2>/dev/null || true)"
if [[ -n "$PIA_ID" && "$PIA_ID" != "None" ]]; then
  aws eks delete-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --association-id "$PIA_ID" >/dev/null
  echo "pod identity 삭제: ${PIA_ID}"
fi

# 3) 애드온
if aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws eks delete-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" >/dev/null
  echo "애드온 삭제 요청: ${ADDON_NAME}"
  for _ in $(seq 1 60); do
    aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name "$ADDON_NAME" --region "$REGION" >/dev/null 2>&1 || break
    sleep 10
  done
fi

# 4) AMG 워크스페이스
GRAFANA_WS_ID="$(aws grafana list-workspaces --region "$REGION" \
  --query "workspaces[?name=='${CLUSTER_NAME}'].id | [0]" --output text 2>/dev/null || true)"
if [[ -n "$GRAFANA_WS_ID" && "$GRAFANA_WS_ID" != "None" ]]; then
  aws grafana delete-workspace --workspace-id "$GRAFANA_WS_ID" --region "$REGION" >/dev/null
  echo "Grafana 워크스페이스 삭제: ${GRAFANA_WS_ID}"
fi

# 5) AMP 워크스페이스
AMP_IDS="$(aws amp list-workspaces --region "$REGION" --alias "$AMP_ALIAS" \
  --query "workspaces[].workspaceId" --output text 2>/dev/null || true)"
for ID in $AMP_IDS; do
  aws amp delete-workspace --region "$REGION" --workspace-id "$ID" >/dev/null
  echo "AMP 워크스페이스 삭제: ${ID}"
done

# 6) IAM 롤 — 붙은 관리형 정책을 먼저 떼어내야 삭제된다.
for ROLE in "${ROLES[@]}"; do
  aws iam get-role --role-name "$ROLE" >/dev/null 2>&1 || continue
  for ARN in $(aws iam list-attached-role-policies --role-name "$ROLE" --query "AttachedPolicies[].PolicyArn" --output text); do
    aws iam detach-role-policy --role-name "$ROLE" --policy-arn "$ARN" >/dev/null
  done
  aws iam delete-role --role-name "$ROLE" >/dev/null
  echo "IAM 롤 삭제: ${ROLE}"
done

echo ""
echo "완료. AMP 워크스페이스 삭제는 비동기이므로 몇 분 뒤 확인:"
echo "  aws amp list-workspaces --region ${REGION} --alias ${AMP_ALIAS}"
