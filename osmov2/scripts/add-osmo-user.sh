#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# ---------------------------------------------------------------------------
# Add a human user to the Cognito pool and grant them OSMO roles.
#
# Two systems must be touched for a new user to be useful, and neither step
# implies the other:
#   1. Cognito account — the pool has allow_admin_create_user_only, so only an
#      administrator can create it.
#   2. OSMO roles — on first browser login idp-sync auto-creates the OSMO user
#      with osmo-default only, which permits login and profile reads but not
#      workflow submission. Roles are read from the OSMO database by the authz
#      sidecar; the chart's external_roles IDP-group mapping does not apply here
#      because the gateway's role filter reads a `roles` JWT claim that Cognito
#      ID tokens do not carry.
#
# The OSMO user is keyed on the Cognito `sub`, matching the gateway's
# jwt user_claim, so workflows submitted through the browser and through the CLI
# resolve to the same identity.
#
# Usage:
#   scripts/add-osmo-user.sh alice@example.com
#   scripts/add-osmo-user.sh alice@example.com --roles osmo-admin
#   scripts/add-osmo-user.sh alice@example.com --temporary
#   OSMO_NEW_USER_PASSWORD='...' scripts/add-osmo-user.sh alice@example.com
#
# Roles default to osmo-user (workflows on pool/default, plus app/dataset/
# credential access). Use --roles osmo-admin for a full administrator.
# ---------------------------------------------------------------------------

require_cmds aws kubectl osmo terraform

COGNITO_TF_DIR="${COGNITO_TF_DIR:-${ROOT_DIR}/infra/cognito}"
CLOUDFRONT_TF_DIR="${CLOUDFRONT_TF_DIR:-${ROOT_DIR}/infra/cloudfront}"
OSMO_NAMESPACE="${OSMO_NAMESPACE:-${TF_OUTPUT_OSMO_NAMESPACE:-osmo}}"
# osmo-service:80 serves only self-signed TLS, so a plaintext port-forward to it
# fails the token login. The internal router speaks plaintext HTTP.
OSMO_ROUTER_SERVICE="${OSMO_ROUTER_SERVICE:-osmo-internal-router}"
OSMO_SERVICE_LOCAL_PORT="${OSMO_SERVICE_LOCAL_PORT:-9110}"

