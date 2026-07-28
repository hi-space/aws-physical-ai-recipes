# Stage 2 — Sim / RL

Reinforcement-learning track: train an H1 humanoid to walk on rough terrain with
Isaac Lab (skrl PPO), then replay the trained policy and record a video. This
stage is independent of the GR00T VLA chain (Stages 1/3/4/5) — it does not feed
or consume their datasets.

- OSMO input:  none
- OSMO output: `e2e-pipeline-sim-rl-artifacts` (checkpoint + TensorBoard + video)

## Running

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/02-sim/workflow.yaml

scripts/wait-gpu-node-cleanup.sh
```

For the Isaac Sim 5.1 stack, override the image (allow more memory):

```bash
osmo workflow submit e2e-pipeline-examples/02-sim/workflow.yaml \
  --set isaac_lab_image=nvcr.io/nvidia/isaac-lab:2.3.0
```

## Parameters (default-values)

| Parameter | Default | Description |
| --- | --- | --- |
| `task_name` | `Isaac-Velocity-Rough-H1-v0` | Isaac Lab task/env id |
| `rl_framework` | `skrl` | RL framework |
| `train_num_envs` | `2048` | Parallel envs during training |
| `play_num_envs` | `32` | Parallel envs during replay |
| `max_iterations` | `1000` | PPO training iterations |
| `video_length` | `400` | Replay video length (steps) |
| `isaac_lab_image` | `nvcr.io/nvidia/isaac-lab:2.2.0` | Isaac Lab image (`2.3.0` = Isaac Sim 5.1) |
| `output_dataset` | `e2e-pipeline-sim-rl-artifacts` | OSMO output dataset name |

## Outputs

- Trained skrl checkpoint
- TensorBoard event logs
- Replay video (`play_num_envs` envs, `video_length` steps)

## Mapping to e2e-workshop

Adapts workshop Modules 2–4 and
`scripts/reinforcement_learning/skrl/{train,play}.py`. Runs headless in an OSMO
pod and exports the checkpoint, TensorBoard logs, and video as a single dataset.
