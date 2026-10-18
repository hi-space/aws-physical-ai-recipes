#!/usr/bin/env bash
# =============================================================================
# install-logs.sh — 끝난 Job 의 로그를 S3 에 보관하고 Grafana 에서 검색한다.
#
#   학습 파드
#     └─ /var/log/pods/*.log            (kubelet 이 쓰는 컨테이너 로그)
#          └─ Grafana Alloy (DaemonSet)  노드마다 1개, 파일을 읽어 push
#               └─ Loki (SingleBinary)   index + chunk 를 S3 로 내린다
#                    └─ s3://<데이터 버킷>/loki/
#                         └─ Grafana 데이터소스 'Loki' → Explore 에서 LogQL
#
#   왜 필요한가
#     Job 이 끝나면 ttlSecondsAfterFinished 가 파드를 지운다. 파드가 사라지면
#     kubectl logs 도, Argo 포탈의 Logs 탭도 아무것도 못 보여 준다. 어제 돌린 학습이
#     왜 죽었는지 보려면 로그가 파드 바깥에 남아 있어야 한다.
#
#   보관 기간은 30일이다. 그 뒤에는 compactor 가 S3 에서 지운다. 학습 로그는
#   한 번 돌면 수십 MB 수준이라 30일이면 S3 비용이 센트 단위다.
#
# ─── 설계 선택 ───
#   SingleBinary (deploymentMode=SingleBinary, replicas=1)
#     읽기·쓰기·compactor 를 한 파드에서 돌린다. 팀 단위(수십 명, 하루 수 GB)에는
#     충분하고, SimpleScalable 로 가면 파드가 6개 이상 늘어 c5 노드 하나를 다 먹는다.
#     replication_factor 가 1 이므로 파드가 재시작하는 동안 쓰기가 끊긴다. 다만
#     Alloy 가 파일 오프셋을 들고 있어 재시작 뒤 밀린 분량을 다시 보낸다.
#
#   S3 (use_thanos_objstore=true, storage_prefix=loki)
#     MLflow 아티팩트와 같은 버킷을 쓰되 키 접두어로 갈라 둔다. IAM 정책도
#     s3://<버킷>/loki/* 로만 좁힌다. 버킷을 새로 만들지 않는 이유는 스택이 만든
#     버킷의 수명주기·암호화 설정을 그대로 물려받는 쪽이 안전하기 때문이다.
#     예전 storage.s3 경로에는 접두어 설정이 없어 버킷 루트에 바로 쓴다.
#
#   Alloy (Promtail 아님)
#     Promtail 은 2026-03-02 에 EOL 이다. 같은 일을 하는 후속이 Alloy 다.
#     loki.source.file 로 /var/log/pods 를 직접 읽는다. loki.source.kubernetes
#     (API 경유)를 쓰지 않는 이유는 kubelet API 로 모든 파드 로그를 스트리밍하면
#     apiserver 부하가 커지고, 파드가 지워지는 순간 꼬리가 잘릴 수 있기 때문이다.
#
#   auth_enabled=false
#     단일 테넌트다. 멀티테넌시를 켜면 Alloy·Grafana 양쪽에 X-Scope-OrgID 를
#     넣어야 하는데 얻는 것이 없다. 네트워크 경계는 ClusterIP 로 유지한다
#     — Loki 는 ALB·CloudFront 에 붙이지 않고 Grafana 를 통해서만 조회한다.
#
# 사용법:
#   ./scripts/eks/install-logs.sh [--cluster <eks-cluster-name>] [--yes]
#                                 [--retention-days <n>]
#
# 사전 조건:
#   - ./scripts/eks/install-dashboard-public.sh  (Grafana + ALB)
#   - ./scripts/eks/install-mlflow-selfhosted.sh (gp3 StorageClass — Loki WAL 용)
#   - kubectl / helm / jq / aws
#
# 제거: ./scripts/eks/delete-logs.sh
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
NAMESPACE="logging"
MONITORING_NAMESPACE="monitoring"
LOKI_CHART_VERSION="7.3.0"
ALLOY_CHART_VERSION="1.13.1"
GRAFANA_CHART_VERSION="10.5.15"
SYSTEM_INSTANCE_TYPE="ml.c5.4xlarge"
S3_PREFIX="loki"
WAL_SIZE="20Gi"

CLUSTER_NAME=""
ASSUME_YES="false"
RETENTION_DAYS="30"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "--retention-days 는 숫자여야 합니다." >&2; exit 1; }
RETENTION_HOURS="$((RETENTION_DAYS * 24))h"

