#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws kubectl helm jq openssl terraform osmo

OSMO_VERSION="${OSMO_VERSION:-$(version_value release)}"
OSMO_CHART_REPO="${OSMO_CHART_REPO:-$(version_value chart_repository)}"
OSMO_CHART_VERSION="${OSMO_CHART_VERSION:-$(version_value chart_version)}"
OSMO_IMAGE_REGISTRY="${OSMO_IMAGE_REGISTRY:-$(version_value image_registry)}"
OSMO_IMAGE_TAG="${OSMO_IMAGE_TAG:-$(version_value image_tag)}"
OSMO_BACKEND_INIT_IMAGE="${OSMO_BACKEND_INIT_IMAGE:-$(version_value backend_init_image)}"
OSMO_BACKEND_CLIENT_IMAGE="${OSMO_BACKEND_CLIENT_IMAGE:-$(version_value backend_client_image)}"
OSMO_BACKEND_NAME="${OSMO_BACKEND_NAME:-default}"
OSMO_CONFIGURE_GPU_PLATFORM="${OSMO_CONFIGURE_GPU_PLATFORM:-true}"
OSMO_GPU_PLATFORM_NAME="${OSMO_GPU_PLATFORM_NAME:-g7e-rtx-pro-6000}"
OSMO_GPU_POD_TEMPLATE_NAME="${OSMO_GPU_POD_TEMPLATE_NAME:-aws-g7e-rtx-pro-6000}"
GPU_PROVISIONER="${GPU_PROVISIONER:-karpenter}"
OSMO_GPU_PLATFORM_LABEL_KEY="${OSMO_GPU_PLATFORM_LABEL_KEY:-$(osmo_gpu_label_key)}"
if [[ "${GPU_PROVISIONER}" == "managed-nodegroup" ]]; then
  OSMO_GPU_PLATFORM_LABEL_VALUE="${OSMO_GPU_PLATFORM_LABEL_VALUE:-g7e}"
else
  OSMO_GPU_PLATFORM_LABEL_VALUE="${OSMO_GPU_PLATFORM_LABEL_VALUE:-$(version_value karpenter_nodepool_name)}"
fi
OSMO_GPU_POD_DO_NOT_DISRUPT="${OSMO_GPU_POD_DO_NOT_DISRUPT:-true}"
OSMO_GPU_POD_SHM_SIZE="${OSMO_GPU_POD_SHM_SIZE:-32Gi}"
# Optional GPU capacity-fallback platforms (comma-separated family names: g6, g5, g6e).
# Each family registers a <family>-<gpu> OSMO platform. Set OSMO_FALLBACK_PLATFORMS or
# use OSMO_CONFIGURE_G6_PLATFORM=true for backward compatibility (auto-appends g6).
OSMO_FALLBACK_PLATFORMS="${OSMO_FALLBACK_PLATFORMS:-}"
if [[ "${OSMO_CONFIGURE_G6_PLATFORM:-false}" == "true" && ",${OSMO_FALLBACK_PLATFORMS}," != *",g6,"* ]]; then
  OSMO_FALLBACK_PLATFORMS="${OSMO_FALLBACK_PLATFORMS:+${OSMO_FALLBACK_PLATFORMS},}g6"
fi
OSMO_INSTALL_KAI="${OSMO_INSTALL_KAI:-true}"
if [[ "${OSMO_INSTALL_KAI}" == "true" ]]; then
  OSMO_K8S_SCHEDULER_NAME="${OSMO_K8S_SCHEDULER_NAME:-$(version_value kai_scheduler_name)}"
  OSMO_INSTALL_PODGROUP_COMPAT_CRD="${OSMO_INSTALL_PODGROUP_COMPAT_CRD:-false}"
else
  OSMO_K8S_SCHEDULER_NAME="${OSMO_K8S_SCHEDULER_NAME:-default-scheduler}"
  OSMO_INSTALL_PODGROUP_COMPAT_CRD="${OSMO_INSTALL_PODGROUP_COMPAT_CRD:-true}"
fi
OSMO_UI_API_HOSTNAME="${OSMO_UI_API_HOSTNAME:-osmo-internal-router:80}"
OSMO_DATASET_BUCKET_NAME="${OSMO_DATASET_BUCKET_NAME:-aws-osmo}"
OSMO_DEPLOY_INTERNAL_ROUTER="${OSMO_DEPLOY_INTERNAL_ROUTER:-true}"
OSMO_INTERNAL_ROUTER_NAME="${OSMO_INTERNAL_ROUTER_NAME:-osmo-internal-router}"
OSMO_INTERNAL_ROUTER_IMAGE="${OSMO_INTERNAL_ROUTER_IMAGE:-$(version_value internal_router_image)}"
BACKEND_TOKEN_EXPIRES_AT="${BACKEND_TOKEN_EXPIRES_AT:-}"

