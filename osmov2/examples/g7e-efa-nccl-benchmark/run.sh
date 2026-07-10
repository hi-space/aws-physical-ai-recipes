#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
IMAGE="${IMAGE:-$(version_value nccl_benchmark_image)}"
NCCL_VERSION="${NCCL_VERSION:-$(version_value nccl_benchmark_nccl_version)}"
BENCH_NAME="${BENCH_NAME:-nccl-efa-benchmark}"
WORKER_POD="${WORKER_POD:-nccl-efa-worker}"
MASTER_POD="${MASTER_POD:-nccl-efa-master}"
SSH_SECRET="${SSH_SECRET:-nccl-bench-ssh}"
KEEP_RESOURCES="${KEEP_RESOURCES:-false}"

if [[ -z "${KUBE_CONTEXT}" ]]; then
  echo "KUBE_CONTEXT is required" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"

kubectl_ctx=(kubectl --context "${KUBE_CONTEXT}" -n "${NAMESPACE}")

"${kubectl_ctx[@]}" create namespace "${NAMESPACE}" >/dev/null 2>&1 || true
ssh-keygen -q -t ed25519 -N "" -f "${tmp_dir}/id_ed25519"
"${kubectl_ctx[@]}" delete secret "${SSH_SECRET}" --ignore-not-found=true >/dev/null
"${kubectl_ctx[@]}" create secret generic "${SSH_SECRET}" \
  --from-file=id_ed25519="${tmp_dir}/id_ed25519" \
  --from-file=authorized_keys="${tmp_dir}/id_ed25519.pub" >/dev/null

