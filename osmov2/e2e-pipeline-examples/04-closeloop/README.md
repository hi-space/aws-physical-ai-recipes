# Stage 4 — Closed-Loop Eval

Evaluate the Stage 3 GR00T checkpoint closed-loop in Isaac Sim with LeIsaac
(SO-101 + kitchen scene). A single GPU pod runs both the GR00T ZMQ policy server
and the LeIsaac rollout, measuring task success rate.

- OSMO input:  `e2e-pipeline-groot-checkpoint` (from Stage 3)
- OSMO output: `e2e-pipeline-closeloop-artifacts`

## Running

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set input_dataset=e2e-pipeline-groot-checkpoint

scripts/wait-gpu-node-cleanup.sh
```

## Parameters (default-values)

| Parameter | Default | Description |
| --- | --- | --- |
| `input_dataset` | `e2e-pipeline-groot-checkpoint` | Stage 3 checkpoint dataset |
| `output_dataset` | `e2e-pipeline-closeloop-artifacts` | OSMO output dataset name |
| `task_name` | `LeIsaac-SO101-PickOrange-v0` | LeIsaac eval task |
| `instruction` | `pick up the orange and place it on the plate` | Language instruction |
| `num_episodes` | `5` | Eval episodes (`--eval_rounds`) |
| `embodiment_tag` | `NEW_EMBODIMENT` | Must match the checkpoint's training config |
| `gr00t_ref` | `e8e625f4…` | GR00T commit — leisaac's N1.6 server-compat pin |
| `leisaac_ref` | `24d3bcd3…` | LeIsaac commit |
| `policy_action_horizon` / `policy_timeout_ms` / `policy_port` | `16` / `5000` / `5555` | ZMQ policy client knobs |
| `step_hz` | `30` | Control loop rate |
| `cpu` / `memory` / `storage` | `8` / `64Gi` / `200Gi` | Pod resources |
| `platform` | `g7e-rtx-pro-6000` | OSMO GPU platform |

## N1.6-pinned (chaining with N1.7)

This stage pins the **N1.6** server ref (`gr00t_ref=e8e625f4…`) and uses
`--policy_type gr00tn1.6`, matching leisaac's official N1.6 example. The default
Stage 3 checkpoint (N1.6) works as-is. If you trained with the optional N1.7
path (`03-training/workflow-n1.7.yaml`), override this stage for an
N1.7-compatible policy server/client before chaining.

## Outputs

- `eval-summary.json` — success rate, episode count (the source of truth)
- `logs/server.log`, `logs/rollout.log` — server + rollout logs

Note: this stage emits **no video**. leisaac's `policy_inference.py` sets
`env_cfg.recorders = None` and wraps no `RecordVideo`, so `videos/` stays empty;
success/fail comes from the parsed rollout log ("Final success rate"). Add a
`gym.wrappers.RecordVideo` patch if you need mp4s.

## Mapping to e2e-workshop

Reproduces `groot/inference/run-isaaclab.sh`: the same LeIsaac install, the N1.6
language-key patch, the headless-keyboard patch, and the
`kitchen_with_orange`/`so101_follower` assets — orchestrated by OSMO in a single
pod instead of Docker-on-DCV. The actual `policy_inference.py` invocation was
cross-checked against leisaac's `docs/docs/resources/available_policy.md` (the
workshop's `run-isaaclab.sh` only launches the container interactively).

## Related

The standalone [`examples/closed-loop-sim-eval`](../../examples/closed-loop-sim-eval/README.md)
is a RoboCasa GR1 variant of the same server + rollout mechanics; it was
runtime-validated on a G6e/L40S node (`success rate: 1.0`, 2026-07-27).
