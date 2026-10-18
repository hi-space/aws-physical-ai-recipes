#!/usr/bin/env bash
# =============================================================================
# delete-dashboard-hardening.sh — install-dashboard-hardening.sh 가 더한 것만 되돌린다.
#
#   되돌리는 것
#     1. Grafana 알림 규칙·연락 지점 프로비저닝 해제 (alerting 값 제거)
#     2. Grafana PVC 해제 → emptyDir 로 복귀, deploymentStrategy 도 원래대로
#     3. Prometheus PVC 해제 → emptyDir, retention 6h 로 복귀
#     4. pod identity 연결 + IAM 역할 <cluster>-grafana-alerts 삭제
#     5. SNS 토픽 <cluster>-alerts 삭제 (구독도 함께 사라진다)
#     6. 풀린 PVC 2개 삭제 (EBS 볼륨 과금을 끊기 위해)
#
#   건드리지 않는 것
#     Grafana·Prometheus 릴리스 자체     → delete-dashboard-public.sh
#     MLflow 데이터소스·홈 대시보드      → delete-unified-dashboard.sh
#     대시보드 ConfigMap                 → delete-dashboard-public.sh
#
#   PVC 를 지우므로 쌓인 지표는 사라진다. 대시보드와 데이터소스는 그대로 열리고,
#   install-dashboard-public.sh 가 둔 6h retention 상태로 돌아간다.
#
# 사용법:
#   ./scripts/eks/delete-dashboard-hardening.sh [--cluster <eks-cluster-name>] [--yes]
#                                               [--keep-pvc]
#
#   --keep-pvc  PVC 를 남긴다. 다시 install 할 때 지표를 이어 쓰고 싶을 때만.
#               (gp3 60Gi 과금은 계속된다)
#
# 멱등하다. 이미 지워진 상태에서 다시 돌려도 아무것도 하지 않는다.
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
MONITORING_NAMESPACE="monitoring"
KPS_CHART_VERSION="92.10.1"            # install-dashboard-public.sh 와 같아야 한다
GRAFANA_CHART_VERSION="10.5.15"        # install-dashboard-public.sh 와 같아야 한다
BASE_RETENTION="6h"                    # install-dashboard-public.sh 가 두는 값

CLUSTER_NAME=""
ASSUME_YES="false"
KEEP_PVC="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --keep-pvc) KEEP_PVC="true"; shift ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

for tool in kubectl helm jq aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"

ALERT_TOPIC_NAME="${CLUSTER_NAME}-alerts"
GRAFANA_ALERT_ROLE="${CLUSTER_NAME}-grafana-alerts"

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION})
삭제       : Grafana 알림 규칙 4개 + SNS 연락 지점
             Prometheus·Grafana PVC 해제 → emptyDir, retention ${BASE_RETENTION}
             pod identity 연결 + IAM 역할 ${GRAFANA_ALERT_ROLE}
             SNS 토픽 ${ALERT_TOPIC_NAME} (구독 포함)
$(if [[ "$KEEP_PVC" == "true" ]]; then
    echo "             PVC 는 유지합니다 (--keep-pvc). gp3 과금이 계속됩니다."
  else
    echo "             풀린 PVC 2개 삭제 → 쌓인 지표가 사라집니다."
  fi)
유지       : Grafana·Prometheus 릴리스, 대시보드, MLflow 데이터소스

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

