#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# Interactive OSMO CLI login for real (human) users behind the Cognito SSO
# gateway. OSMO 6.3.1 has no device-code endpoint and `osmo login --method
# token` expects an OSMO refresh token (not a Cognito token), so this script
# authenticates against Cognito directly with SRP (via pycognito), then writes
# ~/.config/osmo/login.yaml pointed at the CloudFront gateway. Envoy's jwt_authn
# maps the Cognito `sub` claim to x-osmo-user, so workflows submitted after this
# login are recorded under the caller's own identity (not the shared bootstrap
# service token). See README "CLI workflow ownership".
#
# The gateway sits behind CloudFront + WAF IP whitelist, so the machine running
# this must have its egress IP whitelisted (infra/cloudfront allowed_cidr_blocks)
# and be able to reach https://<osmo-ui-cloudfront-domain>.
#
# Usage:
#   OSMO_CLI_USER=alice@example.com scripts/osmo-cli-login.sh
#   (password is read interactively unless OSMO_CLI_PASSWORD is set)

require_cmds aws terraform python3

COGNITO_TF_DIR="${COGNITO_TF_DIR:-${ROOT_DIR}/infra/cognito}"
CLOUDFRONT_TF_DIR="${CLOUDFRONT_TF_DIR:-${ROOT_DIR}/infra/cloudfront}"

# The cognito/cloudfront states are per-region Terraform workspaces. Their
# selected workspace can drift from infra/core (e.g. left on a stale "use1"),
# which makes `output osmo_ui_cloudfront_domain` return a dead distribution.
# infra/core is the deploy target's source of truth, so align the auxiliary
# states to whatever workspace core is on before reading their outputs.
# Override with OSMO_TF_WORKSPACE to target a specific region explicitly.
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

OSMO_COGNITO_USER_POOL_ID="${OSMO_COGNITO_USER_POOL_ID:-$(tf_output_from "${COGNITO_TF_DIR}" user_pool_id)}"
OSMO_COGNITO_CLIENT_ID="${OSMO_COGNITO_CLIENT_ID:-$(tf_output_from "${COGNITO_TF_DIR}" client_id)}"
OSMO_COGNITO_CLIENT_SECRET="${OSMO_COGNITO_CLIENT_SECRET:-$(tf_output_from "${COGNITO_TF_DIR}" client_secret)}"
OSMO_COGNITO_REGION="${OSMO_COGNITO_REGION:-$(terraform_output aws_region)}"

# The CLI must talk to the gateway (not osmo-internal-router), so Envoy verifies
# the Cognito JWT and records the caller's sub. Default to the CloudFront domain.
OSMO_GATEWAY_URL="${OSMO_GATEWAY_URL:-https://$(tf_output_from "${CLOUDFRONT_TF_DIR}" osmo_ui_cloudfront_domain)}"

[[ -n "${OSMO_COGNITO_USER_POOL_ID}" ]] || die "OSMO_COGNITO_USER_POOL_ID is unset and infra/cognito output user_pool_id is unavailable; apply infra/cognito or set OSMO_COGNITO_USER_POOL_ID"
[[ -n "${OSMO_COGNITO_CLIENT_ID}" ]] || die "OSMO_COGNITO_CLIENT_ID is unset and infra/cognito output client_id is unavailable; apply infra/cognito or set OSMO_COGNITO_CLIENT_ID"
[[ "${OSMO_GATEWAY_URL}" != "https://" ]] || die "OSMO_GATEWAY_URL is unset and infra/cloudfront output osmo_ui_cloudfront_domain is unavailable; apply infra/cloudfront or set OSMO_GATEWAY_URL"

python3 -c 'import pycognito' 2>/dev/null || die "pycognito is required for SRP login. Install it with: pip install pycognito"

OSMO_CLI_USER="${OSMO_CLI_USER:-}"
if [[ -z "${OSMO_CLI_USER}" ]]; then
  read -r -p "Cognito username (email): " OSMO_CLI_USER
