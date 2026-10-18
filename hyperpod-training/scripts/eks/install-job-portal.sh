#!/usr/bin/env bash
# =============================================================================
# install-job-portal.sh — 대시보드를 읽기 전용에서 벗어나게 한다. Argo Workflows 를
#                         깔고 /argo 에 붙여, 브라우저에서 학습 Job 을 제출하고
#                         로그를 보고 중단할 수 있게 만든다.
#
#   인터넷
#     └─ CloudFront (install-dashboard-public.sh 가 만든 배포 1개)
#          └─ ALB (IngressGroup hyperpod-dashboard)
#               ├─ /argo        → argo-proxy → Argo Server (이 스크립트, order 30)
#               ├─ /mlflow      → MLflow           (install-mlflow-selfhosted.sh, order 10)
#               ├─ /tensorboard → TensorBoard      (install-mlflow-selfhosted.sh, order 20)
#               └─ /            → Grafana          (install-dashboard-public.sh, order 100)
#
# ─── /argo 접두어를 떼는 프록시가 왜 필요한가 ───
#   Argo 서버의 --base-href(ARGO_BASE_HREF)는 서버가 응답하는 HTML 안의 자산 경로만
#   고쳐 쓴다. 들어오는 요청 경로에서 접두어를 떼지는 않는다. 실제로 v4.1.5 를 직접
#   찔러 확인했다.
#     GET /api/v1/version       → 200 {"version":"v4.1.5",...}
#     GET /argo/api/v1/version  → 200 <!doctype html>   (SPA 로 흘러간다)
#   즉 API 는 루트에만 있고 /argo/* 는 전부 UI 라우트로 처리된다. 그래서 프록시가
#   접두어를 떼어 줘야 UI 가 자기 API 를 호출할 수 있다.
#
#   ALB 는 경로 재작성을 지원하지 않는다(ingress-nginx 의 rewrite-target 같은 기능이
#   AWS Load Balancer Controller 에는 없다). CloudFront Function 으로 떼는 방법도
#   막힌다 — 접두어를 떼면 ALB 에 /api/v1/* 로 도착하고, 그러면 order 100 의 Grafana
#   catch-all 에 먹힌다. 접두어는 ALB 의 경로 라우팅이 끝난 뒤에 떼야 한다.
#
#   그래서 nginx 파드 하나를 Argo 서버 앞에 둔다. ALB 는 /argo 를 argo-proxy 로
#   보내고, nginx 가 접두어를 떼서 argo-workflows-server:2746 으로 넘긴다.
#
# ─── 기존 자산을 건드리지 않는 방식 ───
#   k8s-templates/*.yaml 과 render.sh 는 모듈 9~11 가이드가 그대로 가리킨다.
#   그래서 한 줄도 고치지 않고 사본을 ConfigMap job-templates 에 넣고, 워크플로의
#   render 단계가 그 사본에서 render.sh 를 돌려 Job YAML 을 만든다. UI 제출과
#   가이드의 CLI 명령이 같은 템플릿·같은 치환 규칙을 쓴다.
#
#   ConfigMap 은 하위 디렉터리를 못 담으므로 파일명을 평탄화해서 넣는다
#   (rl/isaaclab-train-job.yaml → rl_isaaclab-train-job.yaml). 워크플로가
#   원래 경로로 되살린다. 템플릿을 고치면 이 스크립트를 다시 돌려 사본을 갱신한다.
#
# ─── 인증 ───
#   지금은 ServiceAccount 토큰이다. 설치 후 출력되는 토큰을 UI 로그인 창에 넣는다.
#   토큰 하나를 팀이 공유하므로 "누가 제출했는지"는 아직 구분되지 않는다. 사용자별
#   신원은 Cognito SSO 를 붙이는 별도 작업에서 다룬다.
#
#   그래서 이 스크립트는 토큰을 파일로 저장하지 않고 화면에만 출력한다.
#   다시 보려면 아래 명령을 쓴다(같은 토큰이 다시 나온다):
#     kubectl get secret argo-admin.service-account-token -n argo \
#       -o jsonpath='{.data.token}' | base64 -d
#
# ─── 전제 ───
#   install-dashboard-public.sh 완료 (ALB IngressGroup hyperpod-dashboard + CloudFront)
#   kubectl 이 해당 클러스터를 가리킴 (./scripts/eks/kubeconfig.sh)
#
# 사용법:
#   ./scripts/eks/install-job-portal.sh [--cluster <eks-cluster-name>] [--yes]
#
# 상시 비용: 없다. 컨트롤러·서버 파드가 시스템 노드 자원을 조금 쓰는 것이 전부다
#           (ALB·WAF·CloudFront 는 install-dashboard-public.sh 쪽에 이미 포함).
#
# 멱등하다. 다시 돌리면 차트를 업그레이드하고 템플릿 사본을 갱신한다.
#
# 제거: ./scripts/eks/delete-job-portal.sh
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
NAMESPACE="argo"
ARGO_CHART_VERSION="2.0.13"            # argo/argo-workflows — appVersion v4.1.5
RENDER_IMAGE="public.ecr.aws/docker/library/alpine:3.21"
PROXY_IMAGE="public.ecr.aws/nginx/nginx:1.27-alpine-slim"   # /argo 접두어 제거용
WORKFLOW_SA="argo-workflow"            # 워크플로 파드가 쓰는 SA (차트가 만든다)
ADMIN_SA="argo-admin"                  # UI 로그인 토큰을 발급할 SA
CF_PREFIX_LIST="pl-22a6434b"           # com.amazonaws.global.cloudfront.origin-facing (ap-northeast-2)
INGRESS_GROUP="hyperpod-dashboard"     # install-dashboard-public.sh 가 만든 그룹에 합류한다
INGRESS_ORDER="30"                     # Grafana 가 100 에서 '/' 를 받으므로 더 낮아야 한다

