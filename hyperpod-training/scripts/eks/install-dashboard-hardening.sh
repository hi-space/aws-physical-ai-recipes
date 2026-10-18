#!/usr/bin/env bash
# =============================================================================
# install-dashboard-hardening.sh — 대시보드 스택을 PoC 에서 한 단계 올린다.
#                                  두 가지만 한다: 데이터를 남기고, 알림을 보낸다.
#
#   install-dashboard-public.sh 는 Prometheus·Grafana 를 emptyDir 로 올리고
#   retention 을 6h 로 둔다. gp3 StorageClass 가 그 시점에 없기 때문이다(그건
#   install-mlflow-selfhosted.sh 가 EBS CSI 애드온과 함께 만든다). 그래서 영속화는
#   설치가 끝난 뒤 별도로 돌리는 이 스크립트가 맡는다.
#
#   1. 지표·설정 보존
#        Prometheus  gp3 PVC 50Gi, retention 15d
#        Grafana     gp3 PVC 10Gi (알림 상태·사용자·설정이 여기 있다)
#      Grafana 는 RollingUpdate 로는 ReadWriteOnce PVC 를 두 파드가 못 나눠 갖는다.
#      deploymentStrategy 를 Recreate 로 바꾼다.
#
#   2. 알림
#        SNS 토픽 <cluster>-alerts + Grafana 용 pod identity (sns:Publish)
#        Grafana 알림 규칙 4개 — eks/grafana-alerting/hyperpod-alerts.yaml
#          TrainingPodFailed      학습 네임스페이스에 Failed 파드        5m
#          KueueBacklog           kueue_pending_workloads > 0           30m
#          NodeNotReady           Ready 아닌 노드                       10m
#          GPUIdleWhileAllocated  GPU 할당됐는데 사용률 5% 미만          30m
#      구독은 넣지 않는다. 이메일 주소가 스크립트나 셸 히스토리에 남지 않도록
#      마지막에 aws sns subscribe 명령만 출력한다.
#
#   알림 상태는 Grafana 자체 DB 에 들어간다. 그래서 1 번이 먼저다. emptyDir 상태로
#   알림만 켜면 파드가 재시작할 때마다 경보 상태가 초기화되어 같은 알림이 다시 온다.
#
# ─── 전제 ───
#   install-dashboard-public.sh      Grafana·Prometheus 릴리스
#   install-mlflow-selfhosted.sh     gp3 StorageClass (EBS CSI 애드온)
#   둘 중 하나라도 없으면 무엇을 먼저 돌려야 하는지 알려주고 멈춘다.
#
# 사용법:
#   ./scripts/eks/install-dashboard-hardening.sh [--cluster <eks-cluster-name>] [--yes]
#                                                [--prom-size 50Gi] [--prom-retention 15d]
#
# 멱등하다. 다시 돌리면 같은 PVC 를 재사용하고 알림 규칙만 갱신된다.
#
# 새 비용: gp3 60Gi 약 \$5/월. SNS 는 알림 건당 과금이라 사실상 0.
#
# 제거: ./scripts/eks/delete-dashboard-hardening.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EKS_DIR="$(cd "${HERE}/../../eks" && pwd)"

REGION="ap-northeast-2"
MONITORING_NAMESPACE="monitoring"
KPS_CHART_VERSION="92.10.1"            # install-dashboard-public.sh 와 같아야 한다
GRAFANA_CHART_VERSION="10.5.15"        # install-dashboard-public.sh 와 같아야 한다
STORAGE_CLASS="gp3"
GRAFANA_SIZE="10Gi"

PROM_SIZE="50Gi"
PROM_RETENTION="15d"
CLUSTER_NAME=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --prom-size) PROM_SIZE="$2"; shift 2 ;;
    --prom-retention) PROM_RETENTION="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

for tool in kubectl helm jq aws envsubst; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"

