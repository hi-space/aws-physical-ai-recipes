#!/usr/bin/env bash
# =============================================================================
# delete-dashboard-public.sh — install-dashboard-public.sh 가 만든 리소스 삭제
#
# 전부 CDK 밖에서 만든 것이라 `cdk destroy` 로는 지워지지 않는다. ALB 와 WAF 는
# 상시 과금되므로 대시보드를 더 안 볼 거면 바로 돌린다.
#
# 삭제 순서: CloudFront(비활성화 → 전파 대기 → 삭제) → WAF Web ACL → Ingress(ALB)
#            → Grafana / kube-prometheus-stack Helm 릴리스 → ClusterRoleBinding /
#            ServiceMonitor → LB 컨트롤러 릴리스 → pod identity → IAM 롤/정책.
# CloudFront 를 먼저 지워야 WAF Web ACL 의 참조가 풀린다. ALB 는 CloudFront 오리진이라
# 그 뒤에 지운다. 전체 15~25분 걸리고 대부분이 CloudFront 전파 대기다.
#
# 이름이 '<cluster-name>-dashboard' 인 것만 건드린다. 계정에 원래 있던 WAF ACL 이나
# Grafana 워크스페이스는 손대지 않는다.
#
# install-mlflow-selfhosted.sh 를 돌렸다면 그쪽을 먼저 지워야 한다. MLflow /
# TensorBoard Ingress 가 같은 IngressGroup 에 남아 있으면 Grafana Ingress 를 지워도
# ALB 가 그대로 유지된다(= 계속 과금). 이 스크립트가 시작할 때 확인하고 안내한다.
#
# 사용법:
#   ./scripts/eks/delete-dashboard-public.sh [--cluster <eks-cluster-name>] [--yes]
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
WAF_REGION="us-east-1"
MONITORING_NAMESPACE="monitoring"
INGRESS_NAME="grafana"
INGRESS_GROUP="hyperpod-dashboard"

CLUSTER_NAME=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"

LBC_ROLE="${CLUSTER_NAME}-alb-controller"
LBC_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${CLUSTER_NAME}-alb-controller"
WAF_ACL_NAME="${CLUSTER_NAME}-dashboard"
CF_CALLER_REF="${CLUSTER_NAME}-dashboard"

cat <<EOF

삭제 대상 (${CLUSTER_NAME}, ${REGION}):
  CloudFront 배포 Comment=${CF_CALLER_REF}
  WAF Web ACL ${WAF_ACL_NAME} (${WAF_REGION})
  Ingress ${MONITORING_NAMESPACE}/${INGRESS_NAME} → ALB
  Helm 릴리스 grafana, kps (네임스페이스 ${MONITORING_NAMESPACE}) — 메트릭도 사라진다
  Helm 릴리스 aws-load-balancer-controller (kube-system)
  pod identity kube-system/aws-load-balancer-controller
  IAM 롤/정책 ${LBC_ROLE}

EOF

# 같은 IngressGroup 에 다른 Ingress 가 남아 있으면 ALB 가 살아남는다.
LEFTOVER="$(kubectl get ingress -A \
  -o jsonpath="{range .items[?(@.metadata.annotations['alb\.ingress\.kubernetes\.io/group\.name']=='${INGRESS_GROUP}')]}{.metadata.namespace}/{.metadata.name}{'\n'}{end}" \
  2>/dev/null | grep -v "^${MONITORING_NAMESPACE}/${INGRESS_NAME}\$" | grep . || true)"
if [[ -n "$LEFTOVER" ]]; then
  echo "경고: IngressGroup ${INGRESS_GROUP} 에 다른 Ingress 가 남아 있습니다:"
  sed 's/^/  /' <<<"$LEFTOVER"
  echo "  이것들을 먼저 지우지 않으면 ALB 가 유지되어 계속 과금됩니다."
  echo "  MLflow / TensorBoard 라면: ./scripts/eks/delete-mlflow-selfhosted.sh"
  echo "  Argo Workflows 라면:      ./scripts/eks/delete-job-portal.sh"
  echo ""
fi

if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "계속할까요? [y/N] " ANSWER
  [[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]] || { echo "중단"; exit 0; }
fi

# -----------------------------------------------------------------------------
# 1. CloudFront — 비활성화 후 Deployed 가 될 때까지 기다려야 삭제가 받아들여진다.
#    ETag 가 매 호출마다 바뀌므로 그때그때 다시 읽는다.
# -----------------------------------------------------------------------------
CF_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CF_CALLER_REF}'].Id | [0]" --output text 2>/dev/null || true)"
if [[ -n "$CF_ID" && "$CF_ID" != "None" ]]; then
  ETAG="$(aws cloudfront get-distribution-config --id "$CF_ID" --query ETag --output text)"
  ENABLED="$(aws cloudfront get-distribution-config --id "$CF_ID" --query 'DistributionConfig.Enabled' --output text)"
  if [[ "$ENABLED" == "True" ]]; then
    aws cloudfront get-distribution-config --id "$CF_ID" \
      --query 'DistributionConfig' --output json | jq '.Enabled = false' > /tmp/cf-disable.json
    aws cloudfront update-distribution --id "$CF_ID" --if-match "$ETAG" \
      --distribution-config file:///tmp/cf-disable.json >/dev/null
    rm -f /tmp/cf-disable.json
    echo "CloudFront ${CF_ID} 비활성화 — 전파 대기 (최대 20분)"
  fi
  for _ in $(seq 1 120); do
    STATUS="$(aws cloudfront get-distribution --id "$CF_ID" --query 'Distribution.Status' --output text)"
    [[ "$STATUS" == "Deployed" ]] && break
    sleep 10
  done
  ETAG="$(aws cloudfront get-distribution-config --id "$CF_ID" --query ETag --output text)"
  aws cloudfront delete-distribution --id "$CF_ID" --if-match "$ETAG" >/dev/null
  echo "CloudFront 배포 삭제: ${CF_ID}"
