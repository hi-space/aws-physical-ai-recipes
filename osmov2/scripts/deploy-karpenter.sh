#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws kubectl helm jq terraform

KARPENTER_CHART="${KARPENTER_CHART:-$(version_value karpenter_chart)}"
KARPENTER_CHART_VERSION="${KARPENTER_CHART_VERSION:-$(version_value karpenter_chart_version)}"
KARPENTER_NAMESPACE="${KARPENTER_NAMESPACE:-$(version_value karpenter_namespace)}"
KARPENTER_RELEASE_NAME="${KARPENTER_RELEASE_NAME:-$(version_value karpenter_release_name)}"
KARPENTER_NODEPOOL_NAME="${KARPENTER_NODEPOOL_NAME:-$(version_value karpenter_nodepool_name)}"
KARPENTER_EC2NODECLASS_NAME="${KARPENTER_EC2NODECLASS_NAME:-$(version_value karpenter_ec2nodeclass_name)}"
KARPENTER_G7E_INSTANCE_TYPES="${KARPENTER_G7E_INSTANCE_TYPES:-$(version_value g7e_nut_pouring_instance_types)}"
EKS_AL2023_NVIDIA_AMI_RELEASE="${EKS_AL2023_NVIDIA_AMI_RELEASE:-$(version_value eks_al2023_nvidia_ami_release)}"
KARPENTER_NODE_ROOT_VOLUME_SIZE="${KARPENTER_NODE_ROOT_VOLUME_SIZE:-1024Gi}"
KARPENTER_NODEPOOL_CPU_LIMIT="${KARPENTER_NODEPOOL_CPU_LIMIT:-120}"
KARPENTER_NODEPOOL_MEMORY_LIMIT="${KARPENTER_NODEPOOL_MEMORY_LIMIT:-1200Gi}"
KARPENTER_NODE_EXPIRE_AFTER="${KARPENTER_NODE_EXPIRE_AFTER:-24h}"
KARPENTER_CONSOLIDATION_POLICY="${KARPENTER_CONSOLIDATION_POLICY:-WhenEmptyOrUnderutilized}"
KARPENTER_CONSOLIDATE_AFTER="${KARPENTER_CONSOLIDATE_AFTER:-5m}"
KARPENTER_CAPACITY_TYPE="${KARPENTER_CAPACITY_TYPE:-on-demand}"

# GPU capacity-fallback NodePools (opt-in via GPU_FALLBACK_FAMILIES).
# Backward-compat: DEPLOY_G6_NODEPOOL=true adds g6 to the families list.
# Each family reuses the g7e EC2NodeClass; only the NodePool differs
# (instance types, single-AZ pin, family labels). OSMO's <family> platform
# nodeSelector targets aws.osmo.reference/nodepool=<family>.
DEPLOY_G6_NODEPOOL="${DEPLOY_G6_NODEPOOL:-false}"
GPU_FALLBACK_FAMILIES="${GPU_FALLBACK_FAMILIES:-}"
GPU_FALLBACK_ZONE="${GPU_FALLBACK_ZONE:-ap-northeast-2a}"
GPU_FALLBACK_CPU_LIMIT="${GPU_FALLBACK_CPU_LIMIT:-96}"
GPU_FALLBACK_MEMORY_LIMIT="${GPU_FALLBACK_MEMORY_LIMIT:-768Gi}"

configure_kubectl

AWS_REGION="$(terraform_output aws_region)"
CLUSTER_NAME="$(terraform_output cluster_name)"
CLUSTER_ENDPOINT="$(terraform_output cluster_endpoint)"
KARPENTER_QUEUE_NAME="$(terraform_output karpenter_interruption_queue_name)"
KARPENTER_NODE_IAM_ROLE_NAME="$(terraform_output karpenter_node_iam_role_name)"
K8S_VERSION="$(version_value eks_cluster_version)"
AMI_SSM_PARAMETER="/aws/service/eks/optimized-ami/${K8S_VERSION}/amazon-linux-2023/x86_64/nvidia/${EKS_AL2023_NVIDIA_AMI_RELEASE}/image_id"

log "deploying Karpenter ${KARPENTER_CHART_VERSION}"
helm registry logout public.ecr.aws >/dev/null 2>&1 || true
helm upgrade --install "${KARPENTER_RELEASE_NAME}" "${KARPENTER_CHART}" \
  --namespace "${KARPENTER_NAMESPACE}" \
  --create-namespace \
  --version "${KARPENTER_CHART_VERSION}" \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.clusterEndpoint=${CLUSTER_ENDPOINT}" \
  --set "settings.interruptionQueue=${KARPENTER_QUEUE_NAME}" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait \
  --timeout 15m

