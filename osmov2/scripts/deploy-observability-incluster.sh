#!/usr/bin/env bash
set -euo pipefail

# In-cluster observability: kube-prometheus-stack (bundled Grafana) + Pushgateway
# + DCGM ServiceMonitor. Alternative to the AMP+AMG path in infra/observability,
# for accounts without IAM Identity Center (AMG SSO login unavailable).
#
# Grafana uses id/pw login and is reached via kubectl port-forward. Training
# workflows push reward/loss to the Pushgateway so learning curves show up in
# the same Grafana as DCGM GPU metrics.

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws kubectl helm jq openssl

PROM_REPO="${PROM_REPO:-$(version_value prometheus_community_repo)}"
KPS_CHART_VERSION="${KPS_CHART_VERSION:-$(version_value kube_prometheus_stack_chart_version)}"
PUSHGATEWAY_CHART_VERSION="${PUSHGATEWAY_CHART_VERSION:-$(version_value pushgateway_chart_version)}"
MONITORING_NAMESPACE="${MONITORING_NAMESPACE:-$(version_value monitoring_namespace)}"
PROM_RELEASE="${PROM_RELEASE:-$(version_value prometheus_release_name)}"
PUSHGATEWAY_RELEASE="${PUSHGATEWAY_RELEASE:-$(version_value pushgateway_release_name)}"
PUSHGATEWAY_SERVICE="${PUSHGATEWAY_SERVICE:-$(version_value pushgateway_service)}"
PROM_RETENTION="${PROM_RETENTION:-$(version_value prometheus_retention)}"
CLUSTER_NAME="${CLUSTER_NAME:-$(terraform_output cluster_name 2>/dev/null || echo aws-osmo-dev-repro-eks)}"
DCGM_NAMESPACE="${DCGM_NAMESPACE:-gpu-operator}"

