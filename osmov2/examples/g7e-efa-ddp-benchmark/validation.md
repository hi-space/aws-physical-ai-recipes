# G7e EFA DDP Benchmark Validation

This file records validation for [run.sh](run.sh).

## 2026-05-08 2-Node G7e EFA vs Socket DDP

Status: Passed

Command:

```bash
KUBE_CONTEXT=aws-osmo-dev-repro-apne2 \
  examples/g7e-efa-ddp-benchmark/run.sh
```

Environment:

- Instance type: `g7e.12xlarge` on both nodes
- World size: `2`
- GPUs per node: `1`
- PyTorch image:
  `public.ecr.aws/deep-learning-containers/pytorch-training:2.9.0-gpu-py312-cu130-ubuntu22.04-ec2-v1.11`
- Gradient payload: `256 MiB` per rank, `512 MiB` per training step
- Warmup steps: `2`
- Measured steps: `12`

Observed result:

| Mode | NCCL network | Total time | Avg step | Effective gradient throughput |
| --- | --- | ---: | ---: | ---: |
| EFA | `Libfabric` / `NET/Libfabric/0/GDRDMA` | `0.129 s` | `0.0108 s` | `46.47 GiB/s` |
| Socket | `Socket` / `NET/Socket/0` | `1.371 s` | `0.1143 s` | `4.38 GiB/s` |

Comparison:

- Socket-over-EFA wall-clock ratio: `10.60x`
- EFA time saved: `1.242 s`
- EFA time saved: `90.57%`

Artifacts:

- Summary JSON: [validation/summary.json](validation/summary.json)
- Summary CSV: [validation/summary.csv](validation/summary.csv)
- Training time plot: [validation/training-time.svg](validation/training-time.svg)
- EFA master log: [validation/efa-master.log](validation/efa-master.log)
- EFA worker log: [validation/efa-worker.log](validation/efa-worker.log)
- Socket master log: [validation/socket-master.log](validation/socket-master.log)
- Socket worker log: [validation/socket-worker.log](validation/socket-worker.log)

Notes:

- This is a synthetic communication-heavy DDP benchmark, not a model quality
  benchmark.
- The EFA path requests `vpc.amazonaws.com/efa: 1` and the logs show
  `Using network Libfabric` plus `via NET/Libfabric/0/GDRDMA`.
- The comparison path sets `NCCL_NET=Socket`; the logs show `Using network
  Socket` plus `via NET/Socket/0`.