cleanup() {
  if [[ "${KEEP_RESOURCES}" != "true" ]]; then
    "${kubectl_ctx[@]}" delete pod "${MASTER_POD}" "${WORKER_POD}" --ignore-not-found=true --wait=true --timeout=2m >/dev/null || true
    "${kubectl_ctx[@]}" delete service "${WORKER_POD}" --ignore-not-found=true >/dev/null || true
    "${kubectl_ctx[@]}" delete secret "${SSH_SECRET}" --ignore-not-found=true >/dev/null || true
  fi
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

"${kubectl_ctx[@]}" apply -f - <<YAML
apiVersion: v1
kind: Service
metadata:
  name: ${WORKER_POD}
  labels:
    app.kubernetes.io/name: ${BENCH_NAME}
spec:
  selector:
    app.kubernetes.io/name: ${BENCH_NAME}
    app.kubernetes.io/component: worker
  ports:
    - name: ssh
      port: 22
      targetPort: 22
---
apiVersion: v1
kind: Pod
metadata:
  name: ${WORKER_POD}
  labels:
    app.kubernetes.io/name: ${BENCH_NAME}
    app.kubernetes.io/component: worker
spec:
  restartPolicy: Never
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  nodeSelector:
    aws.osmo.reference/nodepool: g7e
  containers:
    - name: worker
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      resources:
        requests:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
          vpc.amazonaws.com/efa: "1"
          hugepages-2Mi: 5120Mi
        limits:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
          vpc.amazonaws.com/efa: "1"
          hugepages-2Mi: 5120Mi
      volumeMounts:
        - name: ssh
          mountPath: /ssh
          readOnly: true
        - name: shmem
          mountPath: /dev/shm
      command:
        - /bin/bash
        - -lc
        - |
          set -euxo pipefail
          apt-get update -qq
          apt-get install -y --no-install-recommends libnccl2=${NCCL_VERSION} libnccl-dev=${NCCL_VERSION}
          ldconfig
          rm -f /opt/nccl/build/lib/libnccl.so /opt/nccl/build/lib/libnccl.so.2 /opt/nccl/build/lib/libnccl.so.2.27.7
          ln -sf /lib/x86_64-linux-gnu/libnccl.so.2 /opt/nccl/build/lib/libnccl.so.2
          ln -sf /lib/x86_64-linux-gnu/libnccl.so /opt/nccl/build/lib/libnccl.so
          export PATH=/opt/amazon/openmpi/bin:\$PATH
          export LD_LIBRARY_PATH=/opt/amazon/openmpi/lib:/opt/nccl/build/lib:/usr/local/cuda/lib64:/opt/amazon/efa/lib:/opt/amazon/ofi-nccl/lib/x86_64-linux-gnu:\${LD_LIBRARY_PATH:-}
          make -C /opt/nccl-tests/src MPI=1 MPI_HOME=/opt/amazon/openmpi NCCL_HOME=/opt/nccl/build BUILDDIR=/tmp/nccl-tests-build-13 NVCC_GENCODE="-gencode=arch=compute_120,code=sm_120 -gencode=arch=compute_120,code=compute_120" -j\$(nproc) /tmp/nccl-tests-build-13/all_reduce_perf
          mkdir -p /root/.ssh /run/sshd
          cp /ssh/authorized_keys /root/.ssh/authorized_keys
          chmod 700 /root/.ssh
          chmod 600 /root/.ssh/authorized_keys
          exec /usr/sbin/sshd -D -e
  volumes:
    - name: ssh
      secret:
        secretName: ${SSH_SECRET}
        defaultMode: 0600
    - name: shmem
      hostPath:
        path: /dev/shm
---
apiVersion: v1
kind: Pod
metadata:
  name: ${MASTER_POD}
  labels:
    app.kubernetes.io/name: ${BENCH_NAME}
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
              app.kubernetes.io/name: ${BENCH_NAME}
              app.kubernetes.io/component: worker
          topologyKey: kubernetes.io/hostname
  containers:
    - name: master
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      resources:
        requests:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
          vpc.amazonaws.com/efa: "1"
          hugepages-2Mi: 5120Mi
        limits:
          cpu: "4"
          memory: 16Gi
          nvidia.com/gpu: "1"
          vpc.amazonaws.com/efa: "1"
          hugepages-2Mi: 5120Mi
      volumeMounts:
        - name: ssh
          mountPath: /ssh
          readOnly: true
        - name: shmem
          mountPath: /dev/shm
      command:
        - /bin/bash
        - -lc
        - |
          set -euxo pipefail
          apt-get update -qq
          apt-get install -y --no-install-recommends libnccl2=${NCCL_VERSION} libnccl-dev=${NCCL_VERSION}
          ldconfig
          rm -f /opt/nccl/build/lib/libnccl.so /opt/nccl/build/lib/libnccl.so.2 /opt/nccl/build/lib/libnccl.so.2.27.7
          ln -sf /lib/x86_64-linux-gnu/libnccl.so.2 /opt/nccl/build/lib/libnccl.so.2
          ln -sf /lib/x86_64-linux-gnu/libnccl.so /opt/nccl/build/lib/libnccl.so
          export PATH=/opt/amazon/openmpi/bin:\$PATH
          export LD_LIBRARY_PATH=/opt/amazon/openmpi/lib:/opt/nccl/build/lib:/usr/local/cuda/lib64:/opt/amazon/efa/lib:/opt/amazon/ofi-nccl/lib/x86_64-linux-gnu:\${LD_LIBRARY_PATH:-}
          make -C /opt/nccl-tests/src MPI=1 MPI_HOME=/opt/amazon/openmpi NCCL_HOME=/opt/nccl/build BUILDDIR=/tmp/nccl-tests-build-13 NVCC_GENCODE="-gencode=arch=compute_120,code=sm_120 -gencode=arch=compute_120,code=compute_120" -j\$(nproc) /tmp/nccl-tests-build-13/all_reduce_perf
          mkdir -p /root/.ssh
          cp /ssh/id_ed25519 /root/.ssh/id_ed25519
          chmod 700 /root/.ssh
          chmod 600 /root/.ssh/id_ed25519
          printf 'Host *\\n  StrictHostKeyChecking no\\n  UserKnownHostsFile /dev/null\\n  LogLevel ERROR\\n  ConnectTimeout 5\\n' > /root/.ssh/config
          for i in \$(seq 1 60); do
            if ssh -i /root/.ssh/id_ed25519 root@${WORKER_POD} true; then
              break
            fi
            sleep 5
          done
          ssh -i /root/.ssh/id_ed25519 root@${WORKER_POD} true
          echo "MASTER_NODE=\$(hostname)"
          echo "WORKER_NODE=${WORKER_POD}"
          echo "MASTER_POD_IP=\$(hostname -i)"
          echo "=== fi_info ==="
          /opt/amazon/efa/bin/fi_info -p efa | sed -n '1,30p'
          echo "=== all_reduce_perf efa 2-node ${NCCL_VERSION} ==="
          timeout 240s mpirun --allow-run-as-root \
            -np 2 -N 1 --host localhost:1,${WORKER_POD}:1 \
            --bind-to none --map-by slot \
            --mca pml ^cm,ucx \
            --mca btl tcp,self \
            --mca btl_tcp_if_exclude lo,docker0,veth_def_agent \
            --tag-output \
            -x PATH -x LD_LIBRARY_PATH \
            -x NCCL_DEBUG=INFO \
            -x NCCL_DEBUG_SUBSYS=INIT,NET \
            -x NCCL_BUFFSIZE=8388608 \
            -x NCCL_P2P_NET_CHUNKSIZE=524288 \
            -x NCCL_TUNER_PLUGIN=/opt/amazon/ofi-nccl/lib/x86_64-linux-gnu/libnccl-ofi-tuner.so \
            -x NCCL_SOCKET_IFNAME=eth0 \
            -x FI_PROVIDER=efa \
            /tmp/nccl-tests-build-13/all_reduce_perf -b 8 -e 64M -f 2 -g 1 -c 1 -n 10 -w 2
          echo "NCCL_EFA_2NODE_BENCH_OK"
  volumes:
    - name: ssh
      secret:
        secretName: ${SSH_SECRET}
        defaultMode: 0600
    - name: shmem
      hostPath:
        path: /dev/shm
YAML

"${kubectl_ctx[@]}" wait --for=condition=Ready "pod/${WORKER_POD}" "pod/${MASTER_POD}" --timeout=10m
"${kubectl_ctx[@]}" logs -f "${MASTER_POD}"
