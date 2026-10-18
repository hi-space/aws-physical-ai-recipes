#!/usr/bin/env bash
# =============================================================================
# delete-unified-dashboard.sh — install-unified-dashboard.sh 가 더한 것만 되돌린다.
#
#   되돌리는 것
#     1. Grafana 홈 대시보드 지정 해제 (grafana.ini users.home_dashboard_uid)
#     2. MLflow Postgres 데이터소스 제거 (uid mlflow-postgres)
#     3. Postgres 읽기 전용 계정 grafana_ro 의 권한 회수 + 역할 삭제
#     4. Secret monitoring/grafana-mlflow-db 삭제
#
#   건드리지 않는 것
#     Grafana·Prometheus 릴리스        → delete-dashboard-public.sh
#     MLflow·Postgres·TensorBoard      → delete-mlflow-selfhosted.sh
#     ConfigMap hyperpod-dashboards    → delete-dashboard-public.sh 가 지운다.
#     MLflow 실험 기록                 → 읽기 전용 계정만 지우므로 그대로 남는다.
#
#   대시보드 JSON 은 ConfigMap 에 남아 있어 Training Console 자체는 계속 열린다.
#   다만 홈이 아니고 MLflow 패널은 데이터소스가 없어 비어 보인다. 완전히 치우려면
#   delete-dashboard-public.sh 로 Grafana 를 지우면 된다.
#
# 사용법:
#   ./scripts/eks/delete-unified-dashboard.sh [--cluster <eks-cluster-name>] [--yes]
#
# 멱등하다. 이미 지워진 상태에서 다시 돌려도 아무것도 하지 않는다.
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
MONITORING_NAMESPACE="monitoring"
MLFLOW_NAMESPACE="mlflow"
GRAFANA_CHART_VERSION="10.5.15"        # install-dashboard-public.sh 와 같아야 한다
CONSOLE_UID="hyperpod-training-console"
PG_RO_USER="grafana_ro"

CLUSTER_NAME=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

for tool in kubectl helm jq aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION})
삭제       : Grafana 홈 대시보드 지정 (${CONSOLE_UID}) → 기본값으로 복귀
             Grafana 데이터소스 MLflow (uid mlflow-postgres)
             Postgres 역할 ${PG_RO_USER} + 권한
             Secret ${MONITORING_NAMESPACE}/grafana-mlflow-db
유지       : Grafana·Prometheus·MLflow·TensorBoard 릴리스, MLflow 실험 기록,
             ConfigMap hyperpod-dashboards (대시보드 JSON 은 남는다)

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

