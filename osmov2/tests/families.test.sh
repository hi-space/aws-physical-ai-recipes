# shellcheck shell=bash
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/common.sh"

assert_equals "$(gpu_fallback_family_field g6 gpu_label)" "l4" "g6 gpu label"
assert_equals "$(gpu_fallback_family_field g5 gpu_label)" "a10g" "g5 gpu label"
assert_equals "$(gpu_fallback_family_field g6e gpu_label)" "l40s" "g6e gpu label"
assert_equals "$(gpu_fallback_family_field g6 instance_types_version_key)" "g6_instance_types" "g6 iv key"
assert_equals "$(gpu_fallback_family_field g5 instance_types_version_key)" "g5_instance_types" "g5 iv key"
assert_equals "$(gpu_fallback_family_field g6e instance_types_version_key)" "g6e_instance_types" "g6e iv key"
assert_equals "$(gpu_fallback_family_field g6e nodepool_name)" "aws-osmo-g6e" "g6e nodepool name"