if [[ "${OSMO_IMAGE_REGISTRY}" == nvcr.io* ]]; then
  load_ngc_api_key
fi

log "deploying OSMO ${OSMO_VERSION} with chart ${OSMO_CHART_VERSION}"

configure_kubectl

if [[ "${OSMO_INSTALL_KAI}" == "true" ]]; then
  "${ROOT_DIR}/scripts/deploy-kai.sh"
fi

AWS_REGION="$(terraform_output aws_region)"
OSMO_NAMESPACE="$(terraform_output osmo_namespace)"
OSMO_WORKLOAD_NAMESPACE="$(terraform_output osmo_workload_namespace)"
OSMO_SERVICE_ACCOUNT_NAME="$(terraform_output osmo_service_account_name)"
OSMO_SERVICE_ACCOUNT_ROLE_ARN="$(terraform_output osmo_service_account_role_arn)"
OSMO_RUNTIME_SECRET_ARN="$(terraform_output osmo_runtime_secret_arn)"
if [[ -z "${OSMO_SERVICE_CALLBACK_URL:-}" ]]; then
  OSMO_SERVICE_CALLBACK_URL="${OSMO_WORKFLOW_CALLBACK_URL:-http://${OSMO_INTERNAL_ROUTER_NAME}.${OSMO_NAMESPACE}.svc.cluster.local}"
fi
if [[ -z "${OSMO_WORKFLOW_DATA_BASE_URL:-}" ]]; then
  OSMO_WORKFLOW_DATA_BASE_URL="http://${OSMO_INTERNAL_ROUTER_NAME}.${OSMO_NAMESPACE}.svc.cluster.local"
fi

SECRET_JSON="$(aws secretsmanager get-secret-value \
  --region "${AWS_REGION}" \
  --secret-id "${OSMO_RUNTIME_SECRET_ARN}" \
  --query SecretString \
  --output text)"

secret_field() {
  printf '%s' "${SECRET_JSON}" | jq -er --arg key "$1" '.[$key]'
}

POSTGRES_HOST="$(secret_field postgres_host)"
POSTGRES_PORT="$(secret_field postgres_port)"
POSTGRES_DATABASE="$(secret_field postgres_database)"
POSTGRES_USERNAME="$(secret_field postgres_username)"
POSTGRES_PASSWORD="$(secret_field postgres_password)"
REDIS_HOST="$(secret_field redis_host)"
REDIS_PORT="$(secret_field redis_port)"
REDIS_AUTH_TOKEN="$(secret_field redis_auth_token)"
DEFAULT_ADMIN_TOKEN="$(secret_field default_admin_token)"
OSMO_ARTIFACTS_BUCKET="$(secret_field osmo_artifacts_bucket)"
WORKFLOW_DATA_ACCESS_KEY_ID="$(secret_field workflow_data_access_key_id)"
WORKFLOW_DATA_SECRET_ACCESS_KEY="$(secret_field workflow_data_secret_access_key)"

