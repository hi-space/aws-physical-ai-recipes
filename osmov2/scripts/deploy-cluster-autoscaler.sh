#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws kubectl helm terraform

GPU_PROVISIONER="${GPU_PROVISIONER:-karpenter}"
if [[ "${GPU_PROVISIONER}" != "managed-nodegroup" ]]; then
  log "GPU_PROVISIONER=${GPU_PROVISIONER}; Cluster Autoscaler is only used for managed-nodegroup. Skipping."
  exit 0
fi

CA_REPO="${CA_REPO:-$(version_value cluster_autoscaler_repo)}"
CA_CHART_VERSION="${CA_CHART_VERSION:-$(version_value cluster_autoscaler_chart_version)}"
CA_NAMESPACE="${CA_NAMESPACE:-$(version_value cluster_autoscaler_namespace)}"
CA_RELEASE_NAME="${CA_RELEASE_NAME:-$(version_value cluster_autoscaler_release_name)}"

configure_kubectl
AWS_REGION="$(terraform_output aws_region)"
CLUSTER_NAME="$(terraform_output cluster_name)"

helm repo add autoscaler "${CA_REPO}" >/dev/null 2>&1 || true
helm repo update autoscaler >/dev/null

log "deploying Cluster Autoscaler ${CA_CHART_VERSION}"
helm upgrade --install "${CA_RELEASE_NAME}" autoscaler/cluster-autoscaler \
  --namespace "${CA_NAMESPACE}" \
  --version "${CA_CHART_VERSION}" \
  --set "autoDiscovery.clusterName=${CLUSTER_NAME}" \
  --set "awsRegion=${AWS_REGION}" \
  --set "rbac.serviceAccount.name=cluster-autoscaler" \
  --set "extraArgs.balance-similar-node-groups=true" \
  --set "extraArgs.skip-nodes-with-system-pods=false" \
  --wait --timeout 10m

kubectl -n "${CA_NAMESPACE}" rollout status "deployment/${CA_RELEASE_NAME}-aws-cluster-autoscaler" --timeout=10m
log "Cluster Autoscaler deployment completed"