for tool in kubectl helm jq aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"
LOKI_ROLE="${CLUSTER_NAME}-loki"

aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 || {
  echo "EKS 클러스터 '${CLUSTER_NAME}' 을 ${REGION} 에서 찾지 못했습니다." >&2
  exit 1
}
helm status grafana -n "$MONITORING_NAMESPACE" >/dev/null 2>&1 || {
  echo "Grafana 가 없습니다. 먼저 ./scripts/eks/install-dashboard-public.sh 를 실행하세요." >&2
  exit 1
}
# Loki 는 WAL 과 로컬 인덱스 캐시를 PVC 에 둔다. gp3 는 mlflow 스크립트가 만든다.
kubectl get storageclass gp3 >/dev/null 2>&1 || {
  echo "gp3 StorageClass 가 없습니다. 먼저 ./scripts/eks/install-mlflow-selfhosted.sh 를 실행하세요." >&2
  exit 1
}

S3_BUCKET="${S3_BUCKET:-$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='S3BucketName'].OutputValue | [0]" --output text 2>/dev/null || true)}"
[[ -n "$S3_BUCKET" && "$S3_BUCKET" != "None" ]] || {
  echo "스택 ${STACK} 의 S3BucketName Output 을 읽지 못했습니다. S3_BUCKET 으로 직접 넘기세요." >&2
  exit 1
}

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION})
생성 대상  : Loki ${LOKI_CHART_VERSION} SingleBinary (namespace ${NAMESPACE}, gp3 ${WAL_SIZE})
             IAM 역할 ${LOKI_ROLE} + pod identity (${NAMESPACE}/loki)
             Grafana Alloy ${ALLOY_CHART_VERSION} DaemonSet (노드마다 1개)
             Grafana 데이터소스 'Loki'
로그 저장  : s3://${S3_BUCKET}/${S3_PREFIX}/   (보관 ${RETENTION_DAYS}일)
상시 비용  : gp3 ${WAL_SIZE} 약 \$1.8/월 + S3 저장량 (학습 로그는 월 센트 단위)
외부 노출  : 없음. Loki 는 ClusterIP 이고 Grafana 를 통해서만 조회합니다.
기존 Grafana 데이터소스(Prometheus, MLflow)는 유지됩니다.

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# -----------------------------------------------------------------------------
# 1. IAM + pod identity
#    HyperPod EKS 의 파드는 노드 역할을 상속하지 않고 IMDS 도 막혀 있다.
#    pod identity 가 S3 자격증명의 유일한 경로다.
#    권한은 loki/ 접두어 아래로만 준다. 같은 버킷의 mlflow-artifacts/ 는 못 만진다.
#    ListBucket 은 객체가 아니라 버킷에 대한 동작이라 버킷 ARN 에 줘야 하고,
#    s3:prefix 조건으로 다른 접두어를 들여다보지 못하게 막는다.
# -----------------------------------------------------------------------------
echo "[1/4] IAM 역할 + pod identity"
POD_TRUST='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "pods.eks.amazonaws.com" },
    "Action": ["sts:AssumeRole", "sts:TagSession"]
  }]
}'
if ! aws iam get-role --role-name "$LOKI_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$LOKI_ROLE" \
    --assume-role-policy-document "$POD_TRUST" >/dev/null
  echo "  IAM 역할 생성: ${LOKI_ROLE}"
fi
aws iam put-role-policy --role-name "$LOKI_ROLE" --policy-name s3-logs \
  --policy-document "$(jq -nc --arg b "$S3_BUCKET" --arg p "$S3_PREFIX" '{
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject","s3:PutObject","s3:DeleteObject"],
        Resource: "arn:aws:s3:::\($b)/\($p)/*"
      },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket","s3:GetBucketLocation"],
        Resource: "arn:aws:s3:::\($b)",
        Condition: { StringLike: { "s3:prefix": ["\($p)", "\($p)/*"] } }
      }
    ]
  }')"
if ! aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
     --namespace "$NAMESPACE" --service-account loki \
     --query 'associations[0].associationId' --output text 2>/dev/null | grep -qv '^None$'; then
  aws eks create-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --namespace "$NAMESPACE" --service-account loki \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${LOKI_ROLE}" >/dev/null
  echo "  pod identity 연결: ${NAMESPACE}/loki"
fi

