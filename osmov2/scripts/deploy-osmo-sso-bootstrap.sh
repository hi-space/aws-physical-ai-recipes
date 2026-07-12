#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# ---------------------------------------------------------------------------
# One-shot Cognito SSO + CloudFront bootstrap for a fresh OSMO 6.3.1 deploy.
#
# The 6.3.1 SSO gateway has a circular dependency:
#   - deploy-osmo.sh requires the CloudFront osmo_ui_cloudfront_domain output
#     (used as the oauth2-proxy callback / cookie host); it dies without it.
#   - infra/cloudfront needs the osmo-gateway Service LoadBalancer DNS as its
#     origin, and that LB only exists after deploy-osmo.sh has run once.
#
# This wrapper breaks the cycle in four steps:
#   1. apply infra/cognito with a placeholder callback host.
#   2. run deploy-osmo.sh with OSMO_HOSTNAME=<placeholder> to create the
#      osmo-gateway Service LoadBalancer.
#   3. apply infra/cloudfront with the gateway LB as origin to mint the real
#      *.cloudfront.net domain.
#   4. re-apply infra/cognito with the real callback host and re-run
#      deploy-osmo.sh with the real OSMO_HOSTNAME.
#
# Prerequisites (run first): deploy-infra.sh, deploy-karpenter.sh,
# deploy-gpu-operator.sh, deploy-efa-device-plugin.sh. NGC_API_KEY must be set
# or discoverable (see common.sh load_ngc_api_key) for the deploy-osmo.sh runs.
#
# Region/workspace: this operates on whatever Terraform workspace is selected in
# each infra root. For a non-default region, export TF_WORKSPACE and point the
# *_VAR_FILE vars at the matching terraform.<region>.tfvars.
# ---------------------------------------------------------------------------

require_cmds aws kubectl terraform

COGNITO_TF_DIR="${COGNITO_TF_DIR:-${ROOT_DIR}/infra/cognito}"
CLOUDFRONT_TF_DIR="${CLOUDFRONT_TF_DIR:-${ROOT_DIR}/infra/cloudfront}"
DEPLOY_OSMO="${DEPLOY_OSMO:-${ROOT_DIR}/scripts/deploy-osmo.sh}"

# var-files default to each root's terraform.tfvars; override for other regions.
COGNITO_VAR_FILE="${COGNITO_VAR_FILE:-${COGNITO_TF_DIR}/terraform.tfvars}"
CLOUDFRONT_VAR_FILE="${CLOUDFRONT_VAR_FILE:-${CLOUDFRONT_TF_DIR}/terraform.tfvars}"

PLACEHOLDER_HOSTNAME="${PLACEHOLDER_HOSTNAME:-placeholder.cloudfront.net}"
OSMO_NAMESPACE="${OSMO_NAMESPACE:-$(terraform_output osmo_namespace 2>/dev/null || printf 'osmo')}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-osmo-gateway}"
GATEWAY_LB_WAIT_ATTEMPTS="${GATEWAY_LB_WAIT_ATTEMPTS:-60}"

# Grafana ALB origin for the second CloudFront distribution. Observability is
# deployed separately and may not exist yet at bootstrap time, so default it to
# the gateway LB as a resolvable placeholder and re-apply infra/cloudfront with
# the real Grafana ALB once deploy-observability.sh has run.
CLOUDFRONT_GRAFANA_ALB="${CLOUDFRONT_GRAFANA_ALB:-}"

tf_apply() {
  local dir="$1"
  shift
  terraform -chdir="${dir}" init -input=false >/dev/null
  terraform -chdir="${dir}" apply -input=false -auto-approve "$@"
}

tf_output_from() {
  terraform -chdir="$1" output -raw "$2" 2>/dev/null || true
}

cognito_var_file_args() {
  [[ -f "${COGNITO_VAR_FILE}" ]] && printf -- '-var-file=%s' "${COGNITO_VAR_FILE}"
}

cloudfront_var_file_args() {
  [[ -f "${CLOUDFRONT_VAR_FILE}" ]] && printf -- '-var-file=%s' "${CLOUDFRONT_VAR_FILE}"
}

wait_for_gateway_lb() {
  local hostname=""
  local attempt
  for attempt in $(seq 1 "${GATEWAY_LB_WAIT_ATTEMPTS}"); do
    hostname="$(kubectl -n "${OSMO_NAMESPACE}" get svc "${GATEWAY_SERVICE}" \
      -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
    if [[ -n "${hostname}" ]]; then
      printf '%s' "${hostname}"
      return 0
    fi
    sleep 5
  done
  return 1
}

# --- Step 1: Cognito with placeholder callback -----------------------------
log "step 1/4: applying infra/cognito with placeholder callback host"
# shellcheck disable=SC2046
tf_apply "${COGNITO_TF_DIR}" $(cognito_var_file_args) \
  -var "ui_hostname=${PLACEHOLDER_HOSTNAME}"

# --- Step 2: first OSMO deploy to create the gateway LB --------------------
log "step 2/4: deploying OSMO with placeholder hostname to create the gateway LoadBalancer"
OSMO_HOSTNAME="${PLACEHOLDER_HOSTNAME}" "${DEPLOY_OSMO}"

log "waiting for ${GATEWAY_SERVICE} LoadBalancer DNS in namespace ${OSMO_NAMESPACE}"
GATEWAY_LB="$(wait_for_gateway_lb)" ||
  die "${GATEWAY_SERVICE} LoadBalancer DNS did not appear; check the osmo-gateway Service"
log "gateway LoadBalancer: ${GATEWAY_LB}"

# --- Step 3: CloudFront with the gateway LB as origin ----------------------
GRAFANA_ALB="${CLOUDFRONT_GRAFANA_ALB:-${GATEWAY_LB}}"
if [[ -z "${CLOUDFRONT_GRAFANA_ALB}" ]]; then
  log "CLOUDFRONT_GRAFANA_ALB unset; using the gateway LB as a placeholder Grafana origin (re-apply infra/cloudfront after deploy-observability.sh)"
fi

log "step 3/4: applying infra/cloudfront with the gateway LB as origin"
# shellcheck disable=SC2046
tf_apply "${CLOUDFRONT_TF_DIR}" $(cloudfront_var_file_args) \
  -var "osmo_alb_dns_name=${GATEWAY_LB}" \
  -var "grafana_alb_dns_name=${GRAFANA_ALB}"

OSMO_UI_DOMAIN="$(tf_output_from "${CLOUDFRONT_TF_DIR}" osmo_ui_cloudfront_domain)"
[[ -n "${OSMO_UI_DOMAIN}" ]] ||
  die "infra/cloudfront did not emit osmo_ui_cloudfront_domain"
log "CloudFront OSMO UI domain: ${OSMO_UI_DOMAIN}"

# --- Step 4: real callback + real hostname redeploy ------------------------
log "step 4/4: re-applying infra/cognito with the real callback host"
# shellcheck disable=SC2046
tf_apply "${COGNITO_TF_DIR}" $(cognito_var_file_args) \
  -var "ui_hostname=${OSMO_UI_DOMAIN}"

log "redeploying OSMO with the real CloudFront hostname"
OSMO_HOSTNAME="${OSMO_UI_DOMAIN}" "${DEPLOY_OSMO}"

log "SSO bootstrap complete"
log "OSMO UI: https://${OSMO_UI_DOMAIN} (Cognito SSO; access restricted by the infra/cloudfront WAF IP allow list)"
