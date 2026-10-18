#!/usr/bin/env bash
# =============================================================================
# install-unified-dashboard.sh — Grafana·MLflow·TensorBoard 를 한 화면에서 출발하도록
#                                묶는다. 세 UI 는 이미 CloudFront 한 주소 아래에 있지만
#                                (install-dashboard-public.sh + install-mlflow-selfhosted.sh)
#                                들어갈 입구가 따로라 어디를 먼저 봐야 할지 알기 어렵다.
#
#   https://<cloudfront-도메인>/
#     └─ Grafana 홈 = "HyperPod Physical AI — Training Console"
#          ├─ 카드 3장: Cluster & GPU / MLflow ↗ / TensorBoard ↗
#          ├─ 요약 6칸: Ready 노드, GPU 수, 학습 파드, Kueue 대기, MLflow run 수/진행중
#          ├─ 최근 MLflow run 10건 + mean reward 그래프  ← Postgres 직접 조회
#          └─ DCGM GPU 사용률 + 학습 파드 CPU 요청량      ← Prometheus
#
#   MLflow 지표를 가져오는 방법으로 REST API(Infinity 플러그인) 대신 백엔드 Postgres 를
#   직접 읽는다. Postgres 데이터소스는 Grafana 에 내장되어 플러그인 설치가 필요 없고,
#   basic auth 헤더를 다룰 일도 없다. 대신 MLflow 스키마에 의존하므로 차트를 크게 올릴 때
#   runs / metrics / experiments 테이블 컬럼을 확인해야 한다.
#   DB 계정은 읽기 전용으로 따로 만든다(grafana_ro). MLflow 자체 계정을 재사용하면
#   대시보드 쿼리가 실험 기록을 지울 수 있다.
#
# ─── 전제 ───
#   install-dashboard-public.sh 와 install-mlflow-selfhosted.sh 를 모두 돌린 뒤 실행한다.
#   둘 중 하나라도 없으면 무엇을 먼저 돌려야 하는지 알려주고 멈춘다.
#
# 사용법:
#   ./scripts/eks/install-unified-dashboard.sh [--cluster <eks-cluster-name>] [--yes]
#
# 멱등하다. 다시 돌리면 대시보드 JSON 과 데이터소스만 갱신된다.
#
# 제거: ./scripts/eks/delete-unified-dashboard.sh
#       Grafana 홈을 기본값으로 되돌리고 데이터소스·DB 계정을 지운다.
#       Grafana·MLflow 자체는 각자의 delete-*.sh 가 담당한다.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EKS_DIR="$(cd "${HERE}/../../eks" && pwd)"

REGION="ap-northeast-2"
MONITORING_NAMESPACE="monitoring"
MLFLOW_NAMESPACE="mlflow"
GRAFANA_CHART_VERSION="10.5.15"        # install-dashboard-public.sh 와 같아야 한다
DASHBOARD_CONFIGMAP="hyperpod-dashboards"
CONSOLE_UID="hyperpod-training-console"
PG_RO_USER="grafana_ro"
SYSTEM_INSTANCE_TYPE="ml.c5.4xlarge"

CLUSTER_NAME=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

for tool in kubectl helm jq aws openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"

CONSOLE_JSON="${EKS_DIR}/grafana-dashboards/hyperpod-training-console.json"
[[ -f "$CONSOLE_JSON" ]] || { echo "대시보드 JSON 이 없습니다: ${CONSOLE_JSON}" >&2; exit 1; }

# -----------------------------------------------------------------------------
# 0. 전제 확인
# -----------------------------------------------------------------------------
if ! helm status grafana -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  echo "Grafana 릴리스가 없습니다. 먼저: ./scripts/eks/install-dashboard-public.sh" >&2
  exit 1
fi
if ! kubectl get statefulset mlflow-postgres -n "$MLFLOW_NAMESPACE" >/dev/null 2>&1; then
  echo "MLflow Postgres 가 없습니다. 먼저: ./scripts/eks/install-mlflow-selfhosted.sh" >&2
  exit 1
fi

CF_DOMAIN="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CLUSTER_NAME}-dashboard'].DomainName | [0]" \
  --output text 2>/dev/null || true)"
[[ "$CF_DOMAIN" == "None" ]] && CF_DOMAIN=""

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION})
하는 일    : Grafana 에 MLflow Postgres 데이터소스 추가 (읽기 전용 계정 ${PG_RO_USER})
             대시보드 "HyperPod Physical AI — Training Console" 프로비저닝
             Grafana 홈 대시보드를 이 콘솔로 지정
접속       : https://${CF_DOMAIN:-<cloudfront-도메인>}/
새 비용    : 없음 (기존 Grafana·Postgres 를 그대로 쓴다)

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