kubectl create namespace "${OSMO_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace "${OSMO_WORKLOAD_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

if [[ "${OSMO_INSTALL_PODGROUP_COMPAT_CRD}" == "true" ]] &&
  ! kubectl get crd podgroups.scheduling.run.ai >/dev/null 2>&1; then
  log "installing minimal PodGroup compatibility CRD for OSMO CPU smoke workflows"
  kubectl apply -f - <<'YAML'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: podgroups.scheduling.run.ai
  labels:
    app.kubernetes.io/name: osmo-podgroup-compat
    app.kubernetes.io/part-of: aws-osmo-reference
spec:
  group: scheduling.run.ai
  names:
    kind: PodGroup
    plural: podgroups
    singular: podgroup
  scope: Namespaced
  versions:
    - name: v2alpha2
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          x-kubernetes-preserve-unknown-fields: true
      subresources:
        status: {}
YAML
fi

kubectl -n "${OSMO_NAMESPACE}" create serviceaccount "${OSMO_SERVICE_ACCOUNT_NAME}" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${OSMO_NAMESPACE}" annotate serviceaccount "${OSMO_SERVICE_ACCOUNT_NAME}" \
  "eks.amazonaws.com/role-arn=${OSMO_SERVICE_ACCOUNT_ROLE_ARN}" \
  --overwrite

IMAGE_PULL_SECRET=""
if [[ -n "${NGC_API_KEY:-}" ]]; then
  log "creating NGC image pull secret in OSMO namespaces"
  for namespace in "${OSMO_NAMESPACE}" "${OSMO_WORKLOAD_NAMESPACE}"; do
    kubectl -n "${namespace}" create secret docker-registry ngc-registry \
      --docker-server=nvcr.io \
      --docker-username="\$oauthtoken" \
      --docker-password="${NGC_API_KEY}" \
      --dry-run=client -o yaml | kubectl apply -f -
  done
  IMAGE_PULL_SECRET="ngc-registry"
fi

kubectl -n "${OSMO_NAMESPACE}" create secret generic db-secret \
  --from-literal=db-password="${POSTGRES_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "${OSMO_NAMESPACE}" create secret generic redis-secret \
  --from-literal=redis-password="${REDIS_AUTH_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "${OSMO_NAMESPACE}" create secret generic osmo-default-admin \
  --from-literal=password="${DEFAULT_ADMIN_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

if MEK_YAML="$(kubectl -n "${OSMO_NAMESPACE}" get configmap mek-config -o jsonpath='{.data.mek\.yaml}' 2>/dev/null)"; then
  log "reusing existing OSMO MEK config"
else
  MEK_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  MEK_JWK="$(printf '{"k":"%s","kid":"key1","kty":"oct"}' "${MEK_KEY}" | base64 | tr -d '\n')"
  MEK_YAML="$(printf 'currentMek: key1\nmeks:\n  key1: %s\n' "${MEK_JWK}")"
  kubectl -n "${OSMO_NAMESPACE}" create configmap mek-config \
    --from-literal=mek.yaml="${MEK_YAML}" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

RUNTIME_CONFIG_CHECKSUM="$(
  printf '%s\n%s\n%s\n%s\n' "${POSTGRES_PASSWORD}" "${REDIS_AUTH_TOKEN}" "${DEFAULT_ADMIN_TOKEN}" "${MEK_YAML}" |
    openssl dgst -sha256 -r | awk '{print $1}'
)"

POD_MONITOR_ENABLED="false"
if [[ "${ENABLE_POD_MONITOR:-false}" == "true" ]]; then
  kubectl get crd podmonitors.monitoring.coreos.com >/dev/null
  POD_MONITOR_ENABLED="true"
fi

OSMO_AUTH_ENABLED="${OSMO_AUTH_ENABLED:-false}"

OSMO_CHART_SOURCE="repo"
OSMO_CHART_CACHE_DIR="${OSMO_CHART_CACHE_DIR:-$(helm env HELM_REPOSITORY_CACHE 2>/dev/null | tr -d '"')}"
if helm repo add osmo "${OSMO_CHART_REPO}" --force-update >/dev/null &&
  helm repo update osmo >/dev/null; then
  log "using OSMO Helm charts from ${OSMO_CHART_REPO}"
else
  log "OSMO Helm repo is unavailable; attempting local Helm cache fallback"
  OSMO_CHART_SOURCE="cache"
fi

osmo_chart_ref() {
  local chart="$1"
  if [[ "${OSMO_CHART_SOURCE}" == "repo" ]]; then
    printf 'osmo/%s' "${chart}"
    return
  fi

  local chart_path="${OSMO_CHART_CACHE_DIR}/${chart}-${OSMO_CHART_VERSION}.tgz"
  [[ -f "${chart_path}" ]] || die "OSMO chart ${chart} ${OSMO_CHART_VERSION} is not available in ${OSMO_CHART_CACHE_DIR}; retry when ${OSMO_CHART_REPO} is reachable"
  printf '%s' "${chart_path}"
}

SERVICE_VALUES="$(mktemp)"
BACKEND_VALUES="$(mktemp)"
SERVICE_CONFIG="$(mktemp)"
WORKFLOW_CONFIG="$(mktemp)"
DATASET_CONFIG="$(mktemp)"
BACKEND_CONFIG="$(mktemp)"
POOL_CONFIG="$(mktemp)"
GPU_POD_TEMPLATE_CONFIG="$(mktemp)"
trap 'rm -f "${SERVICE_VALUES}" "${BACKEND_VALUES}" "${SERVICE_CONFIG}" "${WORKFLOW_CONFIG}" "${DATASET_CONFIG}" "${BACKEND_CONFIG}" "${POOL_CONFIG}" "${GPU_POD_TEMPLATE_CONFIG}"; [[ -n "${PORT_FORWARD_PID:-}" ]] && kill "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true' EXIT

cat >"${SERVICE_VALUES}" <<EOF
global:
  osmoImageLocation: "${OSMO_IMAGE_REGISTRY}"
  osmoImageTag: "${OSMO_IMAGE_TAG}"
  imagePullSecret: "${IMAGE_PULL_SECRET}"
  serviceAccountName: "${OSMO_SERVICE_ACCOUNT_NAME}"

serviceAccount:
  create: false
  name: "${OSMO_SERVICE_ACCOUNT_NAME}"

services:
  configFile:
    enabled: true
    path: /opt/osmo/config.yaml
  ui:
    enabled: true
    serviceAccountName: "${OSMO_SERVICE_ACCOUNT_NAME}"
    apiHostname: "${OSMO_UI_API_HOSTNAME}"
  router:
    replicas: 1
  worker:
    scaling:
      minReplicas: 1
    extraPodAnnotations:
      aws.osmo.reference/runtime-config-checksum: "${RUNTIME_CONFIG_CHECKSUM}"
  logger:
    scaling:
      minReplicas: 1
    extraPodAnnotations:
      aws.osmo.reference/runtime-config-checksum: "${RUNTIME_CONFIG_CHECKSUM}"
  agent:
    scaling:
      minReplicas: 1
    extraPodAnnotations:
      aws.osmo.reference/runtime-config-checksum: "${RUNTIME_CONFIG_CHECKSUM}"
  delayedJobMonitor:
    extraPodAnnotations:
      aws.osmo.reference/runtime-config-checksum: "${RUNTIME_CONFIG_CHECKSUM}"
  postgres:
    enabled: false
    serviceName: "${POSTGRES_HOST}"
    port: ${POSTGRES_PORT}
    db: "${POSTGRES_DATABASE}"
    user: "${POSTGRES_USERNAME}"
    passwordSecretName: "db-secret"
    passwordSecretKey: "db-password"
  redis:
    enabled: false
    serviceName: "${REDIS_HOST}"
    port: ${REDIS_PORT}
    tlsEnabled: true
    passwordSecretName: "redis-secret"
    passwordSecretKey: "redis-password"
  defaultAdmin:
    enabled: true
    username: "admin"
    passwordSecretName: "osmo-default-admin"
    passwordSecretKey: "password"
  configs:
    enabled: false
  service:
    scaling:
      minReplicas: 1
    extraPodAnnotations:
      aws.osmo.reference/runtime-config-checksum: "${RUNTIME_CONFIG_CHECKSUM}"
    ingress:
      enabled: false

EOF

# gateway block (dev-repro: disabled; auth: envoy+oauth2Proxy+tls enabled)
osmo_gateway_values_block "${OSMO_AUTH_ENABLED}" >>"${SERVICE_VALUES}"

cat >>"${SERVICE_VALUES}" <<EOF

podMonitor:
  enabled: ${POD_MONITOR_ENABLED}
EOF

OSMO_HELM_AUTH_ARGS=()
if [[ "${OSMO_AUTH_ENABLED}" == "true" ]]; then
  OSMO_OIDC_ISSUER="${OSMO_OIDC_ISSUER:-$(auth_terraform_output oidc_issuer_url)}"
  OSMO_OIDC_JWKS="${OSMO_OIDC_JWKS:-$(auth_terraform_output oidc_jwks_uri)}"
  OSMO_OIDC_BROWSER_CLIENT_ID="${OSMO_OIDC_BROWSER_CLIENT_ID:-$(auth_terraform_output browser_client_id)}"
  OSMO_COOKIE_DOMAIN="${OSMO_COOKIE_DOMAIN:-$(auth_terraform_output cookie_domain)}"
  [[ -n "${OSMO_HOSTNAME:-}" ]] || die "OSMO_HOSTNAME (ALB FQDN) is required when OSMO_AUTH_ENABLED=true"
  [[ -n "${OSMO_OIDC_ISSUER}" ]] || die "OIDC issuer is empty; run deploy-auth.sh first"
  [[ -n "${OSMO_OIDC_CLIENT_SECRET:-}" ]] || die "OSMO_OIDC_CLIENT_SECRET is required (browser client secret)"

  # oauth2-proxy secrets (client_secret + random cookie_secret).
  OAUTH2_COOKIE_SECRET="${OAUTH2_COOKIE_SECRET:-$(openssl rand -base64 32 | tr -d '\n')}"
  kubectl -n "${OSMO_NAMESPACE}" create secret generic oauth2-proxy-secrets \
    --from-literal=client_secret="${OSMO_OIDC_CLIENT_SECRET}" \
    --from-literal=cookie_secret="${OAUTH2_COOKIE_SECRET}" \
    --dry-run=client -o yaml | kubectl apply -f -

  OSMO_HELM_AUTH_ARGS=(
    --set "global.hostname=${OSMO_HOSTNAME}"
    --set "services.service.hostname=${OSMO_HOSTNAME}"
    --set "services.service.auth.browser_client_id=${OSMO_OIDC_BROWSER_CLIENT_ID}"
    --set "gateway.envoy.hostname=${OSMO_HOSTNAME}"
    --set "gateway.envoy.jwt.providers[0].issuer=${OSMO_OIDC_ISSUER}"
    --set "gateway.envoy.jwt.providers[0].jwks_uri=${OSMO_OIDC_JWKS}"
    --set "gateway.envoy.jwt.providers[0].audience=${OSMO_OIDC_BROWSER_CLIENT_ID}"
    --set "gateway.envoy.jwt.providers[0].user_claim=email"
    --set "gateway.oauth2Proxy.oidcIssuerUrl=${OSMO_OIDC_ISSUER}"
    --set "gateway.oauth2Proxy.clientId=${OSMO_OIDC_BROWSER_CLIENT_ID}"
    --set "gateway.oauth2Proxy.cookieDomain=${OSMO_COOKIE_DOMAIN}"
    --set "gateway.oauth2Proxy.redis.serviceName=${REDIS_HOST}"
    --set "gateway.oauth2Proxy.redis.port=${REDIS_PORT}"
  )
  if [[ -n "${OSMO_ACM_CERT_ARN:-}" ]]; then
    OSMO_HELM_AUTH_ARGS+=(--set "gateway.envoy.ingress.albAnnotations.sslCertArn=${OSMO_ACM_CERT_ARN}")
  fi
fi

helm upgrade --install osmo-service "$(osmo_chart_ref service)" \
  --namespace "${OSMO_NAMESPACE}" \
  --version "${OSMO_CHART_VERSION}" \
  --values "${SERVICE_VALUES}" \
  "${OSMO_HELM_AUTH_ARGS[@]}" \
  --wait \
  --timeout 15m

kubectl -n "${OSMO_NAMESPACE}" rollout status deployment/osmo-service --timeout=10m

kubectl -n "${OSMO_NAMESPACE}" rollout status deployment/osmo-ui --timeout=10m || log "osmo-ui not ready yet"

# Keep nginx internal router: the 6.3 built-in router is session/subdomain-based and cannot
# replace this repo's path-router (/api/logger/* -> osmo-logger, /* -> osmo-service).
# See docs/superpowers/plans/2026-07-11-osmo-63-render-findings.md
if [[ "${OSMO_DEPLOY_INTERNAL_ROUTER}" == "true" ]]; then
  kubectl -n "${OSMO_NAMESPACE}" apply -f - <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${OSMO_INTERNAL_ROUTER_NAME}-nginx
  labels:
    app.kubernetes.io/name: ${OSMO_INTERNAL_ROUTER_NAME}
    app.kubernetes.io/part-of: aws-osmo-reference
data:
  default.conf: |
    server {
      listen 8080;
      client_max_body_size 0;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;

      proxy_http_version 1.1;
      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection "upgrade";

      location /api/logger/ {
        proxy_pass http://osmo-logger.${OSMO_NAMESPACE}.svc.cluster.local;
      }

      location / {
        proxy_pass http://osmo-service.${OSMO_NAMESPACE}.svc.cluster.local;
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${OSMO_INTERNAL_ROUTER_NAME}
  labels:
    app.kubernetes.io/name: ${OSMO_INTERNAL_ROUTER_NAME}
    app.kubernetes.io/part-of: aws-osmo-reference
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${OSMO_INTERNAL_ROUTER_NAME}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${OSMO_INTERNAL_ROUTER_NAME}
        app.kubernetes.io/part-of: aws-osmo-reference
    spec:
      automountServiceAccountToken: false
      containers:
        - name: nginx
          image: ${OSMO_INTERNAL_ROUTER_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8080
          volumeMounts:
            - name: config
              mountPath: /etc/nginx/conf.d/default.conf
              subPath: default.conf
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            runAsNonRoot: true
            runAsUser: 101
            runAsGroup: 101
      volumes:
        - name: config
          configMap:
            name: ${OSMO_INTERNAL_ROUTER_NAME}-nginx
---
apiVersion: v1
kind: Service
metadata:
  name: ${OSMO_INTERNAL_ROUTER_NAME}
  labels:
    app.kubernetes.io/name: ${OSMO_INTERNAL_ROUTER_NAME}
    app.kubernetes.io/part-of: aws-osmo-reference
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: ${OSMO_INTERNAL_ROUTER_NAME}
  ports:
    - name: http
      port: 80
      targetPort: http
YAML
  kubectl -n "${OSMO_NAMESPACE}" rollout status "deployment/${OSMO_INTERNAL_ROUTER_NAME}" --timeout=5m
fi

kubectl -n "${OSMO_NAMESPACE}" port-forward svc/osmo-service 9000:80 >/tmp/osmo-service-port-forward.log 2>&1 &
PORT_FORWARD_PID="$!"

for _ in $(seq 1 60); do
  if port_open 127.0.0.1 9000; then
    break
  fi
  sleep 2
done

port_open 127.0.0.1 9000 || die "OSMO service port-forward did not become ready"
login_osmo_with_token "http://127.0.0.1:9000" "${DEFAULT_ADMIN_TOKEN}" || die "failed to log in to OSMO with default admin token"

# OSMO 6.3 uses SERVICE.service_base_url for workflow control-plane callbacks.
# The in-cluster logger service serves workflow log websocket endpoints, while
# workflow data and dataset API calls must reach the service API.
jq -n \
  --arg service_base_url "${OSMO_SERVICE_CALLBACK_URL}" \
  '{
    service_base_url: $service_base_url
  }' >"${SERVICE_CONFIG}"

if ! osmo config update SERVICE \
  --file "${SERVICE_CONFIG}" \
  --description "Configure in-cluster AWS OSMO service URL" >/tmp/osmo-service-config.log 2>&1; then
  cat /tmp/osmo-service-config.log >&2
  die "failed to configure OSMO service URL"
fi

jq -n \
  --arg data_endpoint "s3://${OSMO_ARTIFACTS_BUCKET}/workflow-data" \
  --arg log_endpoint "s3://${OSMO_ARTIFACTS_BUCKET}/workflow-logs" \
  --arg app_endpoint "s3://${OSMO_ARTIFACTS_BUCKET}/workflow-apps" \
  --arg access_key_id "${WORKFLOW_DATA_ACCESS_KEY_ID}" \
  --arg access_key "${WORKFLOW_DATA_SECRET_ACCESS_KEY}" \
  --arg region "${AWS_REGION}" \
  --arg workflow_data_base_url "${OSMO_WORKFLOW_DATA_BASE_URL}" \
  --arg init_image "${OSMO_BACKEND_INIT_IMAGE}" \
  --arg client_image "${OSMO_BACKEND_CLIENT_IMAGE}" \
  '{
    backend_images: { init: $init_image, client: $client_image },
    workflow_data: {
      base_url: $workflow_data_base_url,
      credential: {
        endpoint: $data_endpoint,
        access_key_id: $access_key_id,
        access_key: $access_key,
        region: $region
      }
    },
    workflow_log: {
      credential: {
        endpoint: $log_endpoint,
        access_key_id: $access_key_id,
        access_key: $access_key,
        region: $region
      }
    },
    workflow_app: {
      credential: {
        endpoint: $app_endpoint,
        access_key_id: $access_key_id,
        access_key: $access_key,
        region: $region
      }
    },
    credential_config: {
      disable_data_validation: ["s3"]
    }
  }' >"${WORKFLOW_CONFIG}"

if ! osmo config update WORKFLOW \
  --file "${WORKFLOW_CONFIG}" \
  --description "Configure AWS workflow storage" >/tmp/osmo-workflow-config.log 2>&1; then
  cat /tmp/osmo-workflow-config.log >&2
  die "failed to configure OSMO workflow storage"
fi

jq -n \
  --arg bucket_name "${OSMO_DATASET_BUCKET_NAME}" \
  --arg dataset_path "s3://${OSMO_ARTIFACTS_BUCKET}/datasets" \
  --arg region "${AWS_REGION}" \
  '{
    buckets: {
      ($bucket_name): {
        dataset_path: $dataset_path,
        region: $region,
        mode: "read-write"
      }
    },
    default_bucket: $bucket_name
  }' >"${DATASET_CONFIG}"

if ! osmo config update DATASET \
  --file "${DATASET_CONFIG}" \
  --description "Configure AWS dataset bucket" >/tmp/osmo-dataset-config.log 2>&1; then
  cat /tmp/osmo-dataset-config.log >&2
  die "failed to configure OSMO dataset bucket"
fi

osmo credential delete aws-osmo-dataset >/dev/null 2>&1 || true
if ! osmo credential set aws-osmo-dataset \
  --type DATA \
  --payload \
  endpoint="s3://${OSMO_ARTIFACTS_BUCKET}" \
  region="${AWS_REGION}" \
  access_key_id="${WORKFLOW_DATA_ACCESS_KEY_ID}" \
  access_key="${WORKFLOW_DATA_SECRET_ACCESS_KEY}" >/tmp/osmo-dataset-credential.log 2>&1; then
  cat /tmp/osmo-dataset-credential.log >&2
  die "failed to configure OSMO dataset credential"
fi

osmo profile set bucket "${OSMO_DATASET_BUCKET_NAME}" >/dev/null

if [[ "${OSMO_AUTH_ENABLED}" == "true" ]]; then
  POOL_CURRENT="$(osmo config show POOL default)"
  printf '%s' "${POOL_CURRENT}" | jq \
    'del(.last_heartbeat, .parsed_resource_validations, .parsed_pod_template, .parsed_group_templates) |
     .roles["osmo-admin"].external_roles = ["osmo-admin"] |
     .roles["osmo-user"].external_roles  = ["osmo-user"] |
     .roles["osmo-ctrl"].external_roles  = ["osmo-ctrl"] |
     .roles["osmo-backend"].external_roles = ["osmo-backend"]' >"${POOL_CONFIG}"
  if ! osmo config update POOL default --file "${POOL_CONFIG}" \
    --description "Configure IdP external_roles mapping" >/tmp/osmo-roles-config.log 2>&1; then
    cat /tmp/osmo-roles-config.log >&2
    die "failed to configure OSMO external_roles mapping"
  fi
  log "OSMO external_roles mapping configured"
fi

if ! osmo user create backend-operator --roles osmo-backend >/tmp/osmo-backend-user.log 2>&1; then
  osmo user get backend-operator >/dev/null 2>&1 || {
    cat /tmp/osmo-backend-user.log >&2
    die "failed to create or verify backend-operator user"
  }
fi

osmo token delete backend-token --user backend-operator >/tmp/osmo-backend-token-delete.log 2>&1 || true

TOKEN_ARGS=(
  token set backend-token
  --user backend-operator
  --description "AWS reference backend operator token"
  --roles osmo-backend
  -t json
)
if [[ -n "${BACKEND_TOKEN_EXPIRES_AT}" ]]; then
  TOKEN_ARGS+=(--expires-at "${BACKEND_TOKEN_EXPIRES_AT}")
fi

if ! TOKEN_OUTPUT="$(osmo "${TOKEN_ARGS[@]}" 2>/tmp/osmo-backend-token.log)"; then
  cat /tmp/osmo-backend-token.log >&2
  die "failed to generate backend operator token"
fi

BACKEND_TOKEN="$(printf '%s' "${TOKEN_OUTPUT}" | jq -er '.token // .access_token // .accessToken // .value' 2>/dev/null || true)"
if [[ -z "${BACKEND_TOKEN}" ]]; then
  BACKEND_TOKEN="$(printf '%s' "${TOKEN_OUTPUT}" | tail -n 1 | tr -d '\r')"
fi
[[ -n "${BACKEND_TOKEN}" ]] || die "backend operator token generation returned an empty token"

kubectl -n "${OSMO_NAMESPACE}" create secret generic backend-operator-token \
  --from-literal=token="${BACKEND_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

cat >"${BACKEND_VALUES}" <<EOF
global:
  osmoImageLocation: "${OSMO_IMAGE_REGISTRY}"
  osmoImageTag: "${OSMO_IMAGE_TAG}"
  imagePullSecret: "${IMAGE_PULL_SECRET}"
  serviceUrl: "http://osmo-agent.${OSMO_NAMESPACE}.svc.cluster.local"
  backendName: "${OSMO_BACKEND_NAME}"
  backendNamespace: "${OSMO_WORKLOAD_NAMESPACE}"
  agentNamespace: "${OSMO_NAMESPACE}"
  accountTokenSecret: "backend-operator-token"
  accountTokenSecretKey: "token"
  loginMethod: "token"
  includeNamespaceUsage: "${OSMO_WORKLOAD_NAMESPACE}"

services:
  backendListener:
    resources:
      requests:
        cpu: "100m"
        memory: "256Mi"
      limits:
        memory: "512Mi"
  backendWorker:
    resources:
      requests:
        cpu: "100m"
        memory: "256Mi"
      limits:
        memory: "512Mi"

backendTestRunner:
  enabled: false

podMonitor:
  enabled: ${POD_MONITOR_ENABLED}
EOF

helm upgrade --install osmo-backend "$(osmo_chart_ref backend-operator)" \
  --namespace "${OSMO_NAMESPACE}" \
  --version "${OSMO_CHART_VERSION}" \
  --values "${BACKEND_VALUES}" \
  --wait \
  --timeout 15m

kubectl -n "${OSMO_NAMESPACE}" rollout status deployment/osmo-backend-osmo-backend-listener --timeout=10m
kubectl -n "${OSMO_NAMESPACE}" rollout status deployment/osmo-backend-osmo-backend-worker --timeout=10m

for _ in $(seq 1 60); do
  BACKEND_CURRENT="$(osmo config show BACKEND "${OSMO_BACKEND_NAME}" 2>/dev/null || true)"
  if [[ -n "${BACKEND_CURRENT}" ]]; then
    break
  fi
  sleep 5
done
[[ -n "${BACKEND_CURRENT:-}" ]] || die "OSMO backend ${OSMO_BACKEND_NAME} did not register with the service"

jq -n \
  --arg scheduler_name "${OSMO_K8S_SCHEDULER_NAME}" \
  '{
    description: "Default AWS reference backend",
    scheduler_settings: {
      scheduler_type: "kai",
      scheduler_name: $scheduler_name,
      scheduler_timeout: 30
    }
  }' >"${BACKEND_CONFIG}"

