"""Isaac Lab RL Training on HyperPod (headless).

Trains SO-101 robot arm with PPO using rsl_rl on Isaac Lab.
Runs headless on GPU compute nodes — no display needed.

Tasks:
  Workshop-SO101-Reach-v0  — 5-DOF arm reaches random targets
  Workshop-SO101-Lift-v0   — 5-DOF arm + gripper reaches a target above a table

Besides rsl_rl's periodic model_<iteration>.pt files, the run writes model_best.pt
(the saved checkpoint with the highest mean reward) and best_checkpoint.json, because
PPO's mean reward oscillates late in training and the last checkpoint is not
necessarily the best one.

Usage:
  # Inside Isaac Lab container on compute node:
  python train_isaaclab.py \
    --task Workshop-SO101-Reach-v0 \
    --num_envs 2048 \
    --max_iterations 300 \
    --headless

  # Resume from checkpoint:
  python train_isaaclab.py \
    --task Workshop-SO101-Reach-v0 \
    --checkpoint /fsx/checkpoints/rl/reach/model_150.pt \
    --headless
"""

import argparse
import inspect
import json
import os
import shutil
import sys
import time

from isaaclab.app import AppLauncher


def _strip_unknown_alg_keys(cfg_dict: dict) -> dict:
    """Remove algorithm keys the installed rsl_rl version doesn't accept."""
    from rsl_rl.algorithms import PPO

    valid = set(inspect.signature(PPO.__init__).parameters.keys()) - {"self"}
    alg = cfg_dict.get("algorithm", {})
    cfg_dict["algorithm"] = {k: v for k, v in alg.items() if k in valid or k == "class_name"}
    return cfg_dict


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Isaac Lab RL Training on HyperPod")
    parser.add_argument("--task", type=str, default="Workshop-SO101-Reach-v0",
                        help="Task ID (Workshop-SO101-Reach-v0 or Workshop-SO101-Lift-v0)")
    parser.add_argument("--num_envs", type=int, default=2048,
                        help="Number of parallel environments")
    parser.add_argument("--max_iterations", type=int, default=300,
                        help="Training iterations (300 ≈ 15-20 min on A10G)")
    parser.add_argument("--checkpoint", type=str, default=None,
                        help="Resume from checkpoint path")
    parser.add_argument("--log_dir", type=str, default="/fsx/checkpoints/rl",
                        help="Log and checkpoint directory")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    args.headless = True
    return args