fi
[[ -n "${OSMO_CLI_USER}" ]] || die "OSMO_CLI_USER (Cognito username/email) is required"

OSMO_CLI_PASSWORD="${OSMO_CLI_PASSWORD:-}"
if [[ -z "${OSMO_CLI_PASSWORD}" ]]; then
  read -r -s -p "Password for ${OSMO_CLI_USER}: " OSMO_CLI_PASSWORD
  printf '\n' >&2
fi
[[ -n "${OSMO_CLI_PASSWORD}" ]] || die "password is required"

log "authenticating ${OSMO_CLI_USER} against Cognito pool ${OSMO_COGNITO_USER_POOL_ID} (SRP)"
TOKENS_JSON="$(
  OSMO_COGNITO_USER_POOL_ID="${OSMO_COGNITO_USER_POOL_ID}" \
  OSMO_COGNITO_CLIENT_ID="${OSMO_COGNITO_CLIENT_ID}" \
  OSMO_COGNITO_CLIENT_SECRET="${OSMO_COGNITO_CLIENT_SECRET}" \
  OSMO_COGNITO_REGION="${OSMO_COGNITO_REGION}" \
  OSMO_CLI_USER="${OSMO_CLI_USER}" \
  OSMO_CLI_PASSWORD="${OSMO_CLI_PASSWORD}" \
  python3 - <<'PY'
import json
import os
import sys

from pycognito import Cognito

kwargs = {
    "user_pool_id": os.environ["OSMO_COGNITO_USER_POOL_ID"],
    "client_id": os.environ["OSMO_COGNITO_CLIENT_ID"],
    "user_pool_region": os.environ.get("OSMO_COGNITO_REGION") or None,
    "username": os.environ["OSMO_CLI_USER"],
}
secret = os.environ.get("OSMO_COGNITO_CLIENT_SECRET") or ""
if secret:
    kwargs["client_secret"] = secret

try:
    u = Cognito(**kwargs)
    u.authenticate(password=os.environ["OSMO_CLI_PASSWORD"])
except Exception as exc:  # noqa: BLE001 - surface Cognito error text to the shell
    sys.stderr.write(f"cognito authentication failed: {exc}\n")
    sys.exit(1)

json.dump({"id_token": u.id_token, "refresh_token": u.refresh_token}, sys.stdout)
PY
)"

ID_TOKEN="$(printf '%s' "${TOKENS_JSON}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id_token"])')"
REFRESH_TOKEN="$(printf '%s' "${TOKENS_JSON}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["refresh_token"])')"
[[ -n "${ID_TOKEN}" ]] || die "Cognito login returned no id_token"

OSMO_GATEWAY_URL="${OSMO_GATEWAY_URL%/}"
OSMO_CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/osmo"
OSMO_LOGIN_FILE="${OSMO_CONFIG_DIR}/login.yaml"
mkdir -p "${OSMO_CONFIG_DIR}"

if [[ -f "${OSMO_LOGIN_FILE}" ]]; then
  BACKUP="${OSMO_LOGIN_FILE}.bak"
  cp -p "${OSMO_LOGIN_FILE}" "${BACKUP}"
  log "backed up existing login.yaml to ${BACKUP}"
fi

umask 077
cat >"${OSMO_LOGIN_FILE}" <<YAML
dev_login: null
name: ''
osmo_token: true
token_login:
  client_id: null
  id_token: ${ID_TOKEN}
  refresh_token: ${REFRESH_TOKEN}
  refresh_url: ${OSMO_GATEWAY_URL}/api/auth/jwt/access_token
  username: null
url: ${OSMO_GATEWAY_URL}
YAML

log "wrote ${OSMO_LOGIN_FILE} pointed at ${OSMO_GATEWAY_URL}"
log "workflows submitted now are recorded under your Cognito sub. Verify with: osmo workflow query"
