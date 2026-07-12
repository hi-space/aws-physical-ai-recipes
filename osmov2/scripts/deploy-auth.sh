#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws terraform

AUTH_PROVIDER="${AUTH_PROVIDER:-cognito}"
if [[ "${AUTH_PROVIDER}" != "cognito" && "${AUTH_PROVIDER}" != "identity-center" ]]; then
  die "AUTH_PROVIDER must be cognito or identity-center (got: ${AUTH_PROVIDER})"
fi

ENVIRONMENT="$(terraform_output environment 2>/dev/null || printf 'dev-repro')"
if [[ "${ENVIRONMENT}" != "reference-ha" ]]; then
  log "WARNING: authentication is intended for reference-ha; current environment=${ENVIRONMENT}."
fi

TF_APPLY_ARGS=()
if [[ "${AUTH_PROVIDER}" == "cognito" ]]; then
  TF_APPLY_ARGS+=(-var "deploy_cognito=true" -var "deploy_identity_center=false")
else
  TF_APPLY_ARGS+=(-var "deploy_cognito=false" -var "deploy_identity_center=true")
fi

[[ -n "${OSMO_HOSTNAME:-}" ]] && TF_APPLY_ARGS+=(-var "osmo_hostname=${OSMO_HOSTNAME}")
[[ -n "${OSMO_AUTH_HOSTNAME:-}" ]] && TF_APPLY_ARGS+=(-var "osmo_auth_hostname=${OSMO_AUTH_HOSTNAME}")
[[ -n "${ROUTE53_ZONE_ID:-}" ]] && TF_APPLY_ARGS+=(-var "route53_zone_id=${ROUTE53_ZONE_ID}")
[[ -n "${AUTH_NAME_PREFIX:-}" ]] && TF_APPLY_ARGS+=(-var "name_prefix=${AUTH_NAME_PREFIX}")

log "deploying OSMO IdP (${AUTH_PROVIDER})"
terraform -chdir="${AUTH_TF_DIR}" init -input=false
terraform -chdir="${AUTH_TF_DIR}" apply "${TF_APPLY_ARGS[@]}" "$@"

log "auth provider:     $(auth_terraform_output auth_provider)"
log "OIDC issuer:       $(auth_terraform_output oidc_issuer_url)"
log "OIDC jwks:         $(auth_terraform_output oidc_jwks_uri)"
log "browser client id: $(auth_terraform_output browser_client_id)"
log "cookie domain:     $(auth_terraform_output cookie_domain)"

if [[ "${AUTH_PROVIDER}" == "identity-center" ]]; then
  log "NEXT: generate the OAuth client_secret in the Identity Center console (see infra/auth/README.md),"
  log "      then pass it to deploy-osmo.sh via OSMO_OIDC_CLIENT_SECRET."
fi
log "IdP deployment completed"