ALERT_TOPIC_NAME="${CLUSTER_NAME}-alerts"
GRAFANA_ALERT_ROLE="${CLUSTER_NAME}-grafana-alerts"
ALERTS_TEMPLATE="${EKS_DIR}/grafana-alerting/hyperpod-alerts.yaml"
[[ -f "$ALERTS_TEMPLATE" ]] || { echo "알림 정의가 없습니다: ${ALERTS_TEMPLATE}" >&2; exit 1; }

# -----------------------------------------------------------------------------
# 0. 전제 확인
# -----------------------------------------------------------------------------
if ! helm status grafana -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  echo "Grafana 릴리스가 없습니다. 먼저: ./scripts/eks/install-dashboard-public.sh" >&2
  exit 1
fi
if ! helm status kps -n "$MONITORING_NAMESPACE" >/dev/null 2>&1; then
  echo "kube-prometheus-stack 릴리스가 없습니다. 먼저: ./scripts/eks/install-dashboard-public.sh" >&2
  exit 1
fi
if ! kubectl get storageclass "$STORAGE_CLASS" >/dev/null 2>&1; then
  echo "StorageClass ${STORAGE_CLASS} 가 없습니다. 먼저: ./scripts/eks/install-mlflow-selfhosted.sh" >&2
  echo "(그 스크립트가 aws-ebs-csi-driver 애드온과 gp3 StorageClass 를 만든다)" >&2
  exit 1
fi

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION})
하는 일    : Prometheus 를 ${STORAGE_CLASS} PVC ${PROM_SIZE} 로, retention ${PROM_RETENTION}
             Grafana 를 ${STORAGE_CLASS} PVC ${GRAFANA_SIZE} 로 (알림 상태 보존)
             SNS 토픽 ${ALERT_TOPIC_NAME} + pod identity ${GRAFANA_ALERT_ROLE}
             Grafana 알림 규칙 4개 프로비저닝
새 비용    : gp3 $(( ${PROM_SIZE%Gi} + ${GRAFANA_SIZE%Gi} ))Gi 약 \$5/월. SNS 는 건당 과금.
주의       : Prometheus·Grafana 파드가 재생성됩니다. emptyDir 에 있던 기존 지표와
             Grafana 가 UI 에서 만든 설정은 이 시점에 사라집니다. 대시보드 정의는
             ConfigMap 에서 다시 올라오므로 영향 없습니다.

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

# -----------------------------------------------------------------------------
# 1. SNS 토픽
#    create-topic 은 멱등하다. 같은 이름이면 기존 ARN 을 돌려준다.
# -----------------------------------------------------------------------------
echo "[1/5] SNS 토픽"
ALERT_TOPIC_ARN="$(aws sns create-topic --name "$ALERT_TOPIC_NAME" --region "$REGION" \
  --query TopicArn --output text)"
echo "  ${ALERT_TOPIC_ARN}"

# -----------------------------------------------------------------------------
# 2. Grafana 용 pod identity
#    Grafana 가 SNS 로 알림을 보낼 때 쓴다. 액세스 키를 알림 설정에 넣지 않기 위한
#    것이다. 권한은 이 토픽 하나로 제한한다.
# -----------------------------------------------------------------------------
echo "[2/5] pod identity ${GRAFANA_ALERT_ROLE}"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"pods.eks.amazonaws.com"},
  "Action":["sts:AssumeRole","sts:TagSession"]}]}'

if ! aws iam get-role --role-name "$GRAFANA_ALERT_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$GRAFANA_ALERT_ROLE" \
    --assume-role-policy-document "$TRUST" >/dev/null
  echo "  IAM 역할 생성"
else
  echo "  IAM 역할 재사용"
fi

aws iam put-role-policy --role-name "$GRAFANA_ALERT_ROLE" \
  --policy-name sns-publish \
  --policy-document "$(jq -n --arg arn "$ALERT_TOPIC_ARN" '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["sns:Publish", "sns:GetTopicAttributes"],
      Resource: $arn
    }]
  }')" >/dev/null