if printf '%s' "${BACKEND_CURRENT}" | jq -e \
  --arg scheduler_name "${OSMO_K8S_SCHEDULER_NAME}" \
  '.scheduler_settings.scheduler_type == "kai" and
   .scheduler_settings.scheduler_name == $scheduler_name and
   .scheduler_settings.scheduler_timeout == 30' >/dev/null; then
  log "OSMO backend scheduler is already configured"
else
  if ! osmo config update BACKEND "${OSMO_BACKEND_NAME}" \
    --file "${BACKEND_CONFIG}" \
    --description "Configure AWS backend scheduler" >/tmp/osmo-backend-config.log 2>&1; then
    cat /tmp/osmo-backend-config.log >&2
    die "failed to configure OSMO backend scheduler"
  fi
fi

if [[ "${OSMO_CONFIGURE_GPU_PLATFORM}" == "true" ]]; then
  POD_TEMPLATE_CURRENT="$(osmo config show POD_TEMPLATE 2>/dev/null || printf '{}')"
  gpu_pod_template_json "${POD_TEMPLATE_CURRENT}" "${OSMO_GPU_POD_TEMPLATE_NAME}" \
    "${OSMO_GPU_PLATFORM_LABEL_KEY}" "${OSMO_GPU_PLATFORM_LABEL_VALUE}" \
    "${OSMO_GPU_POD_DO_NOT_DISRUPT}" "${OSMO_GPU_POD_SHM_SIZE}" >"${GPU_POD_TEMPLATE_CONFIG}"

  if ! osmo config update POD_TEMPLATE --file "${GPU_POD_TEMPLATE_CONFIG}" \
    --description "Configure AWS G7e GPU pod template" >/tmp/osmo-gpu-pod-template.log 2>&1; then
    cat /tmp/osmo-gpu-pod-template.log >&2
    die "failed to configure OSMO G7e pod template"
  fi

  POOL_CURRENT="$(osmo config show POOL default)"
  gpu_pool_platform_json "${POOL_CURRENT}" "${OSMO_GPU_PLATFORM_NAME}" \
    "${OSMO_GPU_POD_TEMPLATE_NAME}" "AWS G7e RTX PRO 6000 Blackwell platform" >"${POOL_CONFIG}"
  if ! osmo config update POOL default --file "${POOL_CONFIG}" \
    --description "Configure AWS G7e GPU platform" >/tmp/osmo-pool-config.log 2>&1; then
    cat /tmp/osmo-pool-config.log >&2
    die "failed to configure OSMO pool GPU platform"
  fi
