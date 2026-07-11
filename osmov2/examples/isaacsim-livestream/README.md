# Isaac Sim Livestream

Launches NVIDIA Isaac Sim headless with WebRTC livestreaming enabled as an OSMO
workflow, then streams to a local Isaac Sim Streaming Client over an OSMO
workflow port-forward. Unlike the batch training/inference examples, this is an
interactive simulation workload.

## Prerequisites

- Platform deployed and validated (`scripts/deploy-osmo.sh`, `scripts/validate-platform.sh`).
- The `g7e-rtx-pro-6000` OSMO platform registered (default). For the L4 fallback,
  register the `g6-l4` platform (`OSMO_CONFIGURE_G6_PLATFORM=true scripts/deploy-osmo.sh`)
  and submit `workflow-g6.yaml`.
- Isaac Sim Streaming Client installed locally
  (<https://docs.isaacsim.omniverse.nvidia.com/latest/installation/download.html>).

## Run

GPU workflows need visible GPU capacity before OSMO resource validation:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.4xlarge scripts/prewarm-gpu-node.sh
osmo workflow submit examples/isaacsim-livestream/workflow.yaml
```

Wait until the `stream` task is Running and Isaac Sim finishes booting
(watch logs: `osmo workflow logs <workflow-id>`).

## Connect the streaming client

Isaac Sim livestream uses both TCP and UDP ports. Open two terminals and keep
both port-forwards running:

```bash
# TCP signaling + control
osmo workflow port-forward <workflow-id> stream \
  --port 47995-48012,49000-49007,49100 --connect-timeout 300

# UDP media
osmo workflow port-forward <workflow-id> stream \
  --port 47995-48012,49000-49007 --udp --connect-timeout 300
```

Then open the Isaac Sim Streaming Client and connect to `localhost`.

## Cleanup

```bash
osmo workflow cancel <workflow-id>   # if still running
scripts/wait-gpu-node-cleanup.sh
```

Validation artifacts: [validation.md](validation.md).
