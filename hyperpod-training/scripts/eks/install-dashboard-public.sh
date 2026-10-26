#!/usr/bin/env bash
# =============================================================================
# install-dashboard-public.sh — 서울(ap-northeast-2) HyperPod EKS 클러스터의
#                               Grafana 대시보드를 CloudFront URL 로 공개한다.
#
#   인터넷
#     └─ CloudFront (https, 배포 1개)
#          ├─ WAF Web ACL (us-east-1 / scope=CLOUDFRONT)
#          │    AWSManagedRulesCommonRuleSet + AWSManagedRulesKnownBadInputsRuleSet
#          └─ Origin: ALB:80 (http-only, TLS 는 CloudFront 에서 종료)
#               ALB 보안그룹 inbound 80 은 CloudFront origin-facing prefix list 로만 제한
#                 └─ Grafana (admin 비밀번호는 차트가 Secret 으로 생성)
#                      └─ kube-prometheus-stack
#                           kubelet / cAdvisor / node-exporter / kube-state-metrics
#                           + Kueue(8443, ServiceAccount 토큰 인증)
#
#   접근 통제는 두 겹이다. (1) CloudFront 앞단 WAF 의 AWS 관리형 기본 룰셋,
#   (2) Grafana 자체 로그인. IP 화이트리스트는 쓰지 않는다.
#
#   Grafana Ingress 는 IngressGroup 'hyperpod-dashboard' 에 group.order=100 으로 들어가
#   '/' 전체를 받는다. install-mlflow-selfhosted.sh 를 이어서 돌리면 같은 ALB 에
#   /mlflow (order 10) 와 /tensorboard (order 20) 규칙이 추가되어 한 주소 아래 셋이 붙는다.
#
# ─── 이 스크립트를 기본 경로로 쓰지 않는 이유 ───
#   1. 대시보드를 인터넷에 공개한다. 워크샵 모델은 code-server 뒤에 숨기는 쪽이라
#      전제가 반대다.
#   2. 상시 비용이 붙는다. ALB 약 $16/월, WAF Web ACL 약 $5/월, 관리형 룰 약 $2/월.
#   3. 메트릭 출처가 다르다. install-observability.sh 는 Amazon Managed Prometheus +
#      HyperPod observability 애드온을 쓰는데, 여기는 클러스터 안의
#      kube-prometheus-stack 이다. 화면이 가이드와 일치하지 않는다.
#   4. Prometheus 가 emptyDir 을 쓴다. pod 가 재시작하면 메트릭이 사라지고 retention 도
#      6h 로 짧다. install-mlflow-selfhosted.sh 를 돌리면 gp3 StorageClass 가 생기므로
#      그 뒤에는 PVC 로 바꿀 수 있다.
#   서울에 observability 애드온이 올라오면 이 스크립트는 버리고
#   install-observability.sh 로 돌아가는 것이 맞다.
#
# 사용법:
#   ./scripts/eks/install-dashboard-public.sh [--cluster <eks-cluster-name>] [--yes]
#
# 사전 조건:
#   - ap-northeast-2 의 HyperPod EKS 클러스터가 떠 있고 노드가 1대 이상 Ready
#   - kubectl 이 해당 클러스터를 가리킴 (./scripts/eks/kubeconfig.sh)
#   - taskgovernance 애드온(Kueue)이 설치되어 있음 — Kueue 패널이 거기서 나온다
#   - kubectl / helm / jq / aws / envsubst, 그리고 IAM·WAF·CloudFront 생성 권한
#
# 제거: ./scripts/eks/delete-dashboard-public.sh
#       CloudFront 를 비활성화하고 전파를 기다려야 해서 20분쯤 걸린다.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EKS_DIR="$(cd "${HERE}/../../eks" && pwd)"

# 서울 전용. 다른 리전에서 쓰려면 install-observability.sh 를 먼저 검토할 것.
REGION="ap-northeast-2"
WAF_REGION="us-east-1"                 # CloudFront scope Web ACL 은 us-east-1 에만 만들 수 있다
CF_PREFIX_LIST="pl-22a6434b"           # com.amazonaws.global.cloudfront.origin-facing (ap-northeast-2)
MONITORING_NAMESPACE="monitoring"
KPS_CHART_VERSION="92.10.1"
GRAFANA_CHART_VERSION="10.5.15"
LBC_CHART_VERSION="3.6.0"
DASHBOARD_CONFIGMAP="hyperpod-dashboards"
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