# pod identity 연결은 ServiceAccount 이름으로 걸린다. Grafana 차트의 SA 는 릴리스
# 이름과 같다. 연결은 갱신이 안 되므로(역할을 바꾸려면 지우고 다시 만들어야 한다)
# 이미 있으면 그대로 둔다.
EXISTING_ASSOC="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" \
  --region "$REGION" --namespace "$MONITORING_NAMESPACE" --service-account grafana \
  --query 'associations[0].associationId' --output text 2>/dev/null || true)"
if [[ -z "$EXISTING_ASSOC" || "$EXISTING_ASSOC" == "None" ]]; then
  aws eks create-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --namespace "$MONITORING_NAMESPACE" --service-account grafana \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${GRAFANA_ALERT_ROLE}" >/dev/null
  echo "  pod identity 연결 생성: ${MONITORING_NAMESPACE}/grafana"
else
  echo "  pod identity 연결 재사용: ${EXISTING_ASSOC}"
fi

# -----------------------------------------------------------------------------
# 3. Prometheus — PVC + retention
#    storageSpec 을 주면 오퍼레이터가 StatefulSet 을 PVC 로 바꿔 다시 만든다.
#    emptyDir 에 있던 지표는 이 시점에 사라진다(6h 치라 잃을 게 적다).
# -----------------------------------------------------------------------------
echo "[3/5] Prometheus PVC ${PROM_SIZE} + retention ${PROM_RETENTION}"
KPS_VALUES="$(mktemp)"
GF_VALUES="$(mktemp)"
GF_ALERTS="$(mktemp)"
GF_ALERT_VALUES="$(mktemp)"
trap 'rm -f "$KPS_VALUES" "$GF_VALUES" "$GF_ALERTS" "$GF_ALERT_VALUES"' EXIT
chmod 600 "$KPS_VALUES" "$GF_VALUES" "$GF_ALERTS" "$GF_ALERT_VALUES"

helm get values kps -n "$MONITORING_NAMESPACE" -o json > "$KPS_VALUES"
jq --arg sc "$STORAGE_CLASS" --arg size "$PROM_SIZE" --arg ret "$PROM_RETENTION" '
  .prometheus.prometheusSpec.retention = $ret
  | .prometheus.prometheusSpec.storageSpec = {
      volumeClaimTemplate: {
        spec: {
          storageClassName: $sc,
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: $size } }
        }
      }
    }
' "$KPS_VALUES" > "${KPS_VALUES}.new"
mv "${KPS_VALUES}.new" "$KPS_VALUES"

helm upgrade kps prometheus-community/kube-prometheus-stack \
  --version "$KPS_CHART_VERSION" \
  --namespace "$MONITORING_NAMESPACE" \
  -f "$KPS_VALUES" \
  --wait --timeout 15m >/dev/null
echo "  적용 완료"

# -----------------------------------------------------------------------------
# 4. Grafana — PVC + 알림 프로비저닝
#    ReadWriteOnce PVC 는 두 파드가 동시에 붙을 수 없다. RollingUpdate 로 두면
#    새 파드가 Pending 에 걸려 배포가 영원히 안 끝난다. Recreate 로 바꾼다.
#    AWS_REGION 은 SNS 알림이 리전을 못 찾는 경우를 막는다.
# -----------------------------------------------------------------------------
echo "[4/5] Grafana PVC ${GRAFANA_SIZE} + 알림 규칙"
REGION="$REGION" ALERT_TOPIC_ARN="$ALERT_TOPIC_ARN" \
  envsubst '${REGION} ${ALERT_TOPIC_ARN}' < "$ALERTS_TEMPLATE" > "$GF_ALERTS"

helm get values grafana -n "$MONITORING_NAMESPACE" -o json > "$GF_VALUES"

jq --arg sc "$STORAGE_CLASS" --arg size "$GRAFANA_SIZE" --arg region "$REGION" '
  .persistence = { type: "pvc", enabled: true, storageClassName: $sc,
                   accessModes: ["ReadWriteOnce"], size: $size }
  | .deploymentStrategy = { type: "Recreate" }
  | .env.AWS_REGION = $region
' "$GF_VALUES" > "${GF_VALUES}.new"
mv "${GF_VALUES}.new" "$GF_VALUES"

