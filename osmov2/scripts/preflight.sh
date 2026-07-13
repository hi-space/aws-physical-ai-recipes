#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws terraform kubectl helm jq

if ! command -v osmo >/dev/null 2>&1; then
  log "OSMO CLI was not found. Install the pinned OSMO CLI before running deploy-osmo.sh or smoke-test.sh."
fi

if [[ "$(version_value image_registry)" == nvcr.io* ]]; then
  load_ngc_api_key
  log "NGC API key input is available for nvcr.io image pulls"
fi

if [[ -d "${ROOT_DIR}/upstream" || -d "${ROOT_DIR}/patches/osmo" ]]; then
  die "do not vendor upstream OSMO source or local OSMO patches in this repo"
fi

aws sts get-caller-identity >/dev/null
terraform -chdir="${TF_DIR}" fmt -check -recursive
terraform -chdir="${TF_DIR}" init -backend=false -input=false
terraform -chdir="${TF_DIR}" validate
"${ROOT_DIR}/scripts/scan-public-ingress.sh"

# ---------------------------------------------------------------------------
# tfvars sanity checks. These catch config gaps at step 1 instead of failing
# deep into the deploy (e.g. a missing allowed_cidrs would otherwise abort the
# CloudFront apply in the SSO bootstrap, ~40min of infra later). The var-file
# paths mirror the defaults used by deploy-osmo-sso-bootstrap.sh so we validate
# exactly what that step will consume; override them the same way for other
# regions.
# ---------------------------------------------------------------------------
COGNITO_VAR_FILE="${COGNITO_VAR_FILE:-${ROOT_DIR}/infra/cognito/terraform.tfvars}"
CLOUDFRONT_VAR_FILE="${CLOUDFRONT_VAR_FILE:-${ROOT_DIR}/infra/cloudfront/terraform.tfvars}"

# CloudFront allowed_cidrs is the one user-supplied value with no default and a
# hard variable validation (non-empty, no 0.0.0.0/0). Catch it now.
if [[ -f "${CLOUDFRONT_VAR_FILE}" ]]; then
  if ! grep -Eq '^[[:space:]]*allowed_cidrs[[:space:]]*=' "${CLOUDFRONT_VAR_FILE}"; then
    die "cloudfront var-file is missing allowed_cidrs: ${CLOUDFRONT_VAR_FILE}"
  fi
  if grep -Eq '0\.0\.0\.0/0' "${CLOUDFRONT_VAR_FILE}"; then
    die "cloudfront allowed_cidrs must not include 0.0.0.0/0: ${CLOUDFRONT_VAR_FILE}"
  fi
else
  die "cloudfront var-file not found: ${CLOUDFRONT_VAR_FILE} (copy terraform.tfvars.example and set allowed_cidrs)"
fi

# Cognito: if an initial SSO user is requested, a password must accompany it.
if [[ -f "${COGNITO_VAR_FILE}" ]]; then
  cognito_val() { awk -v k="$1" -F= '$0 ~ "^[[:space:]]*"k"[[:space:]]*=" {gsub(/[[:space:]"]/,"",$2); print $2; exit}' "${COGNITO_VAR_FILE}"; }
  admin_email="$(cognito_val admin_email || true)"
  admin_password="$(cognito_val admin_password || true)"
  if [[ -n "${admin_email}" && -z "${admin_password}" ]]; then
    die "cognito admin_email is set but admin_password is empty: ${COGNITO_VAR_FILE}"
  fi
else
  log "cognito var-file not found (${COGNITO_VAR_FILE}); the SSO bootstrap will create no initial user unless you set one"
fi

# Hugging Face token — consumed only by the smoke test (step 8). Warn, don't
# fail, since that step can be skipped.
HF_TOKEN_FILE="${HF_TOKEN_FILE:-${HOME}/.huggingface/token}"
if [[ -s "${HF_TOKEN_FILE}" ]]; then
  log "Hugging Face token found at ${HF_TOKEN_FILE} (smoke test will register it)"
else
  log "Hugging Face token not found at ${HF_TOKEN_FILE}; the CPU smoke test (step 8) needs it — set HF_TOKEN_FILE or SKIP_STEPS=8"
fi

log "preflight checks passed"
