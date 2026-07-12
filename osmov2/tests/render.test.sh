# shellcheck shell=bash
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/common.sh"

# render_gpu_nodepool is added in Task 2.
out="$(render_gpu_nodepool "aws-osmo-g7e" "aws-osmo-g7e" "g7e" "rtx-pro-6000" "g7e.2xlarge,g7e.4xlarge" "on-demand" "" "120" "1200Gi" "24h" "WhenEmptyOrUnderutilized" "5m")"
assert_contains "${out}" 'name: aws-osmo-g7e' 'nodepool name present'
assert_contains "${out}" 'aws.osmo.reference/nodepool: g7e' 'nodepool family label'
assert_contains "${out}" 'aws.osmo.reference/gpu-family: rtx-pro-6000' 'gpu-family label'
assert_contains "${out}" '- "on-demand"' 'capacity-type on-demand'
assert_contains "${out}" '- "g7e.2xlarge"' 'instance type rendered'
assert_not_contains "${out}" 'topology.kubernetes.io/zone' 'no zone pin when empty'

spot_out="$(render_gpu_nodepool "aws-osmo-g6" "aws-osmo-g7e" "g6" "l4" "g6.2xlarge" "on-demand,spot" "ap-northeast-2a" "96" "768Gi" "24h" "WhenEmptyOrUnderutilized" "5m")"
assert_contains "${spot_out}" '- "on-demand"' 'mixed capacity on-demand'
assert_contains "${spot_out}" '- "spot"' 'mixed capacity spot'
assert_contains "${spot_out}" 'topology.kubernetes.io/zone' 'zone pin present'
assert_contains "${spot_out}" '- "ap-northeast-2a"' 'zone value present'
assert_contains "${spot_out}" 'aws.osmo.reference/nodepool: g6' 'g6 family label'