for tool in kubectl helm jq aws envsubst; do
  command -v "$tool" >/dev/null 2>&1 || { echo "${tool} 이 필요합니다." >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"

LBC_ROLE="${CLUSTER_NAME}-alb-controller"
LBC_POLICY="${CLUSTER_NAME}-alb-controller"
WAF_ACL_NAME="${CLUSTER_NAME}-dashboard"
CF_CALLER_REF="${CLUSTER_NAME}-dashboard"
INGRESS_NAME="grafana"
INGRESS_GROUP="hyperpod-dashboard"

aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 || {
  echo "EKS 클러스터 '${CLUSTER_NAME}' 을 ${REGION} 에서 찾지 못했습니다." >&2
  exit 1
}
VPC_ID="$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" \
  --query cluster.resourcesVpcConfig.vpcId --output text)"

NODE_COUNT="$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')"
[[ "$NODE_COUNT" -ge 1 ]] || {
  echo "Ready 노드가 없습니다. HyperPod 클러스터에 노드가 올라온 뒤 다시 실행하세요." >&2
  exit 1
}

cat <<EOF

대상       : ${CLUSTER_NAME} (${REGION}, VPC ${VPC_ID}, 노드 ${NODE_COUNT}대)
생성 대상  : AWS Load Balancer Controller (IAM role/policy + pod identity)
             kube-prometheus-stack (namespace ${MONITORING_NAMESPACE})
             Grafana + Ingress → ALB(internet-facing, inbound 80 은 CloudFront 만)
             WAF Web ACL (${WAF_REGION}, 관리형 기본 룰셋 2종)
             CloudFront 배포 1개
상시 비용  : ALB 약 \$18/월 + WAF 약 \$7/월
접근 통제  : CloudFront 앞 WAF 관리형 룰 + Grafana 로그인
기존 리소스는 변경하지 않습니다.

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "진행할까요? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "취소했습니다."; exit 0; }
fi

POD_TRUST='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "pods.eks.amazonaws.com" },
    "Action": ["sts:AssumeRole", "sts:TagSession"]
  }]
}'

# -----------------------------------------------------------------------------
# 1. AWS Load Balancer Controller
#    HyperPod EKS 의 pod 는 노드 역할을 상속하지 않고 IMDS 도 막혀 있어서
#    pod identity 가 유일한 자격증명 경로다.
# -----------------------------------------------------------------------------
echo "[1/7] AWS Load Balancer Controller"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${LBC_POLICY}"
if ! aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  curl -fsSL "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v${LBC_CHART_VERSION}/docs/install/iam_policy.json" \
    -o /tmp/lbc-iam-policy.json
  aws iam create-policy --policy-name "$LBC_POLICY" \
    --policy-document file:///tmp/lbc-iam-policy.json >/dev/null
  rm -f /tmp/lbc-iam-policy.json
  echo "  IAM 정책 생성: ${LBC_POLICY}"
fi
if ! aws iam get-role --role-name "$LBC_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$LBC_ROLE" \
    --assume-role-policy-document "$POD_TRUST" >/dev/null
  echo "  IAM 역할 생성: ${LBC_ROLE}"
fi
aws iam attach-role-policy --role-name "$LBC_ROLE" --policy-arn "$POLICY_ARN"

if ! aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
     --namespace kube-system --service-account aws-load-balancer-controller \
     --query 'associations[0].associationId' --output text 2>/dev/null | grep -qv '^None$'; then
  aws eks create-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --namespace kube-system --service-account aws-load-balancer-controller \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${LBC_ROLE}" >/dev/null
  echo "  pod identity 연결: kube-system/aws-load-balancer-controller"
fi

helm repo add eks https://aws.github.io/eks-charts >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --version "$LBC_CHART_VERSION" \
  --namespace kube-system \
  --set clusterName="$CLUSTER_NAME" \
  --set region="$REGION" \
  --set vpcId="$VPC_ID" \
  --set "nodeSelector.node\.kubernetes\.io/instance-type=${SYSTEM_INSTANCE_TYPE}" \
  --set replicaCount=1 \
  --wait --timeout 10m