kubectl -n "${KARPENTER_NAMESPACE}" rollout status deployment/"${KARPENTER_RELEASE_NAME}" --timeout=10m
kubectl wait --for=condition=Established crd/nodepools.karpenter.sh --timeout=5m
kubectl wait --for=condition=Established crd/nodeclaims.karpenter.sh --timeout=5m
kubectl wait --for=condition=Established crd/ec2nodeclasses.karpenter.k8s.aws --timeout=5m

if ! aws ssm get-parameter --region "${AWS_REGION}" --name "${AMI_SSM_PARAMETER}" >/dev/null; then
  die "pinned EKS AL2023 NVIDIA AMI SSM parameter was not found: ${AMI_SSM_PARAMETER}"
fi

log "applying G7e EC2NodeClass and NodePool"
kubectl apply -f - <<YAML
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: ${KARPENTER_EC2NODECLASS_NAME}
  labels:
    app.kubernetes.io/name: karpenter
    app.kubernetes.io/part-of: aws-osmo-reference
spec:
  amiFamily: AL2023
  role: "${KARPENTER_NODE_IAM_ROLE_NAME}"
  amiSelectorTerms:
    - ssmParameter: "${AMI_SSM_PARAMETER}"
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "${CLUSTER_NAME}"
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "${CLUSTER_NAME}"
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1
    httpTokens: required
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: ${KARPENTER_NODE_ROOT_VOLUME_SIZE}
        volumeType: gp3
        encrypted: true
        deleteOnTermination: true
  tags:
    Project: aws-osmo
    Reference: aws-osmo
    ManagedBy: karpenter
YAML

render_gpu_nodepool \
  "${KARPENTER_NODEPOOL_NAME}" \
  "${KARPENTER_EC2NODECLASS_NAME}" \
  "g7e" "rtx-pro-6000" \
  "${KARPENTER_G7E_INSTANCE_TYPES}" \
  "${KARPENTER_CAPACITY_TYPE}" \
  "" \
  "${KARPENTER_NODEPOOL_CPU_LIMIT}" \
  "${KARPENTER_NODEPOOL_MEMORY_LIMIT}" \
  "${KARPENTER_NODE_EXPIRE_AFTER}" \
  "${KARPENTER_CONSOLIDATION_POLICY}" \
  "${KARPENTER_CONSOLIDATE_AFTER}" | kubectl apply -f -

kubectl wait --for=condition=Ready "ec2nodeclass/${KARPENTER_EC2NODECLASS_NAME}" --timeout=10m
kubectl wait --for=condition=Ready "nodepool/${KARPENTER_NODEPOOL_NAME}" --timeout=10m

log "Karpenter G7e NodePool deployment completed"

# ---------------------------------------------------------------------------
# Optional GPU capacity-fallback NodePools (opt-in via GPU_FALLBACK_FAMILIES).
# Each family reuses the g7e EC2NodeClass; only the NodePool differs
# (instance types, single-AZ pin, family labels). OSMO's <family> platform
# nodeSelector targets aws.osmo.reference/nodepool=<family>.
# ---------------------------------------------------------------------------
if [[ "${DEPLOY_G6_NODEPOOL}" == "true" && ",${GPU_FALLBACK_FAMILIES}," != *",g6,"* ]]; then
  GPU_FALLBACK_FAMILIES="${GPU_FALLBACK_FAMILIES:+${GPU_FALLBACK_FAMILIES},}g6"
fi

if [[ -n "${GPU_FALLBACK_FAMILIES}" ]]; then
  IFS=',' read -r -a _families <<<"${GPU_FALLBACK_FAMILIES}"
  for family in "${_families[@]}"; do
    family="$(printf '%s' "${family}" | xargs)"
    [[ -n "${family}" ]] || continue
    fam_nodepool="$(gpu_fallback_family_field "${family}" nodepool_name)"
    fam_gpu_label="$(gpu_fallback_family_field "${family}" gpu_label)"
    fam_instances="$(gpu_fallback_family_field "${family}" instance_types)"
    log "applying ${family} (${fam_gpu_label}) NodePool ${fam_nodepool} in ${GPU_FALLBACK_ZONE}"
    render_gpu_nodepool \
      "${fam_nodepool}" "${KARPENTER_EC2NODECLASS_NAME}" \
      "${family}" "${fam_gpu_label}" \
      "${fam_instances}" "${KARPENTER_CAPACITY_TYPE}" "${GPU_FALLBACK_ZONE}" \
      "${GPU_FALLBACK_CPU_LIMIT}" "${GPU_FALLBACK_MEMORY_LIMIT}" \
      "${KARPENTER_NODE_EXPIRE_AFTER}" "${KARPENTER_CONSOLIDATION_POLICY}" "${KARPENTER_CONSOLIDATE_AFTER}" \
      | kubectl apply -f -
    kubectl wait --for=condition=Ready "nodepool/${fam_nodepool}" --timeout=10m
    log "Karpenter ${family} NodePool deployment completed"
  done
fi