usage() {
  sed -n '9,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

EMAIL=""
ROLES=()
TEMPORARY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --roles | -r)
      shift
      while [[ $# -gt 0 && "$1" != -* ]]; do
        ROLES+=("$1")
        shift
      done
      ;;
    --temporary)
      TEMPORARY=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [[ -z "${EMAIL}" ]] || die "unexpected argument: $1"
      EMAIL="$1"
      shift
      ;;
  esac
done

[[ -n "${EMAIL}" ]] || die "usage: $(basename "${BASH_SOURCE[0]}") <email> [--roles ROLE...] [--temporary]"
[[ "${EMAIL}" == *@*.* ]] || die "the pool uses email as the username, so <email> must be an email address: ${EMAIL}"
[[ ${#ROLES[@]} -gt 0 ]] || ROLES=(osmo-user)

# The cognito/cloudfront states are per-region Terraform workspaces whose
# selection can drift from infra/core (the deploy target's source of truth),
# which would point this at a pool in the wrong region.
OSMO_TF_WORKSPACE="${OSMO_TF_WORKSPACE:-$(terraform -chdir="${TF_DIR}" workspace show 2>/dev/null || true)}"
if [[ -n "${OSMO_TF_WORKSPACE}" ]]; then
  for _tf_dir in "${COGNITO_TF_DIR}" "${CLOUDFRONT_TF_DIR}"; do
    if terraform -chdir="${_tf_dir}" workspace list 2>/dev/null | grep -qE "^\*?[[:space:]]*${OSMO_TF_WORKSPACE}$"; then
      terraform -chdir="${_tf_dir}" workspace select "${OSMO_TF_WORKSPACE}" >/dev/null 2>&1 || true
    fi
  done
  log "using terraform workspace '${OSMO_TF_WORKSPACE}' for cognito/cloudfront outputs"
fi

tf_output_from() {
  terraform -chdir="$1" output -raw "$2" 2>/dev/null || true
}

POOL_ID="${OSMO_COGNITO_USER_POOL_ID:-$(tf_output_from "${COGNITO_TF_DIR}" user_pool_id)}"
[[ -n "${POOL_ID}" ]] || die "OSMO_COGNITO_USER_POOL_ID is unset and infra/cognito output user_pool_id is unavailable; apply infra/cognito or set OSMO_COGNITO_USER_POOL_ID"

# preferred_username drives the web UI's displayed identity and its "My
# Workflows" filter. Without it oauth2-proxy falls back to the Cognito sub, so
# the UI filters by a UUID and the user's own workflows never appear.
PREFERRED_USERNAME="${OSMO_NEW_USER_PREFERRED_USERNAME:-${EMAIL%%@*}}"

read_new_password() {
  local pw pw_confirm
  if [[ -n "${OSMO_NEW_USER_PASSWORD:-}" ]]; then
    printf '%s' "${OSMO_NEW_USER_PASSWORD}"
    return 0
  fi
  read -r -s -p "Password for ${EMAIL} (>=8 chars, upper, lower, number): " pw
  printf '\n' >&2
  read -r -s -p "Confirm: " pw_confirm
  printf '\n' >&2
  [[ -n "${pw}" ]] || die "password is required"
  [[ "${pw}" == "${pw_confirm}" ]] || die "passwords do not match"
  printf '%s' "${pw}"
}

# --- Step 1: Cognito account -----------------------------------------------
if aws cognito-idp admin-get-user \
  --user-pool-id "${POOL_ID}" --username "${EMAIL}" >/dev/null 2>&1; then
  log "cognito user ${EMAIL} already exists in ${POOL_ID}; not recreating"
  aws cognito-idp admin-update-user-attributes \
    --user-pool-id "${POOL_ID}" \
    --username "${EMAIL}" \
    --user-attributes "Name=preferred_username,Value=${PREFERRED_USERNAME}" >/dev/null
  log "set preferred_username=${PREFERRED_USERNAME} (existing browser sessions must sign out and back in to pick it up)"

  if [[ -n "${OSMO_NEW_USER_PASSWORD:-}" ]]; then
    aws cognito-idp admin-set-user-password \
      --user-pool-id "${POOL_ID}" \
      --username "${EMAIL}" \
      --password "${OSMO_NEW_USER_PASSWORD}" \
      --permanent
    log "reset password for ${EMAIL}"
  fi
else
  NEW_PASSWORD="$(read_new_password)"

  CREATE_ARGS=(
    --user-pool-id "${POOL_ID}"
    --username "${EMAIL}"
    --user-attributes
    "Name=email,Value=${EMAIL}"
    Name=email_verified,Value=true
    "Name=preferred_username,Value=${PREFERRED_USERNAME}"
  )

  if [[ "${TEMPORARY}" == "true" ]]; then
    # FORCE_CHANGE_PASSWORD: the hosted UI makes the user set their own password
    # on first login. SUPPRESS still applies because the default Cognito email
    # sender is rate limited to ~50/day before SES is wired up.
    CREATE_ARGS+=(--temporary-password "${NEW_PASSWORD}" --message-action SUPPRESS)
  else
    CREATE_ARGS+=(--message-action SUPPRESS)
  fi

  aws cognito-idp admin-create-user "${CREATE_ARGS[@]}" >/dev/null
  log "created cognito user ${EMAIL} (preferred_username=${PREFERRED_USERNAME})"

  if [[ "${TEMPORARY}" != "true" ]]; then
    aws cognito-idp admin-set-user-password \
      --user-pool-id "${POOL_ID}" \
      --username "${EMAIL}" \
      --password "${NEW_PASSWORD}" \
      --permanent
    log "set a permanent password (no forced change on first login)"
  fi
fi

SUB="$(aws cognito-idp admin-get-user \
  --user-pool-id "${POOL_ID}" \
  --username "${EMAIL}" \
  --query 'UserAttributes[?Name==`sub`].Value' \
  --output text)"
[[ -n "${SUB}" && "${SUB}" != "None" ]] || die "could not read the Cognito sub for ${EMAIL}"
log "cognito sub: ${SUB}"

# --- Step 2: OSMO roles ----------------------------------------------------
configure_kubectl

service_url="${OSMO_SERVICE_URL:-http://127.0.0.1:${OSMO_SERVICE_LOCAL_PORT}}"
port_forward_pid=""
user_log="$(mktemp)"
trap 'rm -f "${user_log}"; [[ -n "${port_forward_pid}" ]] && kill "${port_forward_pid}" 2>/dev/null || true' EXIT

if [[ "${service_url}" == "http://127.0.0.1:${OSMO_SERVICE_LOCAL_PORT}" ]] &&
  ! port_open 127.0.0.1 "${OSMO_SERVICE_LOCAL_PORT}"; then
  kubectl -n "${OSMO_NAMESPACE}" port-forward \
    "svc/${OSMO_ROUTER_SERVICE}" "${OSMO_SERVICE_LOCAL_PORT}:80" >/dev/null 2>&1 &
  port_forward_pid="$!"
  for _ in $(seq 1 30); do
    port_open 127.0.0.1 "${OSMO_SERVICE_LOCAL_PORT}" && break
    sleep 2
  done
  port_open 127.0.0.1 "${OSMO_SERVICE_LOCAL_PORT}" ||
    die "port-forward to ${OSMO_ROUTER_SERVICE} did not become ready"
fi

default_admin_token="$(kubectl -n "${OSMO_NAMESPACE}" get secret osmo-default-admin \
  -o jsonpath='{.data.password}' | base64_decode)"
login_osmo_with_token "${service_url}" "${default_admin_token}" ||
  die "failed to log in to OSMO with the default admin token"

if osmo user create "${SUB}" --roles "${ROLES[@]}" >"${user_log}" 2>&1; then
  log "created OSMO user ${SUB} with roles: ${ROLES[*]}"
elif osmo user update "${SUB}" --add-roles "${ROLES[@]}" >>"${user_log}" 2>&1; then
  # Already present because the user has logged in once (idp-sync) or this
  # script ran before.
  log "granted roles to existing OSMO user ${SUB}: ${ROLES[*]}"
else
  cat "${user_log}" >&2
  die "failed to create or grant roles to OSMO user ${SUB}"
fi

osmo user get "${SUB}" >&2 || true

UI_DOMAIN="$(tf_output_from "${CLOUDFRONT_TF_DIR}" osmo_ui_cloudfront_domain)"
log "done: ${EMAIL} -> ${SUB} (${ROLES[*]})"
[[ -n "${UI_DOMAIN}" ]] && log "web console: https://${UI_DOMAIN}"
log "the user's egress IP must be in the infra/cloudfront allowed_cidrs WAF list or the login page is unreachable"
log "this script logged the local CLI in as the OSMO default admin; re-run scripts/osmo-cli-login.sh to return to your own identity"