# -----------------------------------------------------------------------------
# 2. Loki
#    - access_key_id / secret_access_key 를 비워 두면 SDK 기본 자격증명 체인을
#      쓴다. pod identity 가 주입하는 자격증명이 그 체인에 들어온다.
#    - retention_enabled : compactor 가 보관 기간이 지난 chunk 를 S3 에서 지운다.
#      이 설정이 없으면 S3 에 영원히 쌓인다.
#    - reject_old_samples_max_age : 기본 168h 면 그보다 오래된 줄이 버려진다.
#      보관 기간과 같게 맞춰 둔다.
#    - gateway / cache / canary 는 끈다. nginx 게이트웨이는 파드를 여러 개로
#      나눌 때 필요하고, memcached 2종은 파드 4개를 더 띄운다. 조회량이 적어
#      이득이 없다.
#    - 배치 모드별 replicas 를 0 으로 눌러 둔다. 차트 기본값이 SimpleScalable
#      이라 지정하지 않으면 read/write/backend 가 함께 올라온다.
# -----------------------------------------------------------------------------
echo "[2/4] Loki"
LOKI_VALUES="$(mktemp)"
trap 'rm -f "$LOKI_VALUES"' EXIT
chmod 600 "$LOKI_VALUES"
cat > "$LOKI_VALUES" <<EOF
deploymentMode: SingleBinary
serviceAccount:
  create: true
  name: loki
loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  schemaConfig:
    configs:
      - from: "2024-04-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h
  storage:
    type: s3
    bucketNames:
      chunks: ${S3_BUCKET}
      ruler: ${S3_BUCKET}
    use_thanos_objstore: true
    object_store:
      type: s3
      storage_prefix: ${S3_PREFIX}
      s3:
        bucket_name: ${S3_BUCKET}
        region: ${REGION}
        # endpoint 를 비워 두면 기동이 'no s3 endpoint in config file' 로 막힌다.
        # thanos objstore 의 S3 provider 는 endpoint 를 필수값으로 검증하고
        # initRulerStorage 단계에서 바로 죽는다. 예전 storage.s3 클라이언트는
        # region 으로 엔드포인트를 스스로 만들었지만 이쪽은 그러지 않는다.
        endpoint: s3.${REGION}.amazonaws.com
  compactor:
    retention_enabled: true
    delete_request_store: s3
  limits_config:
    retention_period: ${RETENTION_HOURS}
    reject_old_samples: true
    reject_old_samples_max_age: ${RETENTION_HOURS}
    allow_structured_metadata: true
    volume_enabled: true
singleBinary:
  replicas: 1
  nodeSelector:
    node.kubernetes.io/instance-type: ${SYSTEM_INSTANCE_TYPE}
  persistence:
    enabled: true
    storageClass: gp3
    size: ${WAL_SIZE}
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      memory: 2Gi
backend:
  replicas: 0
read:
  replicas: 0
write:
  replicas: 0
ingester:
  replicas: 0
querier:
  replicas: 0
queryFrontend:
  replicas: 0
queryScheduler:
  replicas: 0
distributor:
  replicas: 0
compactor:
  replicas: 0
indexGateway:
  replicas: 0
bloomPlanner:
  replicas: 0
bloomBuilder:
  replicas: 0
bloomGateway:
  replicas: 0
gateway:
  enabled: false
chunksCache:
  enabled: false
resultsCache:
  enabled: false
lokiCanary:
  enabled: false
test:
  enabled: false
minio:
  enabled: false
EOF

helm upgrade --install loki grafana/loki \
  --version "$LOKI_CHART_VERSION" \
  --namespace "$NAMESPACE" \
  -f "$LOKI_VALUES" \
  --wait --timeout 15m >/dev/null
rm -f "$LOKI_VALUES"
echo "  Loki SingleBinary 기동 (보관 ${RETENTION_DAYS}일 → s3://${S3_BUCKET}/${S3_PREFIX}/)"

