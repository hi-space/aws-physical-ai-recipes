#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${TF_DIR:-${ROOT_DIR}/infra/core}"
VERSIONS_FILE="${ROOT_DIR}/versions.yaml"

log() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_cmds() {
  local cmd
  for cmd in "$@"; do
    require_cmd "$cmd"
  done
}

terraform_output() {
  local key="$1"
  local env_key
  env_key="TF_OUTPUT_$(printf '%s' "${key}" | tr '[:lower:]' '[:upper:]')"

  if [[ -n "${!env_key:-}" ]]; then
    printf '%s' "${!env_key}"
    return 0
  fi

  terraform -chdir="${TF_DIR}" output -raw "${key}"
}

version_value() {
  local key="$1"
  local value
  value="$(awk -v key="${key}:" '$1 == key {gsub(/^"|"$/, "", $2); print $2; exit}' "${VERSIONS_FILE}")"
  [[ -n "${value}" ]] || die "version key not found in versions.yaml: ${key}"
  printf '%s' "${value}"
}

load_ngc_api_key() {
  local key_file="${NGC_API_KEY_FILE:-${HOME:-}/.nvidia}"
  local key_value=""

  if [[ -n "${NGC_API_KEY:-}" ]]; then
    export NGC_API_KEY
    return 0
  fi

  if [[ -r "${key_file}" ]]; then
    if grep -q '=' "${key_file}"; then
      key_value="$(
        awk -F= '
          $1 ~ /^(export[[:space:]]+)?NGC_API_KEY$/ ||
          $1 ~ /^(apikey|api_key)$/ {
            print $2
            exit
          }
        ' "${key_file}" | tr -d '[:space:]'
      )"
      if [[ -z "${key_value}" ]]; then
        key_value="$(awk -F= 'NF >= 2 {print $2; exit}' "${key_file}" | tr -d '[:space:]')"
      fi
    else
      key_value="$(tr -d '[:space:]' <"${key_file}")"
    fi
  fi

  [[ -n "${key_value}" ]] || die "NGC_API_KEY is required for nvcr.io image pulls. Export NGC_API_KEY or write the raw key to ${key_file}."

  NGC_API_KEY="${key_value}"
  export NGC_API_KEY
}

configure_kubectl() {
  local region cluster_name
  region="$(terraform_output aws_region)"
  cluster_name="$(terraform_output cluster_name)"
  aws eks update-kubeconfig --region "${region}" --name "${cluster_name}" >/dev/null
}

port_open() {
  local host="$1"
  local port="$2"
  (: <"/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

base64_decode() {
  if base64 --decode </dev/null >/dev/null 2>&1; then
    base64 --decode
  else
    base64 -D
  fi
}

login_osmo_with_token() {
  local url="$1"
  local token="$2"
  local token_file
  token_file="$(mktemp)"
  chmod 600 "${token_file}"
  printf '%s' "${token}" >"${token_file}"

  if osmo login "${url}" --method=token --token-file "${token_file}" >/dev/null 2>&1; then
    rm -f "${token_file}"
    return 0
  fi

  if osmo login "${url}" --method=token --token "${token}" >/dev/null 2>&1; then
    rm -f "${token_file}"
    return 0
  fi

  rm -f "${token_file}"
  return 1
}

comma_values_to_yaml() {
  local csv="$1"
  local value
  tr ',' '\n' <<<"${csv}" | while IFS= read -r value; do
    value="$(printf '%s' "${value}" | xargs)"
    [[ -n "${value}" ]] || continue
    printf '              - "%s"\n' "${value}"
  done
}

# render_gpu_nodepool: emit a Karpenter NodePool manifest (pure; stdout only).
# Args: name ec2nodeclass family_label gpu_family_label instance_types_csv
#       capacity_type_csv zone cpu_limit memory_limit expire_after
#       consolidation_policy consolidate_after
# zone="" omits the topology zone requirement.
render_gpu_nodepool() {
  local name="$1" ec2nodeclass="$2" family_label="$3" gpu_family_label="$4"
  local instance_types_csv="$5" capacity_type_csv="$6" zone="$7"
  local cpu_limit="$8" memory_limit="$9" expire_after="${10}"
  local consolidation_policy="${11}" consolidate_after="${12}"

  local capacity_values instance_values zone_block=""
  capacity_values="$(comma_values_to_yaml "${capacity_type_csv}")"
  instance_values="$(comma_values_to_yaml "${instance_types_csv}")"
  [[ -n "${instance_values}" ]] || die "render_gpu_nodepool: instance_types_csv must contain at least one type"
  [[ -n "${capacity_values}" ]] || die "render_gpu_nodepool: capacity_type_csv must contain at least one type"

  if [[ -n "${zone}" ]]; then
    zone_block="$(printf '        - key: topology.kubernetes.io/zone\n          operator: In\n          values:\n              - "%s"\n' "${zone}"; printf x)"
    zone_block="${zone_block%x}"
  fi

  cat <<YAML
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: karpenter
    app.kubernetes.io/part-of: aws-osmo-reference
spec:
  template:
    metadata:
      labels:
        aws.osmo.reference/nodepool: ${family_label}
        aws.osmo.reference/gpu-family: ${gpu_family_label}
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: ${ec2nodeclass}
      taints:
        - key: nvidia.com/gpu
          value: "true"
          effect: NoSchedule
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]
        - key: karpenter.sh/capacity-type
          operator: In
          values:
${capacity_values}
${zone_block}        - key: node.kubernetes.io/instance-type
          operator: In
          values:
${instance_values}
      expireAfter: ${expire_after}
  limits:
    cpu: "${cpu_limit}"
    memory: "${memory_limit}"
  disruption:
    consolidationPolicy: ${consolidation_policy}
    consolidateAfter: ${consolidate_after}
YAML
}
