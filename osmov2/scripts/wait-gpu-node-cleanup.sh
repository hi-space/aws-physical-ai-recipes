#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds kubectl jq terraform

KARPENTER_NODEPOOL_NAME="${KARPENTER_NODEPOOL_NAME:-$(version_value karpenter_nodepool_name)}"
GPU_OPERATOR_NAMESPACE="${GPU_OPERATOR_NAMESPACE:-$(version_value gpu_operator_namespace)}"
GPU_CLEANUP_DELETE_PREWARM="${GPU_CLEANUP_DELETE_PREWARM:-true}"
GPU_CLEANUP_DELETE_COMPLETED_VALIDATORS="${GPU_CLEANUP_DELETE_COMPLETED_VALIDATORS:-true}"
GPU_CLEANUP_PREWARM_POD_NAME="${GPU_CLEANUP_PREWARM_POD_NAME:-aws-osmo-gpu-prewarm}"
GPU_CLEANUP_TIMEOUT_SECONDS="${GPU_CLEANUP_TIMEOUT_SECONDS:-1800}"
GPU_CLEANUP_POLL_SECONDS="${GPU_CLEANUP_POLL_SECONDS:-15}"

configure_kubectl
OSMO_WORKLOAD_NAMESPACE="$(terraform_output osmo_workload_namespace)"

if [[ "${GPU_CLEANUP_DELETE_PREWARM}" == "true" ]]; then
  kubectl -n "${OSMO_WORKLOAD_NAMESPACE}" delete pod "${GPU_CLEANUP_PREWARM_POD_NAME}" \
    --ignore-not-found >/dev/null
fi

if [[ "${GPU_CLEANUP_DELETE_COMPLETED_VALIDATORS}" == "true" ]]; then
  kubectl -n "${GPU_OPERATOR_NAMESPACE}" delete pod \
    -l app=nvidia-cuda-validator \
    --field-selector=status.phase=Succeeded \
    --ignore-not-found >/dev/null
fi

deadline="$(( $(date -u +%s) + GPU_CLEANUP_TIMEOUT_SECONDS ))"
attempt=0

while [[ "$(date -u +%s)" -lt "${deadline}" ]]; do
  nodeclaim_count="$(kubectl get nodeclaim -l "karpenter.sh/nodepool=${KARPENTER_NODEPOOL_NAME}" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  node_count="$(kubectl get nodes -l "karpenter.sh/nodepool=${KARPENTER_NODEPOOL_NAME}" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')"

  if [[ "${nodeclaim_count}" == "0" && "${node_count}" == "0" ]]; then
    log "Karpenter GPU nodes cleaned up"
    exit 0
  fi

  attempt="$((attempt + 1))"
  if (( attempt % 4 == 0 )); then
    log "waiting for GPU cleanup: ${nodeclaim_count} NodeClaims, ${node_count} Nodes remain"
  fi
  sleep "${GPU_CLEANUP_POLL_SECONDS}"
done

log "GPU cleanup did not complete before timeout"
kubectl get nodeclaim -l "karpenter.sh/nodepool=${KARPENTER_NODEPOOL_NAME}" -o wide >&2 || true
kubectl get nodes -l "karpenter.sh/nodepool=${KARPENTER_NODEPOOL_NAME}" \
  -L node.kubernetes.io/instance-type,nvidia.com/gpu.count,nvidia.com/gpu.product >&2 || true

while IFS= read -r node_name; do
  [[ -n "${node_name}" ]] || continue
  log "pods still associated with ${node_name}"
  kubectl get pods -A -o wide --field-selector "spec.nodeName=${node_name}" >&2 || true
done < <(kubectl get nodes -l "karpenter.sh/nodepool=${KARPENTER_NODEPOOL_NAME}" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)

kubectl get events -A --sort-by=.lastTimestamp | tail -80 >&2 || true
kubectl -n "$(version_value karpenter_namespace)" logs "deployment/$(version_value karpenter_release_name)" \
  --since=30m --tail=200 >&2 || true

die "Karpenter GPU nodes were not cleaned up"
