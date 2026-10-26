# examples: Training and Evaluation Scripts

> 한국어 문서: [README.ko.md](README.ko.md)

The scripts the jobs actually run. `k8s-templates/` (EKS) and `slurm-templates/` (Slurm) are the two
ways to launch them; both call the same files here, so a change lands on both paths at once.

```
examples/rl/      reinforcement learning — Isaac Lab on GPU, MuJoCo on CPU
examples/vla/     vision-language-action — GR00T fine-tune, evaluation, promotion gate
examples/mlflow/  one standalone tracking example
```

## The VLA loop

These run in order. Each step's output is the next step's input.

```
download_dataset.py  →  prepare_dataset.py  →  mlflow_run_dir.py  →  train_groot.py
                                                                          ↓
                                                              register_groot_model.py
                                                                          ↓
                           verify_in_sim.py  or  policy_server.py + eval_closed_loop.py
                                                                          ↓
                                            eval_report.py  →  gate_checkpoint.py
                                                                          ↓
                                                            PROMOTE / PASS / BLOCK
```

Two things about this loop are worth knowing before reading the files.

Checkpoints are written **into the MLflow run's own artifact directory**, not to a fixed path.
`mlflow_run_dir.py` creates the run before training starts and prints where the checkpoints go, so
the weights are browsable in the Artifacts tab without a 9 GB copy. Both training paths call it,
which is why `OUTPUT_DIR` only applies when tracking is off.

The gate is what makes evaluation load-bearing. `gate_checkpoint.py` exits non-zero on BLOCK, so a
dependent job never runs on a checkpoint that failed. Without it, eval results are written and
never read.

## examples/vla

| File | Role |
|---|---|
| `download_dataset.py` | Fetches a GR00T-compatible dataset — a built-in demo set from the Isaac-GR00T repo, or any LeRobot v2 dataset from HuggingFace (`--name`, `--repo-id`) |
| `prepare_dataset.py` | Validates LeRobot v2 structure and generates the metadata files GR00T requires but the dataset may be missing (`--validate`, `--generate-tasks`, `--upload-s3` for FSx DRA import) |
| `mlflow_run_dir.py` | Creates the MLflow run before training and emits `MLFLOW_RUN_ID` / `CKPT_DIR` for the caller to `eval`. The run is created here rather than by the Trainer because HF Trainer's `MLflowCallback` only knows its run id after `train()` starts, which is too late to use as an output path |
| `train_groot.py` | Wraps Isaac-GR00T's `launch_finetune.py` with MLflow tracking. `GROOT_VERSION` selects n1.6 or n1.7 and the matching base model |
| `train_pi0.py` | Minimal π0 fine-tune with DDP. Training only — there is no π0 serving path yet, so it cannot be evaluated through `policy_server.py` |
| `register_groot_model.py` | Registers the checkpoint as an MLflow model version, tagged with its FSx location. `source` is an `s3://` URI and nothing is uploaded, because FSx DRA already exports the same bytes. Deliberately promotes nothing — that is `gate_checkpoint.py`'s job |
| `verify_in_sim.py` | Open-loop evaluation: predicted actions vs. ground truth on held-out trajectories. Runs on a GPU node with no Isaac Sim, which makes it the cheap first filter |
| `policy_server.py` | Serves a fine-tuned GR00T model over ZMQ REQ/REP (msgpack), returning 16-step action chunks. Loads GR00T only |
| `eval_closed_loop.py` | Runs the policy in Isaac Sim — local policy, or remote through `policy_server.py` when the simulator and the GPU are on different nodes |
| `eval_report.py` | Aggregates per-trial records into `eval-report.json`, with per-part and per-scenario breakdowns, a Wilson 95% interval, and the sample size needed to tell two checkpoints apart. Keeps the breakdowns because an aggregate rate hides the actionable signal: a part that fails *every* attempt is a different problem from one that fails intermittently |
| `gate_checkpoint.py` | Turns the report into PROMOTE / PASS / BLOCK and exits non-zero on BLOCK. Can also move a Model Registry alias. See [`vla/eval_trials/README.md`](vla/eval_trials/README.md) |
| `vla/eval_trials/` | Fixture: 48 real-robot attempts from 2026-10-22, so the gate can be run without hardware |

Two metrics, two powers. A report built from task success (`metric: success_rate`) can promote. One
built from open-loop action MSE (`metric: openloop_mse`) can only block — it measures
behaviour-cloning fidelity, not whether the task succeeded.

## examples/rl

| File | Role |
|---|---|
| `train_isaaclab.py` | PPO via rsl_rl on Isaac Lab, headless on a GPU node — thousands of arms in one process. Also writes `model_best.pt` and `best_checkpoint.json`, because PPO's mean reward oscillates late in training and the last checkpoint is not the best one |
| `play_isaaclab.py` | Replays a checkpoint in a few rendered environments over a DCV session, so a human can watch the arm |
| `train_mujoco.py` | CPU counterpart: one MuJoCo environment per core in separate processes (`SubprocVecEnv`), gathered into one PPO update. Stable-Baselines3 + VecNormalize. Any Gymnasium MuJoCo task id also works, as a quick smoke test |
| `play_mujoco.py` | Deterministic evaluation (success rate, final distance) plus offscreen mp4/gif through MuJoCo's software renderer — no GPU and no display. `--untrained` renders a fresh policy as a before/after reference |
| `mlflow_isaaclab.py` | Mirrors Isaac Lab's TensorBoard scalars to MLflow in real time. A no-op when `MLFLOW_TRACKING_URI` is unset, which is the default — tracking is opt-in |
| `ray_config.yaml` | Ray-on-Slurm cluster layout (head and worker partitions) |

Tasks are `Workshop-SO101-Reach-v0` (5-DOF arm reaches random targets) and `Workshop-SO101-Lift-v0`
(arm plus gripper, target above a table). The MuJoCo path uses `Workshop-SO101-Reach-MuJoCo-v0`.

## examples/mlflow

| File | Role |
|---|---|
| `example_tracking.py` | Standalone MLflow tracking example covering both the RL and VLA shapes. Useful for checking a tracking server is reachable before launching a real job |

## Environments

Nothing here runs against the system Python. Each path has its own venv on FSx, created once by a
setup script and shared by every job afterwards.

```
/fsx/envs/gr00t      scripts/setup_groot_env.sh      VLA     (+ scripts/patch_groot_repo.py)
/fsx/envs/mujoco     scripts/setup_mujoco_env.sh     RL CPU
Isaac Lab container  nvcr.io/nvidia/isaac-lab:2.3.0  RL GPU
```

`scripts/patch_groot_repo.py` patches the pinned Isaac-GR00T checkout — among other things so the
Trainer reports metrics to MLflow and TensorBoard at all, since the workshop runs `--no-use-wandb`
and upstream otherwise leaves loss in stdout.
