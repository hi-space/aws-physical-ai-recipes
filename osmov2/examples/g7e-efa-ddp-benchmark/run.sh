#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLE_DIR="${ROOT_DIR}/examples/g7e-efa-ddp-benchmark"
VERSIONS_FILE="${ROOT_DIR}/versions.yaml"

version_value() {
  local key="$1"
  local value
  value="$(awk -v key="${key}:" '$1 == key {gsub(/^"|"$/, "", $2); print $2; exit}' "${VERSIONS_FILE}")"
  [[ -n "${value}" ]] || {
    echo "version key not found in versions.yaml: ${key}" >&2
    exit 1
  }
  printf '%s' "${value}"
}

KUBE_CONTEXT="${KUBE_CONTEXT:-}"
NAMESPACE="${NAMESPACE:-osmo-workflows}"
IMAGE="${IMAGE:-$(version_value pytorch_training_image)}"
BENCH_NAME="${BENCH_NAME:-g7e-efa-ddp-benchmark}"
MODES="${MODES:-efa socket}"
PARAM_MIB="${PARAM_MIB:-256}"
WARMUP_STEPS="${WARMUP_STEPS:-2}"
STEPS="${STEPS:-12}"
BUCKET_CAP_MB="${BUCKET_CAP_MB:-64}"
TIMEOUT="${TIMEOUT:-20m}"
VALIDATION_DIR="${VALIDATION_DIR:-${EXAMPLE_DIR}/validation}"
KEEP_RESOURCES="${KEEP_RESOURCES:-false}"

if [[ -z "${KUBE_CONTEXT}" ]]; then
  echo "KUBE_CONTEXT is required" >&2
  exit 1
fi

mkdir -p "${VALIDATION_DIR}"
kubectl_ctx=(kubectl --context "${KUBE_CONTEXT}" -n "${NAMESPACE}")
"${kubectl_ctx[@]}" create namespace "${NAMESPACE}" >/dev/null 2>&1 || true

cleanup_mode() {
  local mode="$1"
  local run_name="${BENCH_NAME}-${mode}"
  if [[ "${KEEP_RESOURCES}" != "true" ]]; then
    "${kubectl_ctx[@]}" delete pod "${run_name}-master" "${run_name}-worker" --ignore-not-found=true --wait=true --timeout=2m >/dev/null || true
    "${kubectl_ctx[@]}" delete service "${run_name}-master" --ignore-not-found=true >/dev/null || true
    "${kubectl_ctx[@]}" delete configmap "${run_name}-script" --ignore-not-found=true >/dev/null || true
  fi
}

mode_env_yaml() {
  local mode="$1"
  if [[ "${mode}" == "efa" ]]; then
    cat <<'YAML'
        - name: FI_PROVIDER
          value: efa
        - name: FI_EFA_USE_DEVICE_RDMA
          value: "1"
YAML
  else
    cat <<'YAML'
        - name: NCCL_NET
          value: Socket
        - name: NCCL_SOCKET_IFNAME
          value: eth0
YAML
  fi
}

mode_resource_yaml() {
  local mode="$1"
  if [[ "${mode}" == "efa" ]]; then
    cat <<'YAML'
          vpc.amazonaws.com/efa: "1"
          hugepages-2Mi: 5120Mi
YAML
  fi
}