# Grafana admin password: use env, else generate and store to a local file.
GRAFANA_ADMIN_PASSWORD_FILE="${GRAFANA_ADMIN_PASSWORD_FILE:-${HOME}/.aws-osmo-grafana-admin}"
if [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  if [[ -s "${GRAFANA_ADMIN_PASSWORD_FILE}" ]]; then
    GRAFANA_ADMIN_PASSWORD="$(tr -d '[:space:]' <"${GRAFANA_ADMIN_PASSWORD_FILE}")"
  else
    GRAFANA_ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
    umask 077
    printf '%s' "${GRAFANA_ADMIN_PASSWORD}" >"${GRAFANA_ADMIN_PASSWORD_FILE}"
    log "generated Grafana admin password stored at ${GRAFANA_ADMIN_PASSWORD_FILE}"
  fi
fi

configure_kubectl

kubectl create namespace "${MONITORING_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

helm repo add prometheus-community "${PROM_REPO}" --force-update >/dev/null
helm repo update prometheus-community >/dev/null

PUSHGATEWAY_FQDN="${PUSHGATEWAY_SERVICE}.${MONITORING_NAMESPACE}.svc.cluster.local:9091"

# When exposing Grafana via ingress host or CloudFront, set root_url so login
# redirects and generated links use the public domain instead of the pod's localhost.
# GRAFANA_CLOUDFRONT_DOMAIN takes precedence over GRAFANA_INGRESS_HOST.
GRAFANA_PUBLIC_HOST="${GRAFANA_CLOUDFRONT_DOMAIN:-${GRAFANA_INGRESS_HOST:-}}"
if [[ -n "${GRAFANA_PUBLIC_HOST:-}" ]]; then
  GRAFANA_INI_BLOCK=$(cat <<INI
  grafana.ini:
    server:
      root_url: "https://${GRAFANA_PUBLIC_HOST}"
INI
)
else
  GRAFANA_INI_BLOCK=""
fi

VALUES_FILE="$(mktemp)"
trap 'rm -f "${VALUES_FILE}"' EXIT
cat >"${VALUES_FILE}" <<EOF
fullnameOverride: ${PROM_RELEASE}
alertmanager:
  enabled: false
grafana:
  enabled: true
  adminPassword: "${GRAFANA_ADMIN_PASSWORD}"
  service:
    type: ClusterIP
  defaultDashboardsEnabled: true
${GRAFANA_INI_BLOCK}
prometheus:
  prometheusSpec:
    retention: ${PROM_RETENTION}
    externalLabels:
      cluster: ${CLUSTER_NAME}
    podMonitorSelectorNilUsesHelmValues: false
    serviceMonitorSelectorNilUsesHelmValues: false
    additionalScrapeConfigs:
      - job_name: pushgateway
        honor_labels: true
        static_configs:
          - targets: ["${PUSHGATEWAY_FQDN}"]
prometheus-node-exporter:
  enabled: true
kube-state-metrics:
  enabled: true
EOF

log "deploying kube-prometheus-stack ${KPS_CHART_VERSION} (bundled Grafana)"
helm upgrade --install "${PROM_RELEASE}" \
  prometheus-community/kube-prometheus-stack \
  --namespace "${MONITORING_NAMESPACE}" \
  --version "${KPS_CHART_VERSION}" \
  --values "${VALUES_FILE}" \
  --wait --timeout 12m

log "deploying prometheus-pushgateway ${PUSHGATEWAY_CHART_VERSION} (training metrics)"
helm upgrade --install "${PUSHGATEWAY_RELEASE}" \
  prometheus-community/prometheus-pushgateway \
  --namespace "${MONITORING_NAMESPACE}" \
  --version "${PUSHGATEWAY_CHART_VERSION}" \
  --set "fullnameOverride=${PUSHGATEWAY_SERVICE}" \
  --wait --timeout 5m

log "creating DCGM exporter ServiceMonitor for GPU metrics"
kubectl apply -f - <<YAML
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nvidia-dcgm-exporter
  namespace: ${MONITORING_NAMESPACE}
  labels:
    app.kubernetes.io/part-of: aws-osmo-observability
spec:
  namespaceSelector:
    matchNames:
      - ${DCGM_NAMESPACE}
  selector:
    matchLabels:
      app: nvidia-dcgm-exporter
  endpoints:
    - port: gpu-metrics
      interval: 15s
YAML

# Provision dashboards as ConfigMaps with the grafana_dashboard sidecar label so
# they survive Grafana pod restarts (API-imported dashboards do not persist).
DASHBOARD_DIR="${DASHBOARD_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/observability-dashboards}"
if [[ -d "${DASHBOARD_DIR}" ]]; then
  for dash in "${DASHBOARD_DIR}"/*.json; do
    [[ -e "${dash}" ]] || continue
    cm_name="aws-osmo-dashboard-$(basename "${dash}" .json)"
    log "provisioning dashboard ConfigMap ${cm_name}"
    kubectl -n "${MONITORING_NAMESPACE}" create configmap "${cm_name}" \
      --from-file="$(basename "${dash}")=${dash}" \
      --dry-run=client -o yaml \
      | kubectl label --local -f - grafana_dashboard=1 -o yaml \
      | kubectl apply -f -
  done
fi

# Optional public HTTPS ingress (ALB + ACM). Set GRAFANA_INGRESS_HOST,
# GRAFANA_CERT_ARN, and GRAFANA_INBOUND_CIDRS to enable. Reuses the AWS Load
# Balancer Controller from infra/ingress. Grafana only has id/pw auth, so
# GRAFANA_INBOUND_CIDRS must be a narrow allow list (never 0.0.0.0/0).
if [[ -n "${GRAFANA_INGRESS_HOST:-}" && -n "${GRAFANA_CERT_ARN:-}" && -n "${GRAFANA_INBOUND_CIDRS:-}" ]]; then
  if [[ "${GRAFANA_INBOUND_CIDRS}" == *"0.0.0.0/0"* ]]; then
    die "GRAFANA_INBOUND_CIDRS must not include 0.0.0.0/0 (Grafana has id/pw auth only)"
  fi
  log "creating Grafana ALB ingress for ${GRAFANA_INGRESS_HOST} (inbound ${GRAFANA_INBOUND_CIDRS})"
  kubectl apply -f - <<YAML
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grafana-admin
  namespace: ${MONITORING_NAMESPACE}
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/backend-protocol: HTTP
    alb.ingress.kubernetes.io/certificate-arn: ${GRAFANA_CERT_ARN}
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'
    alb.ingress.kubernetes.io/inbound-cidrs: ${GRAFANA_INBOUND_CIDRS}
    alb.ingress.kubernetes.io/healthcheck-path: /api/health
    alb.ingress.kubernetes.io/success-codes: 200-399
    alb.ingress.kubernetes.io/load-balancer-name: aws-osmo-grafana
  labels:
    app.kubernetes.io/part-of: aws-osmo-observability
spec:
  ingressClassName: alb
  rules:
    # Named host (Route53 + ACM cert). Access via https://${GRAFANA_INGRESS_HOST}.
    - host: ${GRAFANA_INGRESS_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${PROM_RELEASE}-grafana
                port:
                  number: 80
    # Host-less catch-all so the raw ALB DNS name also routes (demo access
    # without the domain). HTTPS on the ALB uses the ${GRAFANA_INGRESS_HOST}
    # cert, so hitting the raw ALB address over https shows a cert-name warning
    # (expected); the domain path stays clean.
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${PROM_RELEASE}-grafana
                port:
                  number: 80
YAML
fi

kubectl -n "${MONITORING_NAMESPACE}" rollout status \
  deployment/"${PROM_RELEASE}-grafana" --timeout=5m

GRAFANA_SVC="${PROM_RELEASE}-grafana"
log "in-cluster observability deployed"
log "Grafana: kubectl -n ${MONITORING_NAMESPACE} port-forward svc/${GRAFANA_SVC} 3000:80  -> http://127.0.0.1:3000"
log "Grafana login: admin / (see ${GRAFANA_ADMIN_PASSWORD_FILE})"
log "Prometheus:    kubectl -n ${MONITORING_NAMESPACE} port-forward svc/${PROM_RELEASE}-prometheus 9090:9090"
log "Pushgateway:   ${PUSHGATEWAY_FQDN} (training workflows push reward/loss here)"
