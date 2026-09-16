#!/usr/bin/env bash
set -euo pipefail

# Resolve an OSMO workflow ID to the pod IP a WebRTC streaming client must dial.
#
# Usage: scripts/get-workflow-pod-ip.sh <workflow-id> [task-name]
#
# Needs only `get pods` in the workload namespace, so an in-VPC viewing desktop
# can be granted a Role with that single verb instead of cluster-wide kubectl.

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmd kubectl

WORKFLOW_ID="${1:-}"
TASK_NAME="${2:-}"
[[ -n "${WORKFLOW_ID}" ]] || die "usage: $(basename "$0") <workflow-id> [task-name]"

# terraform is only needed when the namespace is not supplied, so a viewing
# desktop can set OSMO_WORKLOAD_NAMESPACE and skip the terraform state entirely.
if [[ -n "${OSMO_WORKLOAD_NAMESPACE:-}" ]]; then
  NAMESPACE="${OSMO_WORKLOAD_NAMESPACE}"
else
  require_cmd terraform
  NAMESPACE="$(terraform_output osmo_workload_namespace)"
fi

mapfile -t PODS < <(
  kubectl -n "${NAMESPACE}" get pods \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.podIP}{"\t"}{.spec.nodeName}{"\n"}{end}' |
    awk -v id="${WORKFLOW_ID}" -v task="${TASK_NAME}" '
      index($1, id) == 1 && (task == "" || index($1, task) > 0)
    '
)

if [[ "${#PODS[@]}" -eq 0 ]]; then
  die "no pod in namespace ${NAMESPACE} has a name starting with ${WORKFLOW_ID}. Workflow pods are deleted once the workflow ends — check 'osmo workflow query ${WORKFLOW_ID}'."
fi

mapfile -t RUNNING < <(printf '%s\n' "${PODS[@]}" | awk -F'\t' '$2 == "Running" && $3 != ""')

if [[ "${#RUNNING[@]}" -eq 0 ]]; then
  printf '%s\n' "${PODS[@]}" | awk -F'\t' '{printf "  %s\t%s\n", $1, $2}' >&2
  die "no Running pod with an assigned IP for ${WORKFLOW_ID}"
fi

if [[ "${#RUNNING[@]}" -gt 1 ]]; then
  log "${#RUNNING[@]} running pods match ${WORKFLOW_ID}; pass a task name to narrow it"
  printf '%s\n' "${RUNNING[@]}" | awk -F'\t' '{printf "  %s\t%s\n", $1, $3}' >&2
fi

POD_NAME="$(printf '%s' "${RUNNING[0]}" | cut -f1)"
POD_IP="$(printf '%s' "${RUNNING[0]}" | cut -f3)"
NODE_NAME="$(printf '%s' "${RUNNING[0]}" | cut -f4)"

log "pod ${POD_NAME} on ${NODE_NAME}"
log "point the Isaac Sim Streaming Client at ${POD_IP} (needs TCP 49100 plus the UDP media ports open from this client, and a route into the cluster VPC)"

printf '%s\n' "${POD_IP}"