apply_mode() {
  local mode="$1"
  local run_name="${BENCH_NAME}-${mode}"

  cleanup_mode "${mode}"
  "${kubectl_ctx[@]}" create configmap "${run_name}-script" \
    --from-file=train.py="${EXAMPLE_DIR}/train.py" \
    --dry-run=client -o yaml | "${kubectl_ctx[@]}" apply -f - >/dev/null

  "${kubectl_ctx[@]}" apply -f - <<YAML
apiVersion: v1
kind: Service
metadata:
  name: ${run_name}-master
  labels:
    app.kubernetes.io/name: ${run_name}
spec:
  selector:
    app.kubernetes.io/name: ${run_name}
    app.kubernetes.io/component: master
  ports:
    - name: rendezvous
      port: 29500
      targetPort: 29500
---
apiVersion: v1
kind: Pod
metadata:
  name: ${run_name}-worker
  labels:
    app.kubernetes.io/name: ${run_name}
    app.kubernetes.io/component: worker
spec:
  restartPolicy: Never
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  nodeSelector:
    aws.osmo.reference/nodepool: g7e
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: ${run_name}
          topologyKey: kubernetes.io/hostname
  containers:
    - name: train
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      env:
        - name: NCCL_DEBUG
          value: INFO
        - name: NCCL_DEBUG_SUBSYS
          value: INIT,NET
$(mode_env_yaml "${mode}")
      resources:
        requests:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
$(mode_resource_yaml "${mode}")
        limits:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
$(mode_resource_yaml "${mode}")
      volumeMounts:
        - name: training-script
          mountPath: /workspace
        - name: shmem
          mountPath: /dev/shm
      command:
        - /bin/bash
        - -lc
        - |
          set -euo pipefail
          python -m torch.distributed.run \
            --nnodes=2 \
            --nproc_per_node=1 \
            --node_rank=1 \
            --master_addr=${run_name}-master \
            --master_port=29500 \
            /workspace/train.py \
            --mode ${mode} \
            --param-mib ${PARAM_MIB} \
            --warmup-steps ${WARMUP_STEPS} \
            --steps ${STEPS} \
            --bucket-cap-mb ${BUCKET_CAP_MB}
  volumes:
    - name: training-script
      configMap:
        name: ${run_name}-script
    - name: shmem
      emptyDir:
        medium: Memory
        sizeLimit: 8Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: ${run_name}-master
  labels:
    app.kubernetes.io/name: ${run_name}
    app.kubernetes.io/component: master
spec:
  restartPolicy: Never
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  nodeSelector:
    aws.osmo.reference/nodepool: g7e
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: ${run_name}
          topologyKey: kubernetes.io/hostname
  containers:
    - name: train
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      env:
        - name: NCCL_DEBUG
          value: INFO
        - name: NCCL_DEBUG_SUBSYS
          value: INIT,NET
$(mode_env_yaml "${mode}")
      resources:
        requests:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
$(mode_resource_yaml "${mode}")
        limits:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
$(mode_resource_yaml "${mode}")
      volumeMounts:
        - name: training-script
          mountPath: /workspace
        - name: shmem
          mountPath: /dev/shm
      command:
        - /bin/bash
        - -lc
        - |
          set -euo pipefail
          python -m torch.distributed.run \
            --nnodes=2 \
            --nproc_per_node=1 \
            --node_rank=0 \
            --master_addr=${run_name}-master \
            --master_port=29500 \
            /workspace/train.py \
            --mode ${mode} \
            --param-mib ${PARAM_MIB} \
            --warmup-steps ${WARMUP_STEPS} \
            --steps ${STEPS} \
            --bucket-cap-mb ${BUCKET_CAP_MB}
  volumes:
    - name: training-script
      configMap:
        name: ${run_name}-script
    - name: shmem
      emptyDir:
        medium: Memory
        sizeLimit: 8Gi
YAML
}

run_mode() {
  local mode="$1"
  local run_name="${BENCH_NAME}-${mode}"
  echo "=== ${mode} DDP benchmark ==="
  apply_mode "${mode}"

  if ! "${kubectl_ctx[@]}" wait --for=condition=Ready "pod/${run_name}-master" "pod/${run_name}-worker" --timeout="${TIMEOUT}"; then
    "${kubectl_ctx[@]}" describe pod "${run_name}-master" "${run_name}-worker" >"${VALIDATION_DIR}/${mode}-describe.txt" || true
    "${kubectl_ctx[@]}" logs "${run_name}-master" >"${VALIDATION_DIR}/${mode}-master.log" || true
    "${kubectl_ctx[@]}" logs "${run_name}-worker" >"${VALIDATION_DIR}/${mode}-worker.log" || true
    exit 1
  fi

  if ! "${kubectl_ctx[@]}" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/${run_name}-master" "pod/${run_name}-worker" --timeout="${TIMEOUT}"; then
    "${kubectl_ctx[@]}" describe pod "${run_name}-master" "${run_name}-worker" >"${VALIDATION_DIR}/${mode}-describe.txt" || true
    "${kubectl_ctx[@]}" logs "${run_name}-master" >"${VALIDATION_DIR}/${mode}-master.log" || true
    "${kubectl_ctx[@]}" logs "${run_name}-worker" >"${VALIDATION_DIR}/${mode}-worker.log" || true
    exit 1
  fi

  "${kubectl_ctx[@]}" logs "${run_name}-master" >"${VALIDATION_DIR}/${mode}-master.log"
  "${kubectl_ctx[@]}" logs "${run_name}-worker" >"${VALIDATION_DIR}/${mode}-worker.log"
  cleanup_mode "${mode}"
}

