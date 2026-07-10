# G7e EFA NCCL Benchmark Validation

This file records validation for [run.sh](run.sh).

## 2026-05-08 2-Node G7e NCCL All-Reduce

Status: Passed

Commands:

```bash
scripts/deploy-efa-device-plugin.sh
KUBE_CONTEXT=aws-osmo-dev-repro-apne2 \
  KEEP_RESOURCES=true \
  examples/g7e-efa-nccl-benchmark/run.sh
```

Observed result:

- Worker node: `ip-10-40-11-242.ap-northeast-2.compute.internal`
- Launcher node: `ip-10-40-14-250.ap-northeast-2.compute.internal`
- Instance type: `g7e.12xlarge` on both nodes
- EFA resource: both nodes exposed `vpc.amazonaws.com/efa: 1`
- GPU resource: both nodes exposed `nvidia.com/gpu: 2`
- Libfabric provider: `provider: efa`, `fabric: efa-direct`, `protocol: FI_PROTO_EFA`
- NCCL network: `Using network Libfabric`
- NCCL data path: `via NET/Libfabric/0/GDRDMA`
- Benchmark completion marker: `NCCL_EFA_2NODE_BENCH_OK`
- Peak observed bus bandwidth: `17.73 GB/s` in-place, `17.35 GB/s` out-of-place
- Average bus bandwidth reported by `all_reduce_perf`: `4.12773 GB/s`

Artifacts:

- Raw log: [validation/nccl-efa-2node.log](validation/nccl-efa-2node.log)
- Parsed bandwidth: [validation/nccl-efa-2node-bandwidth.csv](validation/nccl-efa-2node-bandwidth.csv)
- Bandwidth plot: [validation/nccl-efa-2node-bandwidth.svg](validation/nccl-efa-2node-bandwidth.svg)
- Node inventory: [validation/g7e-efa-nodes.txt](validation/g7e-efa-nodes.txt)

Notes:

- The first validation attempt proved that the AWS EFA device plugin alone was
  not sufficient for multi-node NCCL. The EKS node security group also needed
  self-referenced all-traffic ingress and egress rules.
- The `public.ecr.aws/hpc-cloud/nccl-tests:latest` image included NCCL
  `2.27.7+cuda12.8`, which failed on Blackwell multi-rank collectives with
  `Cuda failure 'named symbol not found'`. The benchmark therefore installs
  NCCL `2.28.9-1+cuda13.0` at runtime and rebuilds `nccl-tests` for `sm_120`.
- `all_reduce_perf` in-place mode reuses the input buffer for the output, while
  out-of-place mode uses separate input and output buffers. Similar values are
  expected for this transport check; training wall-clock comparison is captured
  separately in [../g7e-efa-ddp-benchmark/validation.md](../g7e-efa-ddp-benchmark/validation.md).
