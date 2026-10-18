#!/usr/bin/env bash
# =============================================================================
# delete-logs.sh — install-logs.sh 가 만든 리소스 삭제
#
# 삭제 순서: Grafana 데이터소스 → Alloy → Loki → PVC → pod identity
#            → 네임스페이스 → S3(선택) → IAM 역할
# Grafana 를 먼저 끊어야 Loki 가 사라진 뒤 Explore 에서 빈 데이터소스를 보지 않는다.
# Alloy 를 Loki 보다 먼저 지워야 쓰지 못하는 엔드포인트로 재시도하며 로그를 쌓지 않는다.
#
# S3 의 로그는 기본으로 남긴다. 다시 설치하면 그대로 다시 읽힌다.
#   --purge-s3   s3://<버킷>/loki/ 아래를 전부 삭제 (복구 불가)
#
# 같은 버킷의 mlflow-artifacts/ 는 어떤 경우에도 건드리지 않는다.
#
# 사용법:
#   ./scripts/eks/delete-logs.sh [--cluster <eks-cluster-name>] [--yes] [--purge-s3]
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
NAMESPACE="logging"
MONITORING_NAMESPACE="monitoring"
GRAFANA_CHART_VERSION="10.5.15"
S3_PREFIX="loki"

CLUSTER_NAME=""
ASSUME_YES="false"
PURGE_S3="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    --purge-s3) PURGE_S3="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"
LOKI_ROLE="${CLUSTER_NAME}-loki"

S3_BUCKET="${S3_BUCKET:-$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='S3BucketName'].OutputValue | [0]" --output text 2>/dev/null || true)}"
[[ -n "$S3_BUCKET" && "$S3_BUCKET" != "None" ]] || S3_BUCKET=""

cat <<EOF

삭제 대상 (${CLUSTER_NAME}, ${REGION}):
  Grafana 데이터소스 'Loki' (Prometheus·MLflow 는 유지)
  Helm 릴리스 alloy + loki (${NAMESPACE})
  Loki PVC (gp3) — WAL 과 로컬 인덱스 캐시
  pod identity ${NAMESPACE}/loki + IAM 역할 ${LOKI_ROLE}
  네임스페이스 ${NAMESPACE}
EOF
if [[ "$PURGE_S3" == "true" ]]; then
  if [[ -n "$S3_BUCKET" ]]; then
    echo "  [--purge-s3] s3://${S3_BUCKET}/${S3_PREFIX}/ 전체 — 복구할 수 없습니다"
  else
    echo "  [--purge-s3] 버킷 이름을 읽지 못해 S3 삭제는 건너뜁니다"
  fi
else
  echo "  (유지) s3://${S3_BUCKET:-<버킷>}/${S3_PREFIX}/ 의 로그. 지우려면 --purge-s3"
fi
cat <<EOF

Grafana·ALB·CloudFront·MLflow 는 건드리지 않습니다.
같은 버킷의 mlflow-artifacts/ 와 FSx 의 체크포인트도 그대로 남습니다.

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "계속할까요? [y/N] " ANSWER
  [[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]] || { echo "중단"; exit 0; }
fi

# -----------------------------------------------------------------------------
# 1. Grafana 데이터소스
#    install 과 마찬가지로 helm get values 를 읽어 Loki 항목만 뺀다.
#    install-dashboard-public.sh 가 --set 으로 넣은 Prometheus 와
#    install-unified-dashboard.sh 가 넣은 MLflow 를 살려야 한다.
# -----------------------------------------------------------------------------
echo "[1/5] Grafana 데이터소스"
if helm status grafana -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update >/dev/null 2>&1 || true

  VALUES="$(mktemp)"
  trap 'rm -f "$VALUES"' EXIT
  chmod 600 "$VALUES"
  helm get values grafana -n "$MONITORING_NAMESPACE" -o json > "$VALUES"

  HAS_DS="$(jq -r 'if (.datasources."datasources.yaml".datasources? // [])
                     | map(select(.uid == "loki")) | length > 0
                   then "yes" else "no" end' "$VALUES")"
  if [[ "$HAS_DS" == "no" ]]; then
    echo "  이미 제거된 상태입니다. helm upgrade 를 건너뜁니다."
  else
    # 없는 키에 대입하면 jq 가 빈 객체를 새로 만들어 버리므로 있을 때만 손댄다.
    jq '(if (.datasources."datasources.yaml".datasources? // null) != null then
           .datasources."datasources.yaml".datasources |= map(select(.uid != "loki"))
         else . end)' "$VALUES" > "${VALUES}.new"
    mv "${VALUES}.new" "$VALUES"

    helm upgrade grafana grafana/grafana \
      --version "$GRAFANA_CHART_VERSION" \
      --namespace "$MONITORING_NAMESPACE" \
      -f "$VALUES" \
      --wait --timeout 10m >/dev/null
    echo "  Loki 데이터소스 제거"
  fi
  rm -f "$VALUES"
  trap - EXIT