fi

# Optional GPU capacity-fallback platforms (opt-in via OSMO_FALLBACK_PLATFORMS).
# Each family registers a <family>-<gpu> OSMO platform whose nodeSelector points
# at aws.osmo.reference/nodepool=<family> (managed) or the family NodePool name.
if [[ -n "${OSMO_FALLBACK_PLATFORMS}" ]]; then
  IFS=',' read -r -a _fb_families <<<"${OSMO_FALLBACK_PLATFORMS}"
  for family in "${_fb_families[@]}"; do
    family="$(printf '%s' "${family}" | xargs)"
    [[ -n "${family}" ]] || continue
    fb_gpu_label="$(gpu_fallback_family_field "${family}" gpu_label)"
    fb_platform="${family}-${fb_gpu_label}"
    fb_pod_template="aws-${fb_platform}"
    fb_label_key="$(osmo_gpu_label_key)"
    fb_label_value="$(osmo_gpu_label_value "${family}")"

    POD_TEMPLATE_CURRENT="$(osmo config show POD_TEMPLATE 2>/dev/null || printf '{}')"
    gpu_pod_template_json "${POD_TEMPLATE_CURRENT}" "${fb_pod_template}" \
      "${fb_label_key}" "${fb_label_value}" "${OSMO_GPU_POD_DO_NOT_DISRUPT}" "${OSMO_GPU_POD_SHM_SIZE}" >"${GPU_POD_TEMPLATE_CONFIG}"
    if ! osmo config update POD_TEMPLATE --file "${GPU_POD_TEMPLATE_CONFIG}" \
      --description "Configure AWS ${fb_platform} pod template" >"/tmp/osmo-${family}-pod-template.log" 2>&1; then
      cat "/tmp/osmo-${family}-pod-template.log" >&2
      die "failed to configure OSMO ${family} pod template"
    fi

    POOL_CURRENT="$(osmo config show POOL default)"
    gpu_pool_platform_json "${POOL_CURRENT}" "${fb_platform}" "${fb_pod_template}" \
      "AWS ${family} ${fb_gpu_label} platform (capacity fallback)" >"${POOL_CONFIG}"
    if ! osmo config update POOL default --file "${POOL_CONFIG}" \
      --description "Configure AWS ${fb_platform} GPU platform" >"/tmp/osmo-${family}-pool-config.log" 2>&1; then
      cat "/tmp/osmo-${family}-pool-config.log" >&2
      die "failed to configure OSMO pool ${family} platform"
    fi
    log "OSMO ${fb_platform} platform configured"
  done
fi

log "OSMO service and backend operator deployment completed"