# -----------------------------------------------------------------------------
# 3. Alloy
#    discovery.kubernetes 로 파드를 찾고, __path__ 를 /var/log/pods 의 실제 경로로
#    바꿔 loki.source.file 이 파일을 직접 읽게 한다.
#
#    라벨은 적게 가져간다. Loki 는 라벨 조합마다 스트림을 하나씩 만들고, 스트림이
#    많아지면 인덱스가 커지고 쿼리가 느려진다. 그래서 namespace / job_name /
#    container / cluster 만 라벨로 올리고 파드 이름은 structured metadata 로
#    내려 둔다. job_name 은 Job 이 파드에 붙이는 job-name 라벨이다. 학습 한 번 =
#    한 값이라 '어제 돌린 그 학습' 을 찾는 기준이 된다.
#
#    루트로 돌려야 한다. /var/log/pods 아래 심볼릭 링크가 가리키는 실제 파일은
#    root 소유다.
#
#    config.alloy 의 주석은 '//' 다. '#' 을 쓰면 파서가 ILLEGAL 로 보고
#    "could not perform the initial load successfully" 로 기동이 막힌다.
#    셸·YAML 주석과 섞이는 자리라 눈에 잘 띄지 않는다.
# -----------------------------------------------------------------------------
echo "[3/4] Alloy (로그 수집)"
ALLOY_VALUES="$(mktemp)"
trap 'rm -f "$ALLOY_VALUES"' EXIT
chmod 600 "$ALLOY_VALUES"
cat > "$ALLOY_VALUES" <<EOF
controller:
  type: daemonset
alloy:
  securityContext:
    runAsUser: 0
    runAsGroup: 0
  mounts:
    varlog: true
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      memory: 512Mi
  configMap:
    content: |
      logging {
        level  = "info"
        format = "logfmt"
      }

      discovery.kubernetes "pods" {
        role = "pod"
      }

      discovery.relabel "pod_logs" {
        targets = discovery.kubernetes.pods.targets

        rule {
          source_labels = ["__meta_kubernetes_namespace"]
          action        = "replace"
          target_label  = "namespace"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_container_name"]
          action        = "replace"
          target_label  = "container"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_label_job_name"]
          action        = "replace"
          target_label  = "job_name"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_name"]
          action        = "replace"
          target_label  = "pod"
        }

        // kubelet 이 로그를 두는 실제 경로. 이 라벨이 loki.source.file 의 입력이다.
        rule {
          source_labels = ["__meta_kubernetes_pod_uid", "__meta_kubernetes_pod_container_name"]
          action        = "replace"
          target_label  = "__path__"
          separator     = "/"
          replacement   = "/var/log/pods/*\$1/*.log"
        }
      }

      // loki.source.file 은 __path__ 를 그대로 stat 한다. glob 을 풀어 주는 것이
      // local.file_match 다. 빼면 전 타겟이 'stat failed: no such file or
      // directory' 로 떨어지고 파드는 Ready 인데 로그가 한 줄도 안 들어온다.
      // (promtail 은 glob 을 자체 처리했다. Alloy 는 역할이 쪼개져 있다.)
      local.file_match "pod_logs" {
        path_targets = discovery.relabel.pod_logs.output
      }

      loki.source.file "pod_logs" {
        targets    = local.file_match.pod_logs.targets
        forward_to = [loki.process.pod_logs.receiver]
      }

      loki.process "pod_logs" {
        // kubelet 이 쓰는 CRI 형식: '<RFC3339Nano> <stdout|stderr> <F|P> <본문>'
        // 벗겨 내지 않으면 LogQL 검색이 타임스탬프 접두어까지 보게 된다.
        stage.cri {}

        // 파드 이름은 라벨에서 빼고 structured metadata 로 내린다. 파드 이름은
        // 매번 달라서 라벨로 두면 스트림이 끝없이 늘어난다. metadata 로도
        // pod="..." 필터는 그대로 된다.
        stage.structured_metadata {
          values = {
            pod = "",
          }
        }
        // filename 은 local.file_match 가 붙인다. 파드마다 달라서 pod 와 같은
        // 이유로 라벨에서 뺀다.
        stage.label_drop {
          values = ["pod", "filename"]
        }

        stage.static_labels {
          values = {
            cluster = "${CLUSTER_NAME}",
          }
        }

        forward_to = [loki.write.default.receiver]
      }

      loki.write "default" {
        endpoint {
          url = "http://loki.${NAMESPACE}.svc.cluster.local:3100/loki/api/v1/push"
        }
      }
EOF

helm upgrade --install alloy grafana/alloy \
  --version "$ALLOY_CHART_VERSION" \
  --namespace "$NAMESPACE" \
  -f "$ALLOY_VALUES" \
  --wait --timeout 10m >/dev/null
rm -f "$ALLOY_VALUES"
kubectl rollout status daemonset/alloy -n "$NAMESPACE" --timeout 5m
echo "  Alloy DaemonSet 기동"