# -----------------------------------------------------------------------------
# 2. kube-prometheus-stack
#    EKS 는 etcd / scheduler / controller-manager / kube-proxy 메트릭을 노출하지
#    않으므로 해당 scrape job 을 끈다(켜두면 Target Down 경보만 쌓인다).
#    EBS CSI 가 없어서 Prometheus 는 emptyDir 이고 retention 은 6h 로 짧게 둔다.
#    serviceMonitorSelectorNilUsesHelmValues=false 로 아래 3단계에서 따로 만드는
#    Kueue ServiceMonitor 를 집어가게 한다.
# -----------------------------------------------------------------------------
echo "[2/7] kube-prometheus-stack"
kubectl create namespace "$MONITORING_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --version "$KPS_CHART_VERSION" \
  --namespace "$MONITORING_NAMESPACE" \
  --set kubeEtcd.enabled=false \
  --set kubeScheduler.enabled=false \
  --set kubeControllerManager.enabled=false \
  --set kubeProxy.enabled=false \
  --set grafana.enabled=false \
  --set alertmanager.enabled=false \
  --set prometheus.prometheusSpec.retention=6h \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set "prometheus.prometheusSpec.nodeSelector.node\.kubernetes\.io/instance-type=${SYSTEM_INSTANCE_TYPE}" \
  --set "prometheusOperator.nodeSelector.node\.kubernetes\.io/instance-type=${SYSTEM_INSTANCE_TYPE}" \
  --set "kube-state-metrics.nodeSelector.node\.kubernetes\.io/instance-type=${SYSTEM_INSTANCE_TYPE}" \
  --wait --timeout 15m

# Kueue 메트릭은 8443/HTTPS 에 authn 이 걸려 있다(인증 없이 붙으면 401).
# kueue-metrics-reader 는 /metrics 에 대한 nonResourceURL get 권한만 준다.
kubectl create clusterrolebinding kps-kueue-metrics-reader \
  --clusterrole=kueue-metrics-reader \
  --serviceaccount="${MONITORING_NAMESPACE}:kps-kube-prometheus-stack-prometheus" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl apply -f - >/dev/null <<EOF
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kueue-controller-manager
  namespace: ${MONITORING_NAMESPACE}
spec:
  namespaceSelector:
    matchNames:
      - kueue-system
  # kueue-system 의 세 서비스(metrics / visibility / webhook)가 name+control-plane 라벨을
  # 공유하고 visibility 쪽도 'https' 포트를 가진다. component=controller 로 좁히지 않으면
  # visibility 서버까지 긁어서 죽은 타겟이 생긴다.
  selector:
    matchLabels:
      app.kubernetes.io/name: kueue
      app.kubernetes.io/component: controller
      control-plane: controller-manager
  endpoints:
    - port: https
      scheme: https
      path: /metrics
      interval: 30s
      bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
      tlsConfig:
        insecureSkipVerify: true
EOF
echo "  Kueue ServiceMonitor 적용"

# -----------------------------------------------------------------------------
# 3. DCGM exporter — GPU 패널(DCGM_FI_DEV_*)의 유일한 공급원.
#    지원 리전에서는 amazon-sagemaker-hyperpod-observability 애드온이 DCGM 을 함께 넣어 주지만 이
#    경로는 애드온을 쓰지 않으므로 직접 설치해야 한다. 빠뜨리면 GPU 노드가 Running 이어도
#    "GPU utilization per node (DCGM)" 패널이 영구히 빈다.
#    GPU 노드가 0대면 DaemonSet 의 desired 도 0 이어서 rollout 이 즉시 성공으로 끝난다.
# -----------------------------------------------------------------------------
echo "[3/7] DCGM exporter"
kubectl apply -f "${EKS_DIR}/dcgm-exporter.yaml" >/dev/null
kubectl -n gpu-operator rollout status ds/dcgm-exporter --timeout=5m
echo "  DCGM exporter 적용 (네임스페이스 gpu-operator)"

# -----------------------------------------------------------------------------
# 4. Grafana
#    대시보드 JSON 은 ConfigMap 으로 넣는다. values 안에 인라인으로 두면 Helm 이
#    JSON 안의 {{ }} 를 템플릿으로 해석해서 깨진다.
#    여기는 ALB 루트(/)로 서비스하므로 install-observability.sh 의
#    serve_from_sub_path(/absproxy/3000/) 설정은 쓰지 않는다.
# -----------------------------------------------------------------------------
echo "[4/7] Grafana"
kubectl create configmap "$DASHBOARD_CONFIGMAP" \
  --namespace "$MONITORING_NAMESPACE" \
  --from-file="${EKS_DIR}/grafana-dashboards" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