# -----------------------------------------------------------------------------
# 1. Grafana — alerting 값 + PVC 해제
#    alerting 을 먼저 빼야 다음 단계에서 역할과 토픽을 지울 때 Grafana 가 없는
#    토픽으로 알림을 쏘지 않는다. install 과 마찬가지로 helm get values 를 jq 로
#    손대야 install-dashboard-public.sh·install-unified-dashboard.sh 가 넣은
#    설정(데이터소스, dashboardProviders, 홈 대시보드)이 살아남는다.
#    persistence 를 지우면 차트 기본값인 emptyDir 로 돌아간다.
# -----------------------------------------------------------------------------
echo "[1/5] Grafana 알림 + PVC 해제"
GF_PVC_WAS=""
if helm status grafana -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  GF_PVC_WAS="$(kubectl get pvc grafana -n "$MONITORING_NAMESPACE" \
    -o jsonpath='{.metadata.name}' 2>/dev/null || true)"

  VALUES="$(mktemp)"
  trap 'rm -f "$VALUES" "${VALUES}.new"' EXIT
  chmod 600 "$VALUES"
  helm get values grafana -n "$MONITORING_NAMESPACE" -o json > "$VALUES"

  NEEDS_WORK="$(jq -r 'if (.alerting? // null) != null or (.persistence? // null) != null
                       then "yes" else "no" end' "$VALUES")"
  if [[ "$NEEDS_WORK" == "no" ]]; then
    echo "  이미 해제된 상태입니다. helm upgrade 를 건너뜁니다."
  else
    jq '
      del(.alerting)
      | del(.persistence)
      | del(.deploymentStrategy)
      | (if (.env? // null) != null then del(.env.AWS_REGION) else . end)
      | (if (.env? // null) == {} then del(.env) else . end)
    ' "$VALUES" > "${VALUES}.new"
    mv "${VALUES}.new" "$VALUES"

    helm upgrade grafana grafana/grafana \
      --version "$GRAFANA_CHART_VERSION" \
      --namespace "$MONITORING_NAMESPACE" \
      -f "$VALUES" \
      --wait --timeout 10m >/dev/null
    echo "  알림 프로비저닝 제거 + emptyDir 복귀"
  fi
  rm -f "$VALUES"
  trap - EXIT
else
  echo "  Grafana 릴리스가 없습니다. 건너뜁니다."
fi

# -----------------------------------------------------------------------------
# 2. Prometheus — PVC 해제 + retention 복귀
#    storageSpec 을 빼면 오퍼레이터가 StatefulSet 을 emptyDir 로 다시 만든다.
#    PVC 는 StatefulSet 이 사라져도 남으므로 뒤에서 따로 지운다.
# -----------------------------------------------------------------------------
echo "[2/5] Prometheus PVC 해제 + retention ${BASE_RETENTION}"
PROM_PVC_WAS=""
if helm status kps -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  PROM_PVC_WAS="$(kubectl get pvc -n "$MONITORING_NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
    | grep '^prometheus-kps-' || true)"

  KPS_VALUES="$(mktemp)"
  trap 'rm -f "$KPS_VALUES" "${KPS_VALUES}.new"' EXIT
  chmod 600 "$KPS_VALUES"
  helm get values kps -n "$MONITORING_NAMESPACE" -o json > "$KPS_VALUES"

  HAS_STORAGE="$(jq -r 'if (.prometheus.prometheusSpec.storageSpec? // null) != null
                        then "yes" else "no" end' "$KPS_VALUES")"
  if [[ "$HAS_STORAGE" == "no" ]]; then
    echo "  이미 해제된 상태입니다. helm upgrade 를 건너뜁니다."
  else
    jq --arg ret "$BASE_RETENTION" '
      del(.prometheus.prometheusSpec.storageSpec)
      | .prometheus.prometheusSpec.retention = $ret
    ' "$KPS_VALUES" > "${KPS_VALUES}.new"
    mv "${KPS_VALUES}.new" "$KPS_VALUES"

    helm upgrade kps prometheus-community/kube-prometheus-stack \
      --version "$KPS_CHART_VERSION" \
      --namespace "$MONITORING_NAMESPACE" \
      -f "$KPS_VALUES" \
      --wait --timeout 15m >/dev/null
    echo "  emptyDir 복귀"
  fi
  rm -f "$KPS_VALUES"
  trap - EXIT
else
  echo "  kube-prometheus-stack 릴리스가 없습니다. 건너뜁니다."
fi

# -----------------------------------------------------------------------------
# 3. pod identity + IAM 역할
#    역할을 지우기 전에 인라인 정책을 떼야 한다. DeleteRole 은 정책이 붙어 있으면
#    거부된다.
# -----------------------------------------------------------------------------
echo "[3/5] pod identity + IAM 역할"
ASSOC_ID="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" \
  --region "$REGION" --namespace "$MONITORING_NAMESPACE" --service-account grafana \
  --query 'associations[0].associationId' --output text 2>/dev/null || true)"
if [[ -n "$ASSOC_ID" && "$ASSOC_ID" != "None" ]]; then
  aws eks delete-pod-identity-association --cluster-name "$CLUSTER_NAME" \
    --region "$REGION" --association-id "$ASSOC_ID" >/dev/null 2>&1 || true
  echo "  연결 삭제: ${ASSOC_ID}"
else
  echo "  연결이 없습니다."
fi

if aws iam get-role --role-name "$GRAFANA_ALERT_ROLE" >/dev/null 2>&1; then
  aws iam delete-role-policy --role-name "$GRAFANA_ALERT_ROLE" \
    --policy-name sns-publish >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$GRAFANA_ALERT_ROLE" >/dev/null
  echo "  역할 삭제: ${GRAFANA_ALERT_ROLE}"
else
  echo "  역할이 없습니다."
fi

# -----------------------------------------------------------------------------
# 4. SNS 토픽
#    토픽을 지우면 구독도 함께 사라진다. 다시 install 하면 같은 이름의 토픽이
#    새로 생기므로 구독은 그때 다시 넣어야 한다.
# -----------------------------------------------------------------------------
echo "[4/5] SNS 토픽"
ALERT_TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${ALERT_TOPIC_NAME}"
if aws sns get-topic-attributes --topic-arn "$ALERT_TOPIC_ARN" --region "$REGION" \
     >/dev/null 2>&1; then
  aws sns delete-topic --topic-arn "$ALERT_TOPIC_ARN" --region "$REGION" >/dev/null
  echo "  삭제: ${ALERT_TOPIC_NAME} (구독 포함)"
else
  echo "  토픽이 없습니다."
fi

# -----------------------------------------------------------------------------
# 5. PVC
#    1·2 번에서 워크로드가 PVC 를 놓았으므로 지울 수 있다. 여기서 안 지우면
#    EBS 볼륨이 남아 계속 과금된다.
# -----------------------------------------------------------------------------
echo "[5/5] PVC"
if [[ "$KEEP_PVC" == "true" ]]; then
  echo "  --keep-pvc 로 건너뜁니다. gp3 과금이 계속됩니다."
elif [[ -z "${GF_PVC_WAS}${PROM_PVC_WAS}" ]]; then
  echo "  지울 PVC 가 없습니다."
else
  for pvc in $GF_PVC_WAS $PROM_PVC_WAS; do
    kubectl delete pvc "$pvc" -n "$MONITORING_NAMESPACE" \
      --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
    echo "  삭제: ${pvc}"
  done
fi

cat <<EOF

완료.

  Grafana 는 알림 없이, Prometheus 는 ${BASE_RETENTION} retention 으로 돌아갑니다.
  대시보드와 데이터소스는 그대로입니다.

  다시 켜기 : ./scripts/eks/install-dashboard-hardening.sh
  전체 제거 : ./scripts/eks/delete-unified-dashboard.sh
              ./scripts/eks/delete-mlflow-selfhosted.sh
              ./scripts/eks/delete-dashboard-public.sh
EOF