# -----------------------------------------------------------------------------
# 4. Grafana 데이터소스
#    helm get values 로 현재 값을 읽어 Loki 항목만 더한다. install-dashboard-public.sh
#    가 넣은 Prometheus 와 install-unified-dashboard.sh 가 넣은 MLflow 를 보존해야
#    하기 때문이다. jq 의 * 는 배열을 덮어쓰므로 datasources 배열만 따로 이어붙인다.
# -----------------------------------------------------------------------------
echo "[4/4] Grafana 데이터소스"
VALUES="$(mktemp)"
OVERLAY="$(mktemp)"
trap 'rm -f "$VALUES" "$OVERLAY"' EXIT
chmod 600 "$VALUES" "$OVERLAY"

helm get values grafana -n "$MONITORING_NAMESPACE" -o json > "$VALUES"

jq -n --arg ns "$NAMESPACE" '{
  datasources: {
    "datasources.yaml": {
      apiVersion: 1,
      datasources: [{
        name: "Loki",
        uid: "loki",
        type: "loki",
        access: "proxy",
        url: "http://loki.\($ns).svc.cluster.local:3100",
        isDefault: false,
        jsonData: { maxLines: 5000, timeout: 300 }
      }]
    }
  }
}' > "$OVERLAY"

MERGED="$(jq -s '
  .[0] as $cur | .[1] as $new |
  ($cur * $new) |
  .datasources."datasources.yaml".datasources =
    (($cur.datasources."datasources.yaml".datasources // [])
     | map(select(.uid != "loki")))
    + $new.datasources."datasources.yaml".datasources
' "$VALUES" "$OVERLAY")"
printf '%s' "$MERGED" > "$VALUES"

helm upgrade grafana grafana/grafana \
  --version "$GRAFANA_CHART_VERSION" \
  --namespace "$MONITORING_NAMESPACE" \
  -f "$VALUES" \
  --wait --timeout 10m >/dev/null
rm -f "$VALUES" "$OVERLAY"
echo "  Loki 데이터소스 등록"

# 데이터소스가 실제로 응답하는지 Grafana 안에서 확인한다. 밖에서 Loki 를 직접
# 찔러도 Grafana 가 쓰는 경로가 맞는지는 알 수 없다.
GF_PASS="$(kubectl get secret grafana -n "$MONITORING_NAMESPACE" \
  -o jsonpath='{.data.admin-password}' | base64 -d)"
DS_OK="unreachable"
for _ in $(seq 1 24); do
  DS_OK="$(kubectl exec -n "$MONITORING_NAMESPACE" deploy/grafana -c grafana -- \
    env GF_PASS="$GF_PASS" sh -c \
    'curl -sf -u "admin:${GF_PASS}" "http://localhost:3000/api/datasources/uid/loki/resources/labels"' \
    2>/dev/null | jq -r '.status // "none"' 2>/dev/null || echo "unreachable")"
  [[ "$DS_OK" == "success" ]] && break
  sleep 5
done
if [[ "$DS_OK" == "success" ]]; then
  echo "  데이터소스 조회 확인"
else
  echo "  데이터소스가 아직 응답하지 않습니다 (${DS_OK}). 로그가 들어오면 해소됩니다:"
  echo "    kubectl logs -n ${NAMESPACE} sts/loki --tail 50"
fi

CF_DOMAIN="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CLUSTER_NAME}-dashboard'].DomainName | [0]" \
  --output text 2>/dev/null || true)"

cat <<EOF

완료.

  Grafana  : https://${CF_DOMAIN:-<cloudfront-도메인>}/explore
             좌측 상단 데이터소스에서 'Loki' 를 고르세요.
  보관      : ${RETENTION_DAYS}일 (s3://${S3_BUCKET}/${S3_PREFIX}/)

끝난 학습의 로그를 찾는 질의입니다. job_name 은 render.sh 가 붙인 Job 이름입니다.

  {namespace="rl"}                                학습 네임스페이스 전체
  {namespace="rl", job_name="mujoco-rl-10171951"} 특정 학습 한 번
  {namespace="rl"} |= "Iteration"                 학습 진행 줄만
  {namespace="rl"} |= "Traceback"                 실패 원인 찾기
  {namespace="argo"}                              포탈이 제출한 Workflow 쪽 로그

라벨은 namespace / job_name / container / cluster 네 개만 인덱스로 올립니다.
파드 이름은 structured metadata 라서 pod="..." 로도 필터되지만 인덱스는 늘지
않습니다. 라벨을 더 늘리면 스트림 수가 폭증해 쿼리가 느려집니다.

보관 기간을 바꾸려면 다시 실행하세요. 이미 쌓인 것에도 적용됩니다.

  ./scripts/eks/install-logs.sh --retention-days 7

제거: ./scripts/eks/delete-logs.sh
EOF
