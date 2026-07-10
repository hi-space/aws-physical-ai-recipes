# G7e EFA NCCL Benchmark

Kubernetes-native 2-node NCCL `all_reduce_perf` benchmark for validating that
AWS EFA is usable for multi-node GPU collectives on the reference G7e pool.

This is intentionally not an OSMO workflow. EFA validation is meaningful when a
launcher and worker run on separate nodes and exchange NCCL traffic over
`aws-ofi-nccl`; the Kubernetes pod shape keeps the EFA resource request,
hugepages, `/dev/shm`, and MPI launch path explicit.

Prerequisites:

- `scripts/deploy-karpenter.sh` has deployed the G7e NodePool.
- `scripts/deploy-efa-device-plugin.sh` has deployed the AWS EFA device plugin.
- `infra/core` has applied the node security group self ingress and egress rules
  required by EFA.
- At least two EFA-capable G7e nodes can be provisioned. The benchmark requests
  `vpc.amazonaws.com/efa: 1`, so Karpenter can scale from zero.

Run:

```bash
KUBE_CONTEXT=aws-osmo-dev-repro-apne2 \
  examples/g7e-efa-nccl-benchmark/run.sh
```

The runner generates a temporary SSH key, creates a worker pod and a launcher
pod, installs NCCL `2.28.9-1+cuda13.0` in the runtime container, rebuilds
`nccl-tests` for Blackwell `sm_120`, and runs a 2-node `all_reduce_perf`.

`all_reduce_perf` reports both out-of-place and in-place bandwidth. Out-of-place
uses separate input and output buffers, while in-place writes the reduce result
back into the input buffer. Similar values are expected here because the goal is
to validate the multi-node NCCL transport path, not to compare buffer layouts.
For training wall-clock comparison with and without EFA, use
[g7e-efa-ddp-benchmark](../g7e-efa-ddp-benchmark/README.md).

Validation:

- [validation.md](validation.md)
- [validation/nccl-efa-2node.log](validation/nccl-efa-2node.log)
- [validation/nccl-efa-2node-bandwidth.csv](validation/nccl-efa-2node-bandwidth.csv)
- [validation/nccl-efa-2node-bandwidth.svg](validation/nccl-efa-2node-bandwidth.svg)