CLUSTER_NAME=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

for tool in kubectl helm aws envsubst; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATES_DIR="${HERE}/k8s-templates"
ARGO_ASSETS="${HERE}/eks/argo/workflow-templates.yaml"
[[ -f "$ARGO_ASSETS" ]] || { echo "찾을 수 없습니다: ${ARGO_ASSETS}" >&2; exit 1; }
[[ -f "${TEMPLATES_DIR}/render.sh" ]] || { echo "찾을 수 없습니다: ${TEMPLATES_DIR}/render.sh" >&2; exit 1; }

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"

aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 || {
  echo "EKS 클러스터 '${CLUSTER_NAME}' 을 ${REGION} 에서 찾지 못했습니다." >&2
  exit 1
}

# ALB 와 CloudFront 가 먼저 있어야 한다. CloudFront 도메인은 완료 안내에 쓴다.
ALB_DNS="$(kubectl get ingress -A \
  -o jsonpath="{range .items[?(@.metadata.annotations['alb\.ingress\.kubernetes\.io/group\.name']=='${INGRESS_GROUP}')]}{.status.loadBalancer.ingress[0].hostname}{'\n'}{end}" \
  2>/dev/null | grep -m1 . || true)"
[[ -n "$ALB_DNS" ]] || {
  echo "IngressGroup '${INGRESS_GROUP}' 의 ALB 를 찾지 못했습니다." >&2
  echo "먼저 ./scripts/eks/install-dashboard-public.sh 를 실행하세요." >&2
  exit 1
}
CF_DOMAIN="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CLUSTER_NAME}-dashboard'].DomainName | [0]" \
  --output text 2>/dev/null || true)"
[[ -n "$CF_DOMAIN" && "$CF_DOMAIN" != "None" ]] || {
  echo "CloudFront 배포(Comment=${CLUSTER_NAME}-dashboard)를 찾지 못했습니다." >&2
  echo "먼저 ./scripts/eks/install-dashboard-public.sh 를 실행하세요." >&2
  exit 1
}

