# shellcheck shell=bash
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/common.sh"

GPU_PROVISIONER="karpenter"
assert_equals "$(osmo_gpu_label_key)" "karpenter.sh/nodepool" "karpenter label key"
assert_equals "$(osmo_gpu_label_value g6)" "aws-osmo-g6" "karpenter label value = nodepool name"

GPU_PROVISIONER="managed-nodegroup"
assert_equals "$(osmo_gpu_label_key)" "aws.osmo.reference/nodepool" "managed label key"
assert_equals "$(osmo_gpu_label_value g6)" "g6" "managed label value = family"