def main():
    import mlflow_isaaclab
    mlflow_isaaclab.install()

    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import importlib

    import gymnasium as gym
    from rsl_rl.runners import OnPolicyRunner
    from isaaclab_rl.rsl_rl import RslRlVecEnvWrapper

    workshop_path = os.environ.get("PYTHONPATH", "/fsx/scratch/isaaclab-workshop/src")
    for p in workshop_path.split(":"):
        if p and p not in sys.path:
            sys.path.insert(0, p)
    try:
        import isaaclab_tasks  # noqa: F401 — registers Isaac Lab gym environments
    except ImportError:
        pass
    try:
        import workshop  # noqa: F401 — registers custom workshop environments
    except ImportError:
        pass

    env_cfg_entry = gym.spec(args.task).kwargs["env_cfg_entry_point"]
    agent_cfg_entry = gym.spec(args.task).kwargs["rsl_rl_cfg_entry_point"]

    module_path, class_name = env_cfg_entry.rsplit(":", 1)
    env_cfg = getattr(importlib.import_module(module_path), class_name)()

    module_path, class_name = agent_cfg_entry.rsplit(":", 1)
    agent_cfg = getattr(importlib.import_module(module_path), class_name)()

    if args.num_envs is not None:
        env_cfg.scene.num_envs = args.num_envs
    if args.max_iterations is not None:
        agent_cfg.max_iterations = args.max_iterations

    env = gym.make(args.task, cfg=env_cfg)
    env = RslRlVecEnvWrapper(env)

    task_short = args.task.split("-")[-2].lower()
    log_path = f"{args.log_dir}/{task_short}/{agent_cfg.experiment_name}"
    os.environ.setdefault("MLFLOW_ARTIFACT_DIR", args.log_dir)

    runner = OnPolicyRunner(
        env,
        _strip_unknown_alg_keys(agent_cfg.to_dict()),
        log_dir=log_path,
        device=agent_cfg.device,
    )

    if args.checkpoint:
        runner.load(args.checkpoint)
        print(f"Resumed from: {args.checkpoint}")

    print(f"Training: {args.task}")
    print(f"  Envs: {env_cfg.scene.num_envs}")
    print(f"  Iterations: {agent_cfg.max_iterations}")
    print(f"  Log dir: {log_path}")
    print(f"  Device: {agent_cfg.device}")

    log_interval = getattr(agent_cfg, "log_interval", 10)
    save_interval = getattr(agent_cfg, "save_interval", 100)
    _original_learn = runner.learn
    _start_time = time.time()

    # Per-iteration statistics captured from the TensorBoard writer (rsl_rl 3.x keeps its
    # reward buffers local to learn(), so the writer is the only stable place to read them).
    # rsl_rl logs iteration `it` and then saves model_<it>.pt, so the stats keyed by `it`
    # describe the checkpoint with the same number.
    iter_stats: dict[int, dict] = {}

    def _hook_writer():
        writer = getattr(runner, "writer", None)
        if writer is None or getattr(writer, "_workshop_hooked", False):
            return
        original_add_scalar = writer.add_scalar

        def add_scalar(tag, value, step=None, *a, **kw):
            try:
                if tag == "Train/mean_reward":
                    iter_stats.setdefault(int(step), {})["mean_reward"] = float(value)
                elif str(tag).endswith("position_error"):
                    iter_stats.setdefault(int(step), {})["position_error"] = float(value)
            except (TypeError, ValueError):
                pass
            return original_add_scalar(tag, value, step, *a, **kw)

        writer.add_scalar = add_scalar
        writer._workshop_hooked = True

    def _learn_with_logging(num_learning_iterations, init_at_random_ep_len=False):
        original_update = runner.alg.update
        _step = {"iter": 0}

        def _update_with_log(*a, **kw):
            _hook_writer()
            result = original_update(*a, **kw)
            _step["iter"] += 1
            it = _step["iter"]
            if it % log_interval == 0 or it == num_learning_iterations:
                elapsed = time.time() - _start_time
                fps = (it * env.num_envs * agent_cfg.num_steps_per_env) / elapsed if elapsed > 0 else 0
                # rsl_rl 3.x keeps the reward/episode-length buffers local to learn(),
                # so they are only reported when the runner still exposes them.
                extra = ""
                if hasattr(runner, "rewbuffer") and len(runner.rewbuffer) > 0:
                    extra += f", reward: {runner.rewbuffer.mean():.2f}"
                if hasattr(runner, "lenbuffer") and len(runner.lenbuffer) > 0:
                    extra += f", ep_len: {runner.lenbuffer.mean():.0f}"
                print(
                    f"[INFO] Iteration {it}/{num_learning_iterations}"
                    f" — fps: {fps:.0f}, elapsed: {elapsed:.0f}s{extra}",
                    flush=True,
                )
            return result

        runner.alg.update = _update_with_log
        _original_learn(num_learning_iterations, init_at_random_ep_len)
        runner.alg.update = original_update

    def _select_best_checkpoint():
        """Copy the saved checkpoint with the highest mean reward to model_best.pt."""
        candidates = []
        for name in os.listdir(log_path):
            if name.startswith("model_") and name.endswith(".pt") and name[6:-3].isdigit():
                it = int(name[6:-3])
                stats = iter_stats.get(it)
                if stats and "mean_reward" in stats:
                    candidates.append({"iteration": it, "file": name, **stats})
        if not candidates:
            print("[WARN] No reward statistics captured — model_best.pt not written.")
            return
        candidates.sort(key=lambda c: c["iteration"])
        best = max(candidates, key=lambda c: c["mean_reward"])
        shutil.copyfile(os.path.join(log_path, best["file"]), os.path.join(log_path, "model_best.pt"))
        with open(os.path.join(log_path, "best_checkpoint.json"), "w") as f:
            json.dump({"best": best, "candidates": candidates}, f, indent=2)
        last = candidates[-1]
        print(f"[INFO] Best checkpoint: {best['file']} (mean reward {best['mean_reward']:.2f}"
              + (f", position error {best['position_error']:.3f} m" if "position_error" in best else "")
              + f") → model_best.pt; last checkpoint {last['file']} (mean reward {last['mean_reward']:.2f})")

    _learn_with_logging(agent_cfg.max_iterations)
    _select_best_checkpoint()

    print(f"\nTraining complete! Checkpoints at: {log_path}")
    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