PROM_URL="http://kps-kube-prometheus-stack-prometheus.${MONITORING_NAMESPACE}.svc:9090"
helm upgrade --install grafana grafana/grafana \
  --version "$GRAFANA_CHART_VERSION" \
  --namespace "$MONITORING_NAMESPACE" \
  --set "nodeSelector.node\.kubernetes\.io/instance-type=${SYSTEM_INSTANCE_TYPE}" \
  --set datasources."datasources\.yaml".apiVersion=1 \
  --set datasources."datasources\.yaml".datasources[0].name=Prometheus \
  --set datasources."datasources\.yaml".datasources[0].type=prometheus \
  --set datasources."datasources\.yaml".datasources[0].uid=prometheus \
  --set datasources."datasources\.yaml".datasources[0].access=proxy \
  --set datasources."datasources\.yaml".datasources[0].isDefault=true \
  --set datasources."datasources\.yaml".datasources[0].url="$PROM_URL" \
  --set dashboardsConfigMaps.hyperpod="$DASHBOARD_CONFIGMAP" \
  --set dashboardProviders."dashboardproviders\.yaml".apiVersion=1 \
  --set dashboardProviders."dashboardproviders\.yaml".providers[0].name=hyperpod \
  --set dashboardProviders."dashboardproviders\.yaml".providers[0].orgId=1 \
  --set dashboardProviders."dashboardproviders\.yaml".providers[0].type=file \
  --set dashboardProviders."dashboardproviders\.yaml".providers[0].disableDeletion=false \
  --set dashboardProviders."dashboardproviders\.yaml".providers[0].options.path=/var/lib/grafana/dashboards/hyperpod \
  --wait --timeout 10m

# -----------------------------------------------------------------------------
# 5. ALB
#    security-group-prefix-lists 를 주면 컨트롤러가 관리형 보안그룹에 기본으로 넣는
#    0.0.0.0/0 inbound 를 생략하고 prefix list 만 허용한다. 즉 ALB DNS 를 직접
#    알아내도 CloudFront 를 거치지 않으면 닿지 않는다.
#    group.name 을 주면 다른 네임스페이스의 Ingress 가 같은 ALB 를 공유할 수 있다
#    (install-mlflow-selfhosted.sh 가 /mlflow, /tensorboard 를 여기에 붙인다).
#    group.order 는 리스너 규칙 우선순위다. Grafana 는 '/' 전체를 받으므로 가장
#    느슨한 규칙 = 가장 큰 숫자여야 한다. 더 구체적인 경로가 앞에 와야 매칭된다.
#
#    tags 는 ALB 자체에 붙으므로 그룹 멤버 전원이 같은 값을 써야 한다. 스크립트마다
#    다른 값을 쓰면 컨트롤러가 'conflicting tag' 로 그룹 전체의 조정을 멈추고,
#    그 뒤에 추가한 Ingress 의 리스너 규칙이 만들어지지 않는다.
# -----------------------------------------------------------------------------
echo "[5/7] ALB (Ingress)"
kubectl apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${INGRESS_NAME}
  namespace: ${MONITORING_NAMESPACE}
  annotations:
    alb.ingress.kubernetes.io/group.name: ${INGRESS_GROUP}
    alb.ingress.kubernetes.io/group.order: "100"
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'
    alb.ingress.kubernetes.io/security-group-prefix-lists: ${CF_PREFIX_LIST}
    alb.ingress.kubernetes.io/healthcheck-path: /api/health
    alb.ingress.kubernetes.io/tags: ManagedBy=${INGRESS_GROUP}
spec:
  ingressClassName: alb
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: grafana
                port:
                  number: 80
EOF

echo "  ALB 프로비저닝 대기 (최대 10분)"
ALB_DNS=""
for _i in $(seq 1 60); do
  ALB_DNS="$(kubectl get ingress "$INGRESS_NAME" -n "$MONITORING_NAMESPACE" \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  [[ -n "$ALB_DNS" ]] && break
  sleep 10
