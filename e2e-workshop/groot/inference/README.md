# GR00T Inference

Provides a path for validating a fine-tuned GR00T model inside simulation.

> 한국어 문서: [README.ko.md](README.ko.md)

## Overview

```
inference/
├── batch-zmq/         GR00T ZMQ inference server ping client (for debugging/validation)
└── run-isaaclab.sh    Closed-loop simulation evaluation with Isaac Lab + LeIsaac
```

Which path to use:

| Situation | Path to use |
|------|-------------|
| I want a quick check that the GR00T Policy Server is alive on the DCV instance | [`batch-zmq/`](./batch-zmq/) |
| I want to evaluate whether the fine-tuned model actually performs the task on a robot inside the simulator | `run-isaaclab.sh` |

> When the training job in the SageMaker Pipeline finishes, the trained model artifact is uploaded directly — already unpacked from source — to `s3://<bucket>/<model.s3_prefix>/<execution-id>/` (a single-step pipeline). On the DCV instance, pull this prefix with `aws s3 sync` and load it in IsaacSim. See [`../pipeline/README.md`](../pipeline/README.md) for details.

## Batch ZMQ Client

The official GR00T inference server (`run_gr00t_server.py`) operates over a ZMQ REQ/REP socket. The small client in this directory pings that server and runs a single inference on a dummy observation to quickly verify the server is healthy.

```bash
cd batch-zmq
uv run python test_inference.py                       # same machine
uv run python test_inference_remote.py <INSTANCE_IP>  # remote
```

This uses dummy data for validating the GR00T base model (GR1 embodiment), so use the simulation evaluation below (`run-isaaclab.sh`) to validate fine-tuning results. See [`batch-zmq/README.md`](./batch-zmq/README.md) for the detailed protocol.

> Workshop Module 3 (VLA infra + base model inference validation) can be run via [`../notebooks/01_infra_and_base_check.ipynb`](../notebooks/01_infra_and_base_check.ipynb), which wraps this same client in a notebook.

## Closed-loop Evaluation (`run-isaaclab.sh`)

A bash script invoked from the DCV instance. It installs the [LeIsaac](https://github.com/LightwheelAI/leisaac) package inside the Isaac Lab container, spins up the SO-101 robot + kitchen scene, and measures whether the fine-tuned GR00T model actually performs the task by following a natural-language instruction ("pick up the orange").

What the script does:

1. Persistently installs `leisaac[gr00t]` + `lerobot` under `~/isaaclab-pkgs/` (once only)
2. Downloads the SO-101 USD scene assets to `~/leisaac-assets/` (once only)
3. Clones the leisaac repo
4. Launches the Isaac Lab container interactively with `docker run -it`, and inside the container connects to the GR00T Policy Server over ZMQ via `policy_inference.py`

The GR00T Policy Server must be launched separately (typically run directly from the container pulled from ECR).

| Env var | Default | Meaning |
|----------|--------|------|
| `ISAAC_LAB_IMAGE` | `nvcr.io/nvidia/isaac-lab:2.3.0` | Isaac Lab image to use |
| `LEISAAC_COMMIT` | (specified in the script) | leisaac repo pinned commit |

Workshop Module 5 (Closed-loop Evaluation) can be run via [`../notebooks/03_closed_loop_eval.ipynb`](../notebooks/03_closed_loop_eval.ipynb), which wraps this script. See [Workshop Guide Module 5](https://hi-space.gitbook.io/physical-ai-on-aws/guide/e2e-workshop) for the full procedure.
