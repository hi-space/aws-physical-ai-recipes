# G7e EFA DDP Benchmark

Kubernetes-native 2-node PyTorch DDP benchmark for comparing EFA-backed NCCL
against NCCL socket networking on the same G7e pool.

This benchmark is intentionally synthetic and communication-heavy. It measures
training step wall-clock for a DDP model with a large gradient payload, not model
quality or end-to-end dataset throughput. Use it when the question is whether
EFA changes multi-node training time for gradient-synchronization-heavy jobs.

Prerequisites:

- `scripts/deploy-karpenter.sh` has deployed the G7e NodePool.
- `scripts/deploy-efa-device-plugin.sh` has deployed the AWS EFA device plugin.
- `infra/core` has applied the node security group self ingress and egress rules
  required by EFA.
- At least two EFA-capable G7e nodes can be provisioned. The EFA mode requests
  `vpc.amazonaws.com/efa: 1`, and both modes request one GPU per pod.

Run:

```bash
KUBE_CONTEXT=aws-osmo-dev-repro-apne2 \
  examples/g7e-efa-ddp-benchmark/run.sh
```

The runner executes two modes with the same PyTorch training script:

- `efa`: requests `vpc.amazonaws.com/efa: 1` and lets NCCL use the AWS OFI
  NCCL/Libfabric path.
- `socket`: does not request EFA and sets `NCCL_NET=Socket` so NCCL uses the
  ordinary pod network path.

Default workload:

- 2 nodes
- 1 GPU per node
- 256 MiB gradient payload per rank
- 2 warmup steps
- 12 measured training steps

Validation:

- [validation.md](validation.md)
- [validation/summary.json](validation/summary.json)
- [validation/summary.csv](validation/summary.csv)
- [validation/training-time.svg](validation/training-time.svg)
- [validation/efa-master.log](validation/efa-master.log)
- [validation/socket-master.log](validation/socket-master.log)