for mode in ${MODES}; do
  if [[ "${mode}" != "efa" && "${mode}" != "socket" ]]; then
    echo "unsupported mode: ${mode}" >&2
    exit 1
  fi
  run_mode "${mode}"
done

python3 - "${VALIDATION_DIR}" ${MODES} <<'PY'
import csv
import json
import re
import sys
from pathlib import Path

validation_dir = Path(sys.argv[1])
modes = sys.argv[2:]
results = []
for mode in modes:
    log_path = validation_dir / f"{mode}-master.log"
    text = log_path.read_text()
    match = re.search(r"RESULT_JSON: (\{.*\})", text)
    if not match:
        raise SystemExit(f"missing RESULT_JSON in {log_path}")
    result = json.loads(match.group(1))
    result["master_log"] = log_path.name
    result["worker_log"] = f"{mode}-worker.log"
    results.append(result)

summary = {
    "results": results,
}
by_mode = {item["mode"]: item for item in results}
if "efa" in by_mode and "socket" in by_mode:
    efa = by_mode["efa"]
    socket = by_mode["socket"]
    summary["comparison"] = {
        "efa_total_seconds": efa["total_seconds"],
        "socket_total_seconds": socket["total_seconds"],
        "socket_over_efa_speedup": socket["total_seconds"] / efa["total_seconds"],
        "efa_time_saved_seconds": socket["total_seconds"] - efa["total_seconds"],
        "efa_time_saved_percent": (1 - efa["total_seconds"] / socket["total_seconds"]) * 100,
    }

(validation_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
with (validation_dir / "summary.csv").open("w", newline="") as csvfile:
    fieldnames = [
        "mode",
        "total_seconds",
        "avg_step_seconds",
        "p50_step_seconds",
        "p95_step_seconds",
        "gradient_payload_gib_per_second",
    ]
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    for row in results:
        writer.writerow({key: row[key] for key in fieldnames})

width, height = 760, 360
left, top, bottom = 80, 40, 290
bar_width = 80
gap = 90
max_value = max(item["total_seconds"] for item in results)
colors = {"efa": "#1f77b4", "socket": "#d62728"}
svg = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
    "<style>text{font-family:Arial,sans-serif;fill:#222}.title{font-size:18px;font-weight:700}.axis{font-size:12px}.label{font-size:13px}.value{font-size:12px;font-weight:700}</style>",
    '<rect width="100%" height="100%" fill="#fff"/>',
    f'<text class="title" x="{left}" y="24">2-node G7e DDP training wall-clock</text>',
    f'<line x1="{left}" y1="{bottom}" x2="{width-60}" y2="{bottom}" stroke="#444"/>',
    f'<line x1="{left}" y1="{top}" x2="{left}" y2="{bottom}" stroke="#444"/>',
]
for i in range(6):
    value = max_value * i / 5
    y = bottom - (bottom - top) * i / 5
    svg.append(f'<line x1="{left-4}" y1="{y:.1f}" x2="{width-60}" y2="{y:.1f}" stroke="#ddd"/>')
    svg.append(f'<text class="axis" x="12" y="{y+4:.1f}">{value:.1f}s</text>')
for index, item in enumerate(results):
    x = left + 90 + index * (bar_width + gap)
    h = (bottom - top) * item["total_seconds"] / max_value
    y = bottom - h
    color = colors.get(item["mode"], "#666")
    svg.append(f'<rect x="{x}" y="{y:.1f}" width="{bar_width}" height="{h:.1f}" fill="{color}"/>')
    svg.append(f'<text class="value" x="{x}" y="{y-8:.1f}">{item["total_seconds"]:.2f}s</text>')
    svg.append(f'<text class="label" x="{x+12}" y="{bottom+24}">{item["mode"]}</text>')
svg.append(f'<text class="axis" x="{left}" y="{height-20}">Param payload: {results[0]["param_mib"]} MiB/rank, steps: {results[0]["steps"]}</text>')
svg.append("</svg>")
(validation_dir / "training-time.svg").write_text("\n".join(svg) + "\n")
PY

echo "Validation artifacts written to ${VALIDATION_DIR}"
