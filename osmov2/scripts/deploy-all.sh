#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# ---------------------------------------------------------------------------
# One-shot orchestrator for a full OSMO 6.3.1 + SSO deploy.
#
# Runs the individual deploy scripts in dependency order and, on failure,
# prints exactly which step stopped and how to resume from it. Each underlying
# script is idempotent, so resuming re-runs the failed step from a clean slate.
#
# Steps (in order):
#   1  preflight                  tooling, creds, terraform validate
#   2  deploy-infra               EKS + RDS + Redis + S3/ECR/KMS/IRSA
#   3  deploy-karpenter           GPU NodePool(s)
#   4  deploy-gpu-operator        NVIDIA GPU Operator
#   5  deploy-efa-device-plugin   EFA device plugin (safe on non-EFA nodes)
#   6  deploy-osmo-sso-bootstrap  Cognito + CloudFront + OSMO (breaks the
#                                 CloudFront<->gateway-LB<->Cognito cycle)
#   7  validate-platform          cluster / OSMO / KAI / GPU runtime checks
#   8  smoke-test                 submit examples/osmo-smoke/workflow.yaml
#
# Usage:
#   scripts/deploy-all.sh                    # run all steps in order
#   RESUME_FROM=6 scripts/deploy-all.sh      # resume at step 6 (e.g. after a
#                                            # transient failure you've fixed)
#   SKIP_STEPS="5 8" scripts/deploy-all.sh   # skip EFA plugin and smoke test
#   DRY_RUN=true scripts/deploy-all.sh       # print the plan, run nothing
#
# Environment passed through to the underlying scripts still works, e.g.
# NGC_API_KEY, TF_WORKSPACE, COGNITO_VAR_FILE, CLOUDFRONT_VAR_FILE. For a
# non-default region, set those before invoking this wrapper.
#
# Note on GPU capacity: the SSO bootstrap (step 6) and smoke test (step 8) can
# stall if On-Demand G7e capacity is unavailable in the region's AZs. That is an
# external constraint, not a repo defect — see the README capacity-fallback
# section (G6/G6e) and retry, or SKIP_STEPS the GPU-dependent steps.
# ---------------------------------------------------------------------------

RESUME_FROM="${RESUME_FROM:-1}"
SKIP_STEPS="${SKIP_STEPS:-}"
DRY_RUN="${DRY_RUN:-false}"

# Step registry: index -> "script-basename|human description".
STEP_SCRIPTS=(
  "preflight.sh|Preflight: tooling, credentials, terraform validate"
  "deploy-infra.sh|Infrastructure: EKS, RDS, Redis, S3/ECR/KMS/IRSA"
  "deploy-karpenter.sh|Karpenter GPU NodePool(s)"
  "deploy-gpu-operator.sh|NVIDIA GPU Operator"
  "deploy-efa-device-plugin.sh|EFA device plugin"
  "deploy-osmo-sso-bootstrap.sh|OSMO + Cognito SSO + CloudFront bootstrap"
  "validate-platform.sh|Platform validation"
  "smoke-test.sh|CPU smoke workflow"
)
STEP_COUNT="${#STEP_SCRIPTS[@]}"

step_script() { printf '%s' "${STEP_SCRIPTS[$(( $1 - 1 ))]%%|*}"; }
step_desc()   { printf '%s' "${STEP_SCRIPTS[$(( $1 - 1 ))]##*|}"; }

is_skipped() {
  local n="$1" s
  for s in ${SKIP_STEPS}; do
    [[ "${s}" == "${n}" ]] && return 0
  done
  return 1
}

resume_hint() {
  local failed="$1"
  printf '\n' >&2
  log "──────────────────────────────────────────────────────────────"
  log "DEPLOY FAILED at step ${failed}/${STEP_COUNT}: $(step_desc "${failed}")"
  log "Fix the underlying issue, then resume from this step with:"
  log ""
  log "    RESUME_FROM=${failed} scripts/deploy-all.sh"
  log ""
  log "The step scripts are idempotent, so resuming re-runs it cleanly."
  log "──────────────────────────────────────────────────────────────"
}

if (( RESUME_FROM < 1 || RESUME_FROM > STEP_COUNT )); then
  die "RESUME_FROM must be between 1 and ${STEP_COUNT} (got ${RESUME_FROM})"
fi

log "OSMO full-deploy orchestrator — ${STEP_COUNT} steps, starting at step ${RESUME_FROM}"
[[ -n "${SKIP_STEPS}" ]] && log "Skipping steps: ${SKIP_STEPS}"

for (( i = RESUME_FROM; i <= STEP_COUNT; i++ )); do
  script="$(step_script "${i}")"
  desc="$(step_desc "${i}")"
  path="${ROOT_DIR}/scripts/${script}"

  if is_skipped "${i}"; then
    log "[${i}/${STEP_COUNT}] SKIP  ${desc}"
    continue
  fi

  [[ -x "${path}" ]] || die "step ${i} script not found or not executable: ${path}"

  log "[${i}/${STEP_COUNT}] RUN   ${desc}  (${script})"

  if [[ "${DRY_RUN}" == "true" ]]; then
    continue
  fi

  if ! "${path}"; then
    resume_hint "${i}"
    exit 1
  fi

  log "[${i}/${STEP_COUNT}] DONE  ${desc}"
done

if [[ "${DRY_RUN}" == "true" ]]; then
  log "dry run complete — no steps were executed"
  exit 0
fi

OSMO_UI_DOMAIN="$(terraform -chdir="${ROOT_DIR}/infra/cloudfront" output -raw osmo_ui_cloudfront_domain 2>/dev/null || true)"

log "──────────────────────────────────────────────────────────────"
log "All steps complete. OSMO is deployed and the CPU smoke path passed."
log "Next:"
log "  - GPU smoke:  see README 'Quick Start' (prewarm G7e, gpu-smoke workflow)"
if [[ -n "${OSMO_UI_DOMAIN}" ]]; then
  log "  - UI access:  https://${OSMO_UI_DOMAIN}  (Cognito SSO; WAF IP allow list)"
else
  log "  - UI access:  terraform -chdir=infra/cloudfront output -raw osmo_ui_cloudfront_domain"
fi
log "  - Examples:   examples/README.md,  e2e-pipeline-examples/README.md"
log "──────────────────────────────────────────────────────────────"