RENDER_ROLE="${CLUSTER_NAME}-argo-render"

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION})
붙는 곳    : https://${CF_DOMAIN}/argo
생성 대상  : argo-workflows 차트 ${ARGO_CHART_VERSION} (v4.1.5) — namespace ${NAMESPACE}
             WorkflowTemplate 5개 (준비·학습·검증·재생)
             ConfigMap job-templates — k8s-templates 사본 (원본은 수정하지 않는다)
             ServiceAccount ${ADMIN_SA} + 만료 없는 로그인 토큰 Secret
             IAM 역할 ${RENDER_ROLE} + pod identity (${NAMESPACE}/${WORKFLOW_SA})
             argo-proxy (nginx 1개) — /argo 접두어를 떼서 서버로 넘긴다
             Ingress 1개 — ${INGRESS_GROUP} 그룹에 /argo (order ${INGRESS_ORDER}) 추가
             ClusterRole ${CLUSTER_NAME}-argo-job-submit (Job 제출 권한)
상시 비용  : 없음 (파드 자원만. ALB·CloudFront 는 대시보드 쪽에 이미 포함)
기존 리소스는 변경하지 않습니다.

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

# -----------------------------------------------------------------------------
# 1. Argo Workflows
#    authModes 에 client 를 두면 UI 가 토큰을 묻는다. server 를 함께 두면 토큰 없이
#    들어올 수 있으므로 client 만 둔다.
#
#    secure=false 로 평문 HTTP 를 쓴다. ALB 가 HTTP 로 타깃에 붙기 때문이고,
#    ALB 앞은 CloudFront HTTPS 로 감싸인다.
#
#    base-href 를 /argo/ 로 주면 서버가 응답하는 HTML 의 자산 경로가 /argo/ 로
#    시작한다. 트레일링 슬래시가 빠지면 UI 가 자산을 못 찾는다. 다만 base-href 는
#    자산 경로만 고치고 들어오는 요청의 접두어는 떼지 않으므로, 접두어 제거는
#    6 번의 nginx 프록시가 맡는다 (맨 위 설명 참고).
#
#    workflowNamespaces 는 argo 만 둔다. 워크플로 자체는 argo 에서 돌고, 그 워크플로가
#    만드는 Job 은 다른 네임스페이스로 가므로 그 권한은 3 번에서 따로 붙인다.
# -----------------------------------------------------------------------------
echo "[1/7] Argo Workflows 차트"
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update argo >/dev/null 2>&1 || true
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

helm upgrade --install argo-workflows argo/argo-workflows \
  --version "$ARGO_CHART_VERSION" \
  --namespace "$NAMESPACE" \
  --set "controller.workflowNamespaces[0]=${NAMESPACE}" \
  --set workflow.serviceAccount.create=true \
  --set "workflow.serviceAccount.name=${WORKFLOW_SA}" \
  --set workflow.rbac.create=true \
  --set "server.authModes[0]=client" \
  --set server.secure=false \
  --set-string "server.baseHref=/argo/" \
  --wait --timeout 10m >/dev/null
echo "  설치 완료 (base-href /argo/, 토큰 로그인)"

# -----------------------------------------------------------------------------
# 2. k8s-templates 사본
#    --from-file 은 파일명을 키로 쓰므로 디렉터리를 평탄화한다. 워크플로의 render
#    단계가 rl_ / setup_ 접두어를 보고 원래 경로를 복원한다.
#    render.sh 를 그대로 넣는 것이 핵심이다 — 치환 규칙의 단일 출처를 유지한다.
# -----------------------------------------------------------------------------
echo "[2/7] k8s-templates 사본 → ConfigMap job-templates"
CM_ARGS=(--from-file="render.sh=${TEMPLATES_DIR}/render.sh"
         --from-file="fsx-pvc.yaml=${TEMPLATES_DIR}/fsx-pvc.yaml")