fi

# -----------------------------------------------------------------------------
# 2. WAF Web ACL — LockToken 이 필요하고, CloudFront 연결이 남아 있으면 거부된다.
# -----------------------------------------------------------------------------
WAF_ID="$(aws wafv2 list-web-acls --scope CLOUDFRONT --region "$WAF_REGION" \
  --query "WebACLs[?Name=='${WAF_ACL_NAME}'].Id | [0]" --output text 2>/dev/null || true)"
if [[ -n "$WAF_ID" && "$WAF_ID" != "None" ]]; then
  LOCK="$(aws wafv2 get-web-acl --scope CLOUDFRONT --region "$WAF_REGION" \
    --name "$WAF_ACL_NAME" --id "$WAF_ID" --query LockToken --output text)"
  aws wafv2 delete-web-acl --scope CLOUDFRONT --region "$WAF_REGION" \
    --name "$WAF_ACL_NAME" --id "$WAF_ID" --lock-token "$LOCK" >/dev/null
  echo "WAF Web ACL 삭제: ${WAF_ACL_NAME}"
fi

# -----------------------------------------------------------------------------
# 3~6. 클러스터 안. kubectl 컨텍스트가 없거나 클러스터가 이미 사라졌으면 건너뛴다.
# -----------------------------------------------------------------------------
if kubectl get namespace "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  # Ingress 를 지우면 컨트롤러가 ALB 와 관리형 보안그룹을 정리한다.
  if kubectl get ingress "$INGRESS_NAME" -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
    kubectl delete ingress "$INGRESS_NAME" -n "$MONITORING_NAMESPACE" >/dev/null
    echo "Ingress 삭제 — ALB 정리 대기"
    sleep 30
  fi

  helm uninstall grafana -n "$MONITORING_NAMESPACE" >/dev/null 2>&1 || true
  helm uninstall kps -n "$MONITORING_NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete servicemonitor kueue-controller-manager -n "$MONITORING_NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete configmap hyperpod-dashboards -n "$MONITORING_NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete namespace "$MONITORING_NAMESPACE" --wait=false >/dev/null 2>&1 || true
  echo "Helm 릴리스 grafana / kps + 네임스페이스 삭제"
fi
kubectl delete clusterrolebinding kps-kueue-metrics-reader >/dev/null 2>&1 || true

# DCGM exporter(install-dashboard-public.sh 3단계). 네임스페이스를 지우면 안에 든
# DaemonSet / Service / ServiceMonitor 가 함께 사라지므로 매니페스트 경로가 필요 없다.
if kubectl get namespace gpu-operator >/dev/null 2>&1; then
  kubectl delete namespace gpu-operator --wait=false >/dev/null 2>&1 || true
  echo "DCGM exporter 삭제 (네임스페이스 gpu-operator)"
fi

# kube-prometheus-stack 은 CRD 를 남긴다. 다른 모니터링 스택이 쓸 수 있으므로 지우지 않는다.

helm uninstall aws-load-balancer-controller -n kube-system >/dev/null 2>&1 || true
echo "Helm 릴리스 aws-load-balancer-controller 삭제"

PIA_ID="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
  --namespace kube-system --service-account aws-load-balancer-controller \
  --query "associations[0].associationId" --output text 2>/dev/null || true)"
if [[ -n "$PIA_ID" && "$PIA_ID" != "None" ]]; then
  aws eks delete-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --association-id "$PIA_ID" >/dev/null
  echo "pod identity 삭제: ${PIA_ID}"
fi

# IAM 롤은 붙은 정책을 먼저 떼어내야 삭제된다.
if aws iam get-role --role-name "$LBC_ROLE" >/dev/null 2>&1; then
  for ARN in $(aws iam list-attached-role-policies --role-name "$LBC_ROLE" \
                 --query "AttachedPolicies[].PolicyArn" --output text); do
    aws iam detach-role-policy --role-name "$LBC_ROLE" --policy-arn "$ARN" >/dev/null
  done
  aws iam delete-role --role-name "$LBC_ROLE" >/dev/null
  echo "IAM 롤 삭제: ${LBC_ROLE}"
fi
if aws iam get-policy --policy-arn "$LBC_POLICY_ARN" >/dev/null 2>&1; then
  aws iam delete-policy --policy-arn "$LBC_POLICY_ARN" >/dev/null 2>&1 \
    && echo "IAM 정책 삭제: ${LBC_POLICY_ARN}" \
    || echo "IAM 정책 ${LBC_POLICY_ARN} 은 다른 곳에서 참조 중이라 남겨둡니다."
fi

echo ""
echo "완료. kube-prometheus-stack CRD 는 남겨둡니다. 필요하면 수동으로:"
echo "  kubectl get crd | grep monitoring.coreos.com"
