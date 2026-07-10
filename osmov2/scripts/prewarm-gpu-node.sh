#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds kubectl jq terraform

GPU_PREWARM_NAME="${GPU_PREWARM_NAME:-aws-osmo-gpu-prewarm}"
GPU_PREWARM_INSTANCE_TYPE="${GPU_PREWARM_INSTANCE_TYPE:-g7e.2xlarge}"
GPU_PREWARM_TIMEOUT="${GPU_PREWARM_TIMEOUT:-45m}"
KARPENTER_NODEPOOL_NAME="${KARPENTER_NODEPOOL_NAME:-$(version_value karpenter_nodepool_name)}"

configure_kubectl
OSMO_WORKLOAD_NAMESPACE="$(terraform_output osmo_workload_namespace)"

kubectl create namespace "${OSMO_WORKLOAD_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

log "prewarming ${GPU_PREWARM_INSTANCE_TYPE} for OSMO GPU resource validation"
kubectl -n "${OSMO_WORKLOAD_NAMESPACE}" apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${GPU_PREWARM_NAME}
  labels:
    app.kubernetes.io/name: aws-osmo-gpu-prewarm
    app.kubernetes.io/part-of: aws-osmo-reference
spec:
  restartPolicy: Always
  terminationGracePeriodSeconds: 0
  nodeSelector:
    karpenter.sh/nodepool: ${KARPENTER_NODEPOOL_NAME}
    node.kubernetes.io/instance-type: ${GPU_PREWARM_INSTANCE_TYPE}
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  containers:
    - name: hold
      image: public.ecr.aws/docker/library/busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 86400"]
      resources:
        requests:
          cpu: 10m
          memory: 32Mi
          ephemeral-storage: 1Gi
        limits:
          memory: 64Mi
YAML

if ! kubectl -n "${OSMO_WORKLOAD_NAMESPACE}" wait \
  --for=condition=Ready \
  "pod/${GPU_PREWARM_NAME}" \
  --timeout="${GPU_PREWARM_TIMEOUT}"; then
  kubectl -n "${OSMO_WORKLOAD_NAMESPACE}" describe pod "${GPU_PREWARM_NAME}" >&2 || true
  kubectl -n "$(version_value karpenter_namespace)" logs "deployment/$(version_value karpenter_release_name)" \
    --since=30m --tail=200 >&2 || true
  die "GPU prewarm pod did not become ready"
fi

PREWARM_NODE="$(kubectl -n "${OSMO_WORKLOAD_NAMESPACE}" get pod "${GPU_PREWARM_NAME}" -o jsonpath='{.spec.nodeName}')"
INSTANCE_TYPE="$(kubectl get node "${PREWARM_NODE}" -o jsonpath='{.metadata.labels.node\.kubernetes\.io/instance-type}')"

[[ "${INSTANCE_TYPE}" == "${GPU_PREWARM_INSTANCE_TYPE}" ]] || die "prewarm pod landed on ${INSTANCE_TYPE}, expected ${GPU_PREWARM_INSTANCE_TYPE}"

for _ in $(seq 1 120); do
  GPU_ALLOCATABLE="$(kubectl get node "${PREWARM_NODE}" -o jsonpath='{.status.allocatable.nvidia\.com/gpu}' 2>/dev/null || true)"
  if [[ "${GPU_ALLOCATABLE:-0}" -ge 1 ]]; then
    break
  fi
  sleep 5
done

[[ "${GPU_ALLOCATABLE:-0}" -ge 1 ]] || die "prewarm node does not expose nvidia.com/gpu"

log "prewarm node ready: ${PREWARM_NODE} (${INSTANCE_TYPE}, ${GPU_ALLOCATABLE} GPUs)"