done
[[ -n "$ALB_DNS" ]] || {
  echo "ALB 가 생성되지 않았습니다. 컨트롤러 로그를 확인하세요:" >&2
  echo "  kubectl logs -n kube-system deploy/aws-load-balancer-controller" >&2
  exit 1
}
echo "  ALB: ${ALB_DNS}"

# -----------------------------------------------------------------------------
# 6. WAF Web ACL (us-east-1 / CLOUDFRONT scope)
#    AWS 관리형 기본 룰셋 2종만 쓴다. IP 화이트리스트는 없다.
# -----------------------------------------------------------------------------
echo "[6/7] WAF Web ACL"
WAF_ARN="$(aws wafv2 list-web-acls --scope CLOUDFRONT --region "$WAF_REGION" \
  --query "WebACLs[?Name=='${WAF_ACL_NAME}'].ARN | [0]" --output text 2>/dev/null || true)"
if [[ -z "$WAF_ARN" || "$WAF_ARN" == "None" ]]; then
  RULES="$(jq -nc '[
    {
      Name: "common",
      Priority: 0,
      Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: "AWSManagedRulesCommonRuleSet" } },
      OverrideAction: { None: {} },
      VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: "common" }
    },
    {
      Name: "bad-inputs",
      Priority: 1,
      Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: "AWSManagedRulesKnownBadInputsRuleSet" } },
      OverrideAction: { None: {} },
      VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: "bad-inputs" }
    }
  ]')"
  WAF_ARN="$(aws wafv2 create-web-acl --region "$WAF_REGION" --scope CLOUDFRONT \
    --name "$WAF_ACL_NAME" \
    --default-action '{"Allow":{}}' \
    --rules "$RULES" \
    --visibility-config "SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=${WAF_ACL_NAME}" \
    --query 'Summary.ARN' --output text)"
  echo "  생성: ${WAF_ACL_NAME}"
else
  echo "  기존 사용: ${WAF_ACL_NAME}"
fi

# -----------------------------------------------------------------------------
# 7. CloudFront
#    CachingDisabled + AllViewer. Grafana 는 동적 앱이라 캐싱하면 로그인이 깨진다.
#    CallerReference 는 멱등 키 역할도 한다.
# -----------------------------------------------------------------------------
echo "[7/7] CloudFront"
CF_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CF_CALLER_REF}'].Id | [0]" --output text 2>/dev/null || true)"
if [[ -z "$CF_ID" || "$CF_ID" == "None" ]]; then
  CF_CONFIG="$(jq -nc --arg ref "$CF_CALLER_REF" --arg alb "$ALB_DNS" --arg waf "$WAF_ARN" '{
    CallerReference: $ref,
    Comment: $ref,
    Enabled: true,
    WebACLId: $waf,
    Origins: {
      Quantity: 1,
      Items: [{
        Id: "alb",
        DomainName: $alb,
        CustomOriginConfig: {
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: "http-only",
          OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] }
        }
      }]
    },
    DefaultCacheBehavior: {
      TargetOriginId: "alb",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: 7,
        Items: ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET","HEAD"] }
      },
      CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      OriginRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3",
      Compress: true
    }
  }')"
  CF_ID="$(aws cloudfront create-distribution --distribution-config "$CF_CONFIG" \
    --query 'Distribution.Id' --output text)"
  echo "  생성: ${CF_ID}"
else
  echo "  기존 사용: ${CF_ID}"
fi
CF_DOMAIN="$(aws cloudfront get-distribution --id "$CF_ID" \
  --query 'Distribution.DomainName' --output text)"

cat <<EOF

완료.

  URL  : https://${CF_DOMAIN}
  user : admin
  pass : kubectl get secret -n ${MONITORING_NAMESPACE} grafana -o jsonpath='{.data.admin-password}' | base64 -d

CloudFront 전파에 15~20분 걸린다. 그 전에는 403 이나 502 가 날 수 있다. 상태 확인:
  aws cloudfront get-distribution --id ${CF_ID} --query 'Distribution.Status' --output text

GPU 노드가 0대인 동안 DCGM GPU 패널은 비어 있다. 정상이다.

같은 주소 아래 MLflow(/mlflow)와 TensorBoard(/tensorboard)를 붙이려면 이어서:
  ./scripts/eks/install-mlflow-selfhosted.sh

제거: ./scripts/eks/delete-dashboard-public.sh
EOF