# -----------------------------------------------------------------------------
# 1. Grafana — 데이터소스 제거 + 홈 대시보드 지정 해제
#    helm get values 로 현재 값을 읽어 두 곳만 빼고 그대로 다시 올린다. install 과
#    마찬가지로 jq 로 직접 손대야 install-dashboard-public.sh 가 --set 으로 넣은
#    설정(Prometheus 데이터소스, dashboardProviders, nodeSelector)이 살아남는다.
#    Grafana 를 먼저 끊어야 뒤에서 역할을 지울 때 연결이 남지 않는다.
# -----------------------------------------------------------------------------
echo "[1/3] Grafana 데이터소스 + 홈 대시보드"
if helm status grafana -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  VALUES="$(mktemp)"
  trap 'rm -f "$VALUES"' EXIT
  chmod 600 "$VALUES"

  helm get values grafana -n "$MONITORING_NAMESPACE" -o json > "$VALUES"

  HAS_DS="$(jq -r 'if (.datasources."datasources.yaml".datasources? // [])
                     | map(select(.uid == "mlflow-postgres")) | length > 0
                   then "yes" else "no" end' "$VALUES")"
  HAS_HOME="$(jq -r 'if ."grafana.ini".users.home_dashboard_uid? != null
                     then "yes" else "no" end' "$VALUES")"

  if [[ "$HAS_DS" == "no" && "$HAS_HOME" == "no" ]]; then
    echo "  이미 제거된 상태입니다. helm upgrade 를 건너뜁니다."
  else
    # 없는 키에 대입하면 jq 가 빈 객체를 새로 만들어 버리므로 있을 때만 손댄다.
    # users 가 비면 섹션을 통째로 지운다. 빈 섹션이 grafana.ini 에 남는 걸 피한다.
    jq '
      (if (.datasources."datasources.yaml".datasources? // null) != null then
         .datasources."datasources.yaml".datasources |=
           map(select(.uid != "mlflow-postgres"))
       else . end)
      | (if (."grafana.ini".users? // null) != null then
           del(."grafana.ini".users.home_dashboard_uid)
         else . end)
      | (if (."grafana.ini".users? // null) == {} then del(."grafana.ini".users) else . end)
      | (if (."grafana.ini"? // null) == {} then del(."grafana.ini") else . end)
    ' "$VALUES" > "${VALUES}.new"
    mv "${VALUES}.new" "$VALUES"

    helm upgrade grafana grafana/grafana \
      --version "$GRAFANA_CHART_VERSION" \
      --namespace "$MONITORING_NAMESPACE" \
      -f "$VALUES" \
      --wait --timeout 10m >/dev/null
    echo "  MLflow 데이터소스 제거 + 홈 대시보드 기본값 복귀"
  fi
  rm -f "$VALUES"
  trap - EXIT
else
  echo "  Grafana 릴리스가 없습니다. 건너뜁니다."
fi

# -----------------------------------------------------------------------------
# 2. Postgres 읽기 전용 계정 삭제
#    DROP ROLE 은 다른 객체에 권한이 남아 있으면 거부된다. 그래서 install 이 준
#    것들을 역순으로 회수한다. ALTER DEFAULT PRIVILEGES 는 권한을 준 역할(MLflow
#    계정)로 실행해야 효과가 있으므로 같은 계정으로 접속한다.
#    역할이 없으면 REVOKE 가 에러이므로 존재할 때만 문장을 만든다.
# -----------------------------------------------------------------------------
echo "[2/3] Postgres 역할 ${PG_RO_USER}"
if kubectl get pod mlflow-postgres-0 -n "$MLFLOW_NAMESPACE" >/dev/null 2>&1; then
  MLFLOW_PG_USER="$(kubectl get secret mlflow-postgres -n "$MLFLOW_NAMESPACE" \
    -o jsonpath='{.data.username}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [[ -n "$MLFLOW_PG_USER" ]]; then
    kubectl exec -i -n "$MLFLOW_NAMESPACE" mlflow-postgres-0 -- \
      env RO_USER="$PG_RO_USER" PG_USER="$MLFLOW_PG_USER" \
      sh -c 'psql -U "$PG_USER" -d mlflow -v ON_ERROR_STOP=1 \
               -v ro_user="$RO_USER" -f -' >/dev/null <<'SQL'
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ro_user') THEN
         format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM %1$I;'
                ' REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %1$I;'
                ' REVOKE ALL ON SCHEMA public FROM %1$I;'
                ' REVOKE ALL ON DATABASE mlflow FROM %1$I;'
                ' DROP ROLE %1$I', :'ro_user')
       ELSE 'SELECT 1' END AS stmt \gset
:stmt;
SQL
    echo "  역할 삭제 (없었으면 아무 일도 없음)"
  else
    echo "  mlflow-postgres Secret 이 없어 접속 계정을 모릅니다. 건너뜁니다."
  fi
else
  echo "  Postgres 파드가 없습니다. 건너뜁니다."
fi

# -----------------------------------------------------------------------------
# 3. Secret
# -----------------------------------------------------------------------------
echo "[3/3] Secret"
kubectl delete secret grafana-mlflow-db -n "$MONITORING_NAMESPACE" \
  --ignore-not-found >/dev/null 2>&1 || true
echo "  grafana-mlflow-db 삭제"

CF_DOMAIN="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CLUSTER_NAME}-dashboard'].DomainName | [0]" \
  --output text 2>/dev/null || true)"
[[ "$CF_DOMAIN" == "None" ]] && CF_DOMAIN=""

cat <<EOF

완료.

  https://${CF_DOMAIN:-<cloudfront-도메인>}/ 는 Grafana 기본 홈으로 돌아갑니다.
  Training Console 대시보드는 /d/${CONSOLE_UID}/ 에 남아 있지만 MLflow 패널은
  데이터소스가 없어 비어 보입니다.

  다시 켜기 : ./scripts/eks/install-unified-dashboard.sh
  전체 제거 : ./scripts/eks/delete-mlflow-selfhosted.sh
              ./scripts/eks/delete-dashboard-public.sh
EOF