# -----------------------------------------------------------------------------
# 1. Postgres 읽기 전용 계정
#    CONNECT / USAGE / SELECT 만 준다. 비밀번호는 Secret 에 보관하고, 이미 있으면
#    재사용한다(재실행 때 비밀번호가 바뀌면 데이터소스가 끊긴다).
#    ALTER DEFAULT PRIVILEGES 는 MLflow 가 나중에 만드는 테이블에도 SELECT 를 넘긴다.
# -----------------------------------------------------------------------------
echo "[1/4] Postgres 읽기 전용 계정"
if kubectl get secret grafana-mlflow-db -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  PG_RO_PASS="$(kubectl get secret grafana-mlflow-db -n "$MONITORING_NAMESPACE" \
    -o jsonpath='{.data.password}' | base64 -d)"
  echo "  기존 Secret 재사용: grafana-mlflow-db"
else
  PG_RO_PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  kubectl create secret generic grafana-mlflow-db -n "$MONITORING_NAMESPACE" \
    --from-literal=username="$PG_RO_USER" \
    --from-literal=password="$PG_RO_PASS" >/dev/null
  echo "  Secret 생성: grafana-mlflow-db"
fi

MLFLOW_PG_USER="$(kubectl get secret mlflow-postgres -n "$MLFLOW_NAMESPACE" \
  -o jsonpath='{.data.username}' | base64 -d)"

# 비밀번호를 psql 인자나 SQL 리터럴로 넘기면 프로세스 목록과 로그에 남는다.
# 환경변수로 넘기고 psql 변수(:'ro_pass')로 받는다.
kubectl exec -i -n "$MLFLOW_NAMESPACE" mlflow-postgres-0 -- \
  env RO_USER="$PG_RO_USER" RO_PASS="$PG_RO_PASS" PG_USER="$MLFLOW_PG_USER" \
  sh -c 'psql -U "$PG_USER" -d mlflow -v ON_ERROR_STOP=1 \
           -v ro_user="$RO_USER" -v ro_pass="$RO_PASS" -f -' >/dev/null <<'SQL'
SELECT format('%s %I LOGIN PASSWORD %L',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ro_user')
                   THEN 'ALTER ROLE' ELSE 'CREATE ROLE' END,
              :'ro_user', :'ro_pass') AS stmt \gset
:stmt;
GRANT CONNECT ON DATABASE mlflow TO :"ro_user";
GRANT USAGE ON SCHEMA public TO :"ro_user";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"ro_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :"ro_user";
SQL
echo "  ${PG_RO_USER} 에 SELECT 권한 부여"

# -----------------------------------------------------------------------------
# 2. 대시보드 ConfigMap
#    install-dashboard-public.sh 와 같은 ConfigMap 이다. --from-file 로 디렉터리를
#    통째로 넣으므로 task governance 대시보드도 함께 유지된다.
# -----------------------------------------------------------------------------
echo "[2/4] 대시보드 ConfigMap"
kubectl create configmap "$DASHBOARD_CONFIGMAP" \
  --namespace "$MONITORING_NAMESPACE" \
  --from-file="${EKS_DIR}/grafana-dashboards" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "  $(ls "${EKS_DIR}/grafana-dashboards" | wc -l | tr -d ' ') 개 대시보드 적용"

# -----------------------------------------------------------------------------
# 3. Grafana — 데이터소스 추가 + 홈 대시보드 지정
#    helm get values 로 현재 값을 읽어 필요한 부분만 더한다. install-dashboard-public.sh
#    가 --set 으로 넣은 설정(datasources, dashboardProviders, nodeSelector)을 보존해야
#    하기 때문이다. 비밀번호는 secureJsonData 로 들어가고 values 파일은 바로 지운다.
# -----------------------------------------------------------------------------
echo "[3/4] Grafana 데이터소스 + 홈 대시보드"
VALUES="$(mktemp)"
OVERLAY="$(mktemp)"
trap 'rm -f "$VALUES" "$OVERLAY"' EXIT
chmod 600 "$VALUES" "$OVERLAY"

helm get values grafana -n "$MONITORING_NAMESPACE" -o json > "$VALUES"

