#!/usr/bin/env bash
set -euo pipefail

# Update OSMO backend grafana_url to the CloudFront Grafana endpoint.
# Usage: GRAFANA_URL=https://xxx.cloudfront.net ./scripts/update-grafana-url.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds kubectl jq

GRAFANA_URL="${GRAFANA_URL:?Set GRAFANA_URL to the Grafana CloudFront domain (https://xxx.cloudfront.net)}"
OSMO_NAMESPACE="${OSMO_NAMESPACE:-osmo}"
OSMO_BACKEND_NAME="${OSMO_BACKEND_NAME:-default}"
OSMO_SERVICE_LOCAL_PORT="${OSMO_SERVICE_LOCAL_PORT:-8090}"

configure_kubectl

service_url="${OSMO_SERVICE_URL:-http://127.0.0.1:${OSMO_SERVICE_LOCAL_PORT}}"
port_forward_pid=""
backend_config="$(mktemp)"
trap 'rm -f "${backend_config}"; [[ -n "${port_forward_pid}" ]] && kill "${port_forward_pid}" 2>/dev/null || true' EXIT

if [[ "${service_url}" == "http://127.0.0.1:${OSMO_SERVICE_LOCAL_PORT}" ]] && ! port_open 127.0.0.1 "${OSMO_SERVICE_LOCAL_PORT}"; then
  kubectl -n "${OSMO_NAMESPACE}" port-forward "svc/osmo-service" "${OSMO_SERVICE_LOCAL_PORT}:80" >/dev/null 2>&1 &
  port_forward_pid="$!"
  for _ in $(seq 1 30); do
    port_open 127.0.0.1 "${OSMO_SERVICE_LOCAL_PORT}" && break
    sleep 2
  done
  port_open 127.0.0.1 "${OSMO_SERVICE_LOCAL_PORT}" || die "OSMO service port-forward did not become ready"
fi

default_admin_token="$(kubectl -n "${OSMO_NAMESPACE}" get secret osmo-default-admin -o jsonpath='{.data.password}' | base64_decode)"
login_osmo_with_token "${service_url}" "${default_admin_token}" || die "failed to log in to OSMO"

backend_current="$(osmo config show BACKEND "${OSMO_BACKEND_NAME}")"
printf '%s' "${backend_current}" | jq --arg grafana_url "${GRAFANA_URL}" '.grafana_url = $grafana_url | .dashboard_url = (.dashboard_url // "")' >"${backend_config}"

osmo config update BACKEND "${OSMO_BACKEND_NAME}" \
  --file "${backend_config}" \
  --description "Update grafana_url to CloudFront endpoint"

osmo config show BACKEND "${OSMO_BACKEND_NAME}" | jq -e --arg grafana_url "${GRAFANA_URL}" '.grafana_url == $grafana_url' >/dev/null
log "grafana_url updated to ${GRAFANA_URL}"