for f in "${TEMPLATES_DIR}"/rl/*.yaml; do
  CM_ARGS+=(--from-file="rl_$(basename "$f")=${f}")
done
for f in "${TEMPLATES_DIR}"/setup/*.yaml; do
  CM_ARGS+=(--from-file="setup_$(basename "$f")=${f}")
done
kubectl create configmap job-templates -n "$NAMESPACE" "${CM_ARGS[@]}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "  ${#CM_ARGS[@]}개 파일 (원본은 그대로)"

# -----------------------------------------------------------------------------
# 3. 워크플로 권한
#    render 단계가 하는 일: 네임스페이스 확인·생성, mlflow-credentials 읽기·복사.
#    submit 단계가 하는 일: Job 생성과 상태 조회, PV/PVC apply.
#    차트가 만든 Role 은 argo 네임스페이스 안에서만 유효하므로, Job 네임스페이스와
#    클러스터 범위 리소스(PV, Namespace)에 대한 권한을 여기서 더한다.
# -----------------------------------------------------------------------------
echo "[3/7] 워크플로 권한"
kubectl apply -f - >/dev/null <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${CLUSTER_NAME}-argo-job-submit
rules:
  # fsx-pvc.yaml 의 PersistentVolume 과 네임스페이스 생성은 클러스터 범위다.
  - apiGroups: [""]
    resources: ["persistentvolumes", "namespaces"]
    verbs: ["get", "list", "create", "patch", "update"]
  # render 단계가 mlflow 네임스페이스에서 자격증명을 읽어 Job 네임스페이스로 옮긴다.
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "patch", "update"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "create", "patch", "update"]
  # submit 단계가 Job 을 만들고 successCondition 을 평가하기 위해 상태를 읽는다.
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "create", "delete"]
  # Logs 탭이 Job 파드의 로그를 끌어온다.
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  # 파드가 Pending 으로 머무를 때 submit 단계가 그 이유(FailedScheduling 등)를
  # 읽어 로그에 보여 준다. 이 권한이 없으면 원인을 못 보고 그냥 기다리게 된다.
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${CLUSTER_NAME}-argo-job-submit
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${CLUSTER_NAME}-argo-job-submit
subjects:
  - kind: ServiceAccount
    name: ${WORKFLOW_SA}
    namespace: ${NAMESPACE}
EOF
echo "  ClusterRole ${CLUSTER_NAME}-argo-job-submit → ${NAMESPACE}/${WORKFLOW_SA}"

# -----------------------------------------------------------------------------
# 4. pod identity — render 단계의 AWS 호출용
#    render.sh 는 fsx-pvc.yaml 을 렌더할 때 HyperPodEks 스택 Output 에서 FSx 값을
#    읽고, 자체 호스팅 MLflow 가 없으면 MlflowTrackingUri Output 도 읽는다.
#    둘 다 describe-stacks 한 번이면 되므로 권한을 그 호출과 해당 스택으로 좁힌다.
# -----------------------------------------------------------------------------
echo "[4/7] pod identity (render 단계의 스택 Output 조회)"
if ! aws iam get-role --role-name "$RENDER_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$RENDER_ROLE" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "pods.eks.amazonaws.com"},
        "Action": ["sts:AssumeRole", "sts:TagSession"]
      }]
    }' >/dev/null
  echo "  역할 생성: ${RENDER_ROLE}"
else
  echo "  역할 이미 존재: ${RENDER_ROLE}"
fi
aws iam put-role-policy --role-name "$RENDER_ROLE" --policy-name describe-stack \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"cloudformation:DescribeStacks\"],
      \"Resource\": \"arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/${STACK}/*\"
    }]
  }" >/dev/null

# pod identity 연결은 제자리 수정이 안 된다. 이미 있으면 그대로 둔다.
ASSOC_ID="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" \
  --region "$REGION" --namespace "$NAMESPACE" --service-account "$WORKFLOW_SA" \
  --query 'associations[0].associationId' --output text 2>/dev/null || true)"
if [[ -z "$ASSOC_ID" || "$ASSOC_ID" == "None" ]]; then
  aws eks create-pod-identity-association --cluster-name "$CLUSTER_NAME" \
    --region "$REGION" --namespace "$NAMESPACE" --service-account "$WORKFLOW_SA" \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${RENDER_ROLE}" >/dev/null
  echo "  연결 생성: ${NAMESPACE}/${WORKFLOW_SA}"
else
  echo "  연결 이미 존재: ${ASSOC_ID}"
fi

# -----------------------------------------------------------------------------
# 5. WorkflowTemplate + 로그인 토큰 SA
# -----------------------------------------------------------------------------
echo "[5/7] WorkflowTemplate + 로그인 계정"
ARGO_NAMESPACE="$NAMESPACE" WORKFLOW_SA="$WORKFLOW_SA" RENDER_IMAGE="$RENDER_IMAGE" \
  envsubst '${ARGO_NAMESPACE} ${WORKFLOW_SA} ${RENDER_IMAGE}' < "$ARGO_ASSETS" \
  | kubectl apply -f - >/dev/null
echo "  WorkflowTemplate $(kubectl get workflowtemplate -n "$NAMESPACE" \
      -l app.kubernetes.io/part-of=hyperpod-job-portal --no-headers 2>/dev/null | wc -l)개"

# UI 토큰용 SA. 차트가 만든 argo-server ClusterRole 을 그대로 붙여, 서버가 할 수
# 있는 일을 토큰 소지자도 할 수 있게 한다 (제출·중단·로그 조회).
SERVER_CLUSTERROLE="$(kubectl get clusterrole -o name 2>/dev/null \
  | sed 's|clusterrole.rbac.authorization.k8s.io/||' \
  | grep -m1 -E '^argo-workflows(-server)?$' || true)"
[[ -n "$SERVER_CLUSTERROLE" ]] || {
  echo "argo-server 의 ClusterRole 을 찾지 못했습니다. 차트 설치를 확인하세요." >&2
  exit 1
}
kubectl create serviceaccount "$ADMIN_SA" -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f - >/dev/null <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${CLUSTER_NAME}-argo-ui
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${SERVER_CLUSTERROLE}
subjects:
  - kind: ServiceAccount
    name: ${ADMIN_SA}
    namespace: ${NAMESPACE}
EOF

# 토큰은 Secret 으로 받는다. 'kubectl create token --duration' 은 API 서버의
# 최대 수명(기본 24h)으로 깎인다 — 8760h 를 요청해도 86400 초만 나온다. 상시
# 환경에서 매일 재발급하는 것은 쓸 수 없으므로, Argo 문서가 안내하는 만료 없는
# ServiceAccount 토큰 Secret 을 쓴다.
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${ADMIN_SA}.service-account-token
  namespace: ${NAMESPACE}
  annotations:
    kubernetes.io/service-account.name: ${ADMIN_SA}
type: kubernetes.io/service-account-token
EOF
echo "  로그인 계정: ${NAMESPACE}/${ADMIN_SA} (ClusterRole ${SERVER_CLUSTERROLE})"

# -----------------------------------------------------------------------------
# 6. argo-proxy — /argo 접두어 제거
#    ALB 가 /argo 로 보낸 요청에서 접두어를 떼어 argo-workflows-server 로 넘긴다.
#    왜 이게 필요한지는 맨 위 설명에 있다 (base-href 는 자산 경로만 고친다).
#
#    proxy_pass 뒤에 '/' 를 붙이는 것이 핵심이다. location 에 걸린 부분을 그 값으로
#    바꿔치기하므로 /argo/api/v1/version → /api/v1/version 이 된다. '/' 를 빼면
#    경로가 그대로 전달되어 지금의 증상이 되돌아온다.
#
#    /argo 와 /argo/ 를 모두 받아야 한다. 접두어만 입력하면 nginx 는 location 과
#    정확히 같은 '/argo' 를 받는데, 그때는 뒤에 뗄 슬래시가 없다. 그래서 그 한 건만
#    /argo/ 로 리다이렉트한다.
#
#    로그 스트리밍(Logs 탭)은 서버가 응답을 흘려보내는 방식이므로 버퍼링을 끈다.
#    끄지 않으면 Job 이 끝날 때까지 로그가 한 번에 몰려 나온다.
# -----------------------------------------------------------------------------
echo "[6/7] argo-proxy (/argo 접두어 제거)"
PROXY_CONF="$(cat <<EOF
server {
  listen 8080;

  # ALB 헬스체크. 업스트림을 깨우지 않고 바로 답한다.
  location = /healthz {
    access_log off;
    return 200 "ok\n";
  }

  # 접두어만 온 경우에는 뗄 슬래시가 없다. 한 번 리다이렉트해 /argo/ 로 맞춘다.
  location = /argo {
    return 302 /argo/;
  }

  location /argo/ {
    proxy_pass http://argo-workflows-server.${NAMESPACE}.svc.cluster.local:2746/;
    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade           \$http_upgrade;
    proxy_set_header Connection        "upgrade";

    # 로그 스트리밍이 실시간으로 흐르도록 버퍼링을 끈다.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
EOF
)"
PROXY_CONFIG_SUM="$(printf '%s' "$PROXY_CONF" | sha256sum | cut -c1-16)"

kubectl create configmap argo-proxy -n "$NAMESPACE" \
  --from-literal="default.conf=${PROXY_CONF}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argo-proxy
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: argo-proxy
  template:
    metadata:
      labels:
        app: argo-proxy
      annotations:
        # ConfigMap 이 바뀌면 파드를 다시 띄워야 nginx 가 새 설정을 읽는다.
        checksum/config: "${PROXY_CONFIG_SUM}"
    spec:
      containers:
        - name: nginx
          image: ${PROXY_IMAGE}
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
          resources:
            requests: {cpu: 10m, memory: 32Mi}
            limits: {memory: 128Mi}
          volumeMounts:
            - name: conf
              mountPath: /etc/nginx/conf.d
              readOnly: true
            # 이미지가 non-root 로 돌 수 있도록 쓰기 경로를 메모리로 올린다.
            - name: cache
              mountPath: /var/cache/nginx
            - name: run
              mountPath: /var/run
      volumes:
        - name: conf
          configMap:
            name: argo-proxy
        - name: cache
          emptyDir: {}
        - name: run
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: argo-proxy
  namespace: ${NAMESPACE}
spec:
  selector:
    app: argo-proxy
  ports:
    - port: 8080
      targetPort: 8080
EOF
kubectl rollout status deployment/argo-proxy -n "$NAMESPACE" --timeout 5m
echo "  /argo/* → argo-workflows-server:2746/* (접두어 제거)"

# -----------------------------------------------------------------------------
# 7. Ingress
#    group.name 으로 Grafana·MLflow 와 같은 ALB 를 공유한다. order 는 리스너 규칙
#    우선순위이며 Grafana 가 100 에서 '/' 전체를 받으므로 더 낮아야 한다.
#    security-group-prefix-lists 는 그룹 내 모든 Ingress 에 같은 값으로 있어야 한다.
#    하나라도 빠지면 컨트롤러가 ALB 보안그룹에 0.0.0.0/0 inbound 를 넣는다.
#
#    tags 도 그룹 멤버 전원이 같아야 한다. 값이 엇갈리면 컨트롤러가 'conflicting tag'
#    로 그룹 전체의 조정을 멈추고, 이 Ingress 의 리스너 규칙이 끝내 만들어지지 않는다
#    (그러면 /argo 요청이 order 100 의 Grafana 로 떨어져 로그인 화면이 나온다).
#
#    백엔드는 Argo 서버가 아니라 argo-proxy 다. 헬스체크도 프록시가 직접 답하는
#    /healthz 를 쓴다 — Argo 서버를 거치지 않으므로 서버가 느릴 때도 흔들리지 않는다.
# -----------------------------------------------------------------------------
echo "[7/7] Ingress"
kubectl apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argo-server
  namespace: ${NAMESPACE}
  annotations:
    alb.ingress.kubernetes.io/group.name: ${INGRESS_GROUP}
    alb.ingress.kubernetes.io/group.order: "${INGRESS_ORDER}"
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'
    alb.ingress.kubernetes.io/security-group-prefix-lists: ${CF_PREFIX_LIST}
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    alb.ingress.kubernetes.io/tags: ManagedBy=${INGRESS_GROUP}
spec:
  ingressClassName: alb
  rules:
    - http:
        paths:
          - path: /argo
            pathType: Prefix
            backend:
              service:
                name: argo-proxy
                port:
                  number: 8080
EOF
echo "  /argo → argo-proxy (order ${INGRESS_ORDER})"

TOKEN_SECRET="${ADMIN_SA}.service-account-token"
for _ in $(seq 1 30); do
  TOKEN="$(kubectl get secret "$TOKEN_SECRET" -n "$NAMESPACE" \
    -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  [[ -z "$TOKEN" ]] || break
  sleep 1
done
[[ -n "$TOKEN" ]] || {
  echo "토큰 Secret ${TOKEN_SECRET} 이 아직 채워지지 않았습니다." >&2
  echo "잠시 후 다음 명령으로 확인하세요:" >&2
  echo "  kubectl get secret ${TOKEN_SECRET} -n ${NAMESPACE} -o jsonpath='{.data.token}' | base64 -d" >&2
  exit 1
}

cat <<EOF

완료.

  Argo        : https://${CF_DOMAIN}/argo
  Grafana     : https://${CF_DOMAIN}/
  MLflow      : https://${CF_DOMAIN}/mlflow

로그인: 위 주소를 열면 토큰을 묻습니다. 아래 한 줄을 그대로 붙여넣으세요.

Bearer ${TOKEN}

이 토큰은 만료되지 않고 파일로 저장되지도 않습니다. 다시 보려면:

  kubectl get secret ${TOKEN_SECRET} -n ${NAMESPACE} -o jsonpath='{.data.token}' | base64 -d

무효화하려면 Secret 을 지우고 이 스크립트를 다시 돌리세요(새 토큰이 나옵니다):

  kubectl delete secret ${TOKEN_SECRET} -n ${NAMESPACE}

Job 제출: Workflow Templates 메뉴에서 템플릿을 고르고 Submit 을 누릅니다.

  workshop-setup   최초 1회 — FSx 클레임 + 코드 clone + MuJoCo venv (약 10분)
  mujoco-train     CPU 학습 (약 5분)
  mujoco-render    정책 검증 + 영상
  isaaclab-train   GPU 학습 (약 15~20분)
  isaaclab-play    GPU 노드 DCV 화면에 Isaac Sim 재생

제출하면 render 단계가 k8s-templates/render.sh 로 Job YAML 을 만들고 submit 단계가
그 Job 을 띄웁니다. 템플릿 원본은 수정되지 않으므로 가이드의 CLI 명령도 그대로 동작합니다.

  cd hyperpod-training/k8s-templates
  TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply

로그는 Logs 탭에서 보입니다. 다만 Job 파드가 ttlSecondsAfterFinished 로 사라지면
로그도 함께 사라집니다. 끝난 Job 의 로그를 계속 검색하려면:

  ./scripts/eks/install-logs.sh

k8s-templates 를 고쳤으면 사본을 갱신해야 합니다. 이 스크립트를 다시 돌리면 됩니다.

제거: ./scripts/eks/delete-job-portal.sh
EOF