# postgresVersion 1700 = Postgres 17. sslmode=disable 은 클러스터 내부 통신이고
# Postgres 컨테이너에 인증서를 넣지 않았기 때문이다.
# home_dashboard_uid 는 경로가 아니라 UID 로 지정해야 대시보드를 옮겨도 안 깨진다.
jq -n --arg pass "$PG_RO_PASS" --arg user "$PG_RO_USER" --arg ns "$MLFLOW_NAMESPACE" \
      --arg uid "$CONSOLE_UID" --arg it "$SYSTEM_INSTANCE_TYPE" '{
  datasources: {
    "datasources.yaml": {
      apiVersion: 1,
      datasources: [{
        name: "MLflow",
        uid: "mlflow-postgres",
        type: "postgres",
        access: "proxy",
        url: "mlflow-postgres.\($ns).svc.cluster.local:5432",
        database: "mlflow",
        user: $user,
        isDefault: false,
        jsonData: { sslmode: "disable", postgresVersion: 1700, timescaledb: false },
        secureJsonData: { password: $pass }
      }]
    }
  },
  "grafana.ini": { users: { home_dashboard_uid: $uid } },
  nodeSelector: { "node.kubernetes.io/instance-type": $it }
}' > "$OVERLAY"

# 기존 datasources.yaml 의 Prometheus 항목과 새 MLflow 항목을 합친다. jq 의 * 는
# 배열을 덮어쓰므로 datasources 배열만 따로 이어붙인다.
MERGED="$(jq -s '
  .[0] as $cur | .[1] as $new |
  ($cur * $new) |
  .datasources."datasources.yaml".datasources =
    (($cur.datasources."datasources.yaml".datasources // [])
     | map(select(.uid != "mlflow-postgres")))
    + $new.datasources."datasources.yaml".datasources
' "$VALUES" "$OVERLAY")"
printf '%s' "$MERGED" > "$VALUES"

helm upgrade grafana grafana/grafana \
  --version "$GRAFANA_CHART_VERSION" \
  --namespace "$MONITORING_NAMESPACE" \
  -f "$VALUES" \
  --wait --timeout 10m >/dev/null
rm -f "$VALUES" "$OVERLAY"
echo "  MLflow 데이터소스 등록 + 홈 대시보드 ${CONSOLE_UID}"

# -----------------------------------------------------------------------------
# 4. 확인
#    사이드카가 ConfigMap 을 집어 대시보드를 등록하기까지 몇십 초 걸린다.
# -----------------------------------------------------------------------------
echo "[4/4] 확인"
GF_PASS="$(kubectl get secret grafana -n "$MONITORING_NAMESPACE" \
  -o jsonpath='{.data.admin-password}' | base64 -d)"
OK="false"
for _ in $(seq 1 24); do
  if kubectl exec -n "$MONITORING_NAMESPACE" deploy/grafana -c grafana -- \
       env GF_PASS="$GF_PASS" CONSOLE_UID="$CONSOLE_UID" sh -c \
       'curl -sf -u "admin:${GF_PASS}" "http://localhost:3000/api/dashboards/uid/${CONSOLE_UID}"' \
       >/dev/null 2>&1; then
    OK="true"; break
  fi
  sleep 5
done
if [[ "$OK" == "true" ]]; then
  echo "  대시보드 등록 확인: ${CONSOLE_UID}"
else
  echo "  대시보드가 아직 안 보입니다. 사이드카 로그를 확인하세요:"
  echo "    kubectl logs -n ${MONITORING_NAMESPACE} deploy/grafana -c grafana-sc-dashboard"
fi

DS_OK="$(kubectl exec -n "$MONITORING_NAMESPACE" deploy/grafana -c grafana -- \
  env GF_PASS="$GF_PASS" sh -c 'curl -sf -u "admin:${GF_PASS}" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"queries\":[{\"refId\":\"A\",\"datasource\":{\"uid\":\"mlflow-postgres\",\"type\":\"postgres\"},\"rawSql\":\"SELECT 1 AS v\",\"format\":\"table\"}],\"from\":\"now-5m\",\"to\":\"now\"}" \
    http://localhost:3000/api/ds/query' 2>/dev/null \
  | jq -r '.results.A.error // "ok"' 2>/dev/null || echo "unreachable")"
if [[ "$DS_OK" == "ok" ]]; then
  echo "  MLflow Postgres 데이터소스 쿼리 성공"
else
  echo "  MLflow 데이터소스 쿼리 실패: ${DS_OK}"
fi

cat <<EOF

완료.

  URL  : https://${CF_DOMAIN:-<cloudfront-도메인>}/
  user : admin
  pass : kubectl get secret -n ${MONITORING_NAMESPACE} grafana -o jsonpath='{.data.admin-password}' | base64 -d

로그인하면 Training Console 이 홈으로 뜬다. 카드로 MLflow(/mlflow)·TensorBoard(/tensorboard)
로 넘어가고, MLflow run 목록과 mean reward 는 콘솔에서 바로 보인다.

학습을 한 번도 돌리지 않았다면 MLflow 패널은 비어 있다. 정상이다. GPU 노드가 0대인 동안
DCGM 패널도 비어 있다.

제거: ./scripts/eks/delete-unified-dashboard.sh
EOF
