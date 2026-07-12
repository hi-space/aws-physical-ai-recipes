# shellcheck shell=bash
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/common.sh"

# validate-platform.sh relies on gpu_fallback_family_field for nodepool names.
assert_equals "$(gpu_fallback_family_field g5 nodepool_name)" "aws-osmo-g5" "g5 nodepool name for validation"
assert_equals "$(gpu_fallback_family_field g6e nodepool_name)" "aws-osmo-g6e" "g6e nodepool name for validation"