else
  echo "  Grafana 릴리스가 없습니다. 건너뜁니다."
fi

# -----------------------------------------------------------------------------
# 2. Alloy → Loki
#    Alloy 가 먼저다. Loki 를 먼저 지우면 Alloy 가 push 실패를 재시도하며
#    자기 로그를 쌓는다 (그 로그를 받을 곳도 이미 없다).
# -----------------------------------------------------------------------------
echo "[2/5] Alloy + Loki"
helm uninstall alloy -n "$NAMESPACE" >/dev/null 2>&1 || true
echo "  Helm 릴리스 alloy 삭제"
helm uninstall loki -n "$NAMESPACE" >/dev/null 2>&1 || true
echo "  Helm 릴리스 loki 삭제"

# -----------------------------------------------------------------------------
# 3. PVC
#    StatefulSet 의 volumeClaimTemplate 으로 만든 PVC 는 helm uninstall 로
#    지워지지 않는다. gp3 StorageClass 가 reclaimPolicy=Retain 이므로 PVC 를
#    지워도 PV 와 EBS 볼륨은 남는다. 남는 PV 는 끝에서 안내만 한다.
# -----------------------------------------------------------------------------
echo "[3/5] PVC"
RELEASED_PV=""
if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  PVC_LIST="$(kubectl get pvc -n "$NAMESPACE" -o name 2>/dev/null || true)"
  if [[ -n "$PVC_LIST" ]]; then
    # PVC 를 지우기 전에 PV 이름을 받아 둔다. 지운 뒤에는 연결이 끊겨 못 찾는다.
    RELEASED_PV="$(kubectl get pvc -n "$NAMESPACE" \
      -o jsonpath='{range .items[*]}{.spec.volumeName}{"\n"}{end}' 2>/dev/null || true)"
    while read -r pvc; do
      [[ -n "$pvc" ]] || continue
      kubectl delete "$pvc" -n "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
      echo "  삭제: ${pvc}"
    done <<<"$PVC_LIST"
  else
    echo "  PVC 없음"
  fi
else
  echo "  네임스페이스 ${NAMESPACE} 가 없습니다. 건너뜁니다."
fi

# -----------------------------------------------------------------------------
# 4. pod identity + 네임스페이스
# -----------------------------------------------------------------------------
echo "[4/5] pod identity + 네임스페이스"
PIA_ID="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
  --namespace "$NAMESPACE" --service-account loki \
  --query "associations[0].associationId" --output text 2>/dev/null || true)"
if [[ -n "$PIA_ID" && "$PIA_ID" != "None" ]]; then
  aws eks delete-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --association-id "$PIA_ID" >/dev/null
  echo "  pod identity 삭제: ${PIA_ID}"
fi
kubectl delete namespace "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
echo "  네임스페이스 ${NAMESPACE} 삭제"

# -----------------------------------------------------------------------------
# 5. S3 + IAM
# -----------------------------------------------------------------------------
echo "[5/5] S3 + IAM"
if [[ "$PURGE_S3" == "true" && -n "$S3_BUCKET" ]]; then
  # 접두어를 반드시 붙여서 지운다. 접두어 없이 돌리면 같은 버킷의
  # mlflow-artifacts/ 와 다른 산출물까지 전부 날아간다.
  aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/" --recursive >/dev/null 2>&1 || true
  echo "  삭제: s3://${S3_BUCKET}/${S3_PREFIX}/"
fi

# IAM 역할은 인라인 정책을 먼저 떼야 지워진다.
delete_role() {
  local role="$1" name arn
  aws iam get-role --role-name "$role" >/dev/null 2>&1 || return 0
  for name in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$role" --policy-name "$name" >/dev/null
  done
  for arn in $(aws iam list-attached-role-policies --role-name "$role" \
                 --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$arn" >/dev/null
  done
  aws iam delete-role --role-name "$role" >/dev/null
  echo "  IAM 역할 삭제: ${role}"
}
delete_role "$LOKI_ROLE"

cat <<EOF

완료.

  Grafana 의 Prometheus·MLflow 데이터소스는 그대로입니다.
EOF
if [[ "$PURGE_S3" != "true" ]]; then
  cat <<EOF
  s3://${S3_BUCKET:-<버킷>}/${S3_PREFIX}/ 의 로그는 남아 있습니다. 다시 설치하면
  이전 로그가 그대로 조회됩니다. 완전히 지우려면 --purge-s3 로 다시 실행하세요.
EOF
fi
if [[ -n "$RELEASED_PV" ]]; then
  cat <<EOF

  gp3 는 reclaimPolicy=Retain 이라 PV 와 EBS 볼륨이 남습니다. WAL 과 로컬
  캐시뿐이므로 지워도 S3 의 로그에는 영향이 없습니다.
EOF
  echo "$RELEASED_PV" | sed 's/^/    kubectl delete pv /'
fi
cat <<EOF

  다시 설치 : ./scripts/eks/install-logs.sh
EOF