# alerting 의 값은 파싱된 map 이어야 한다. 문자열로 넣으면 차트가
# `hasKey $value "file"` 을 호출하다 "expected map[string]interface {}; got string"
# 으로 렌더링에 실패한다. yq 없이 map 으로 만들기 위해 알림 YAML 을 4칸 들여써
# values 파일로 감싸고 helm 에게 파싱을 맡긴다.
{
  echo "alerting:"
  echo "  hyperpod-alerts.yaml:"
  awk '{ if (length($0)) print "    " $0; else print "" }' "$GF_ALERTS"
} > "$GF_ALERT_VALUES"

helm upgrade grafana grafana/grafana \
  --version "$GRAFANA_CHART_VERSION" \
  --namespace "$MONITORING_NAMESPACE" \
  -f "$GF_VALUES" \
  -f "$GF_ALERT_VALUES" \
  --wait --timeout 10m >/dev/null
rm -f "$KPS_VALUES" "$GF_VALUES" "$GF_ALERTS" "$GF_ALERT_VALUES"
echo "  적용 완료"

# -----------------------------------------------------------------------------
# 5. 확인
# -----------------------------------------------------------------------------
echo "[5/5] 확인"
kubectl get pvc -n "$MONITORING_NAMESPACE" \
  -o custom-columns='PVC:.metadata.name,STATUS:.status.phase,SIZE:.spec.resources.requests.storage,SC:.spec.storageClassName' \
  --no-headers 2>/dev/null | sed 's/^/  /'

GF_PASS="$(kubectl get secret grafana -n "$MONITORING_NAMESPACE" \
  -o jsonpath='{.data.admin-password}' | base64 -d)"
RULES="unknown"
for _ in $(seq 1 24); do
  RULES="$(kubectl exec -n "$MONITORING_NAMESPACE" deploy/grafana -c grafana -- \
    env GF_PASS="$GF_PASS" sh -c \
    'curl -sf -u "admin:${GF_PASS}" http://localhost:3000/api/v1/provisioning/alert-rules' \
    2>/dev/null | jq -r 'length' 2>/dev/null || echo "unknown")"
  [[ "$RULES" =~ ^[0-9]+$ ]] && [[ "$RULES" -gt 0 ]] && break
  sleep 5
done
echo "  알림 규칙 ${RULES} 개 등록"

CP="$(kubectl exec -n "$MONITORING_NAMESPACE" deploy/grafana -c grafana -- \
  env GF_PASS="$GF_PASS" sh -c \
  'curl -sf -u "admin:${GF_PASS}" http://localhost:3000/api/v1/provisioning/contact-points' \
  2>/dev/null | jq -r '[.[] | select(.type == "sns") | .name] | join(",")' 2>/dev/null || true)"
echo "  SNS 연락 지점: ${CP:-등록 확인 실패}"

cat <<EOF

완료.

알림을 받을 주소를 구독하세요. 이메일이면:

  aws sns subscribe --region ${REGION} \\
    --topic-arn ${ALERT_TOPIC_ARN} \\
    --protocol email --notification-endpoint you@example.com

확인 메일의 링크를 눌러야 전송이 시작됩니다. Slack 은 --protocol https 로 웹훅
URL 을, SMS 는 --protocol sms 로 번호를 넣습니다. 구독 목록 확인:

  aws sns list-subscriptions-by-topic --region ${REGION} --topic-arn ${ALERT_TOPIC_ARN}

알림이 실제로 나가는지 보려면 Grafana 에서 Alerting → Contact points →
hyperpod-sns → Test 를 누르세요.

규칙 4개 중 두 개는 전제가 갖춰져야 켜집니다.
  KueueBacklog          ClusterQueue 가 있어야 kueue_pending_workloads 가 생긴다
                        (./scripts/eks/create-governance.sh)
  GPUIdleWhileAllocated GPU 노드가 1대 이상이어야 DCGM 지표가 생긴다
둘 다 지표가 없는 동안에는 조용하다(noDataState=OK).

제거: ./scripts/eks/delete-dashboard-hardening.sh
EOF
