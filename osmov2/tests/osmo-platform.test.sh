#!/usr/bin/env bash
# shellcheck shell=bash
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/common.sh"

pt="$(gpu_pod_template_json '{}' 'aws-g6e-l40s' 'karpenter.sh/nodepool' 'aws-osmo-g6e' 'true' '32Gi')"
assert_contains "$(printf '%s' "${pt}" | jq -r '.["aws-g6e-l40s"].spec.nodeSelector["karpenter.sh/nodepool"]')" "aws-osmo-g6e" "pod template nodeSelector"
assert_contains "$(printf '%s' "${pt}" | jq -r '.["aws-g6e-l40s"].spec.volumes[0].emptyDir.sizeLimit')" "32Gi" "pod template shm size"

pool="$(gpu_pool_platform_json '{"platforms":{},"last_heartbeat":"x"}' 'g6e-l40s' 'aws-g6e-l40s' 'AWS G6e L40S platform (capacity fallback)')"
assert_contains "$(printf '%s' "${pool}" | jq -r '.platforms["g6e-l40s"].override_pod_template[0]')" "aws-g6e-l40s" "pool override pod template"
assert_contains "$(printf '%s' "${pool}" | jq -r '.platforms["g6e-l40s"].description')" "L40S" "pool description"
assert_equals "$(printf '%s' "${pool}" | jq -r 'has("last_heartbeat")')" "false" "last_heartbeat stripped"
