#!/usr/bin/env python3
"""Train a PPO policy for the SO-101 Reach task in MuJoCo on CPU (Stable-Baselines3).

CPU counterpart of ``train_isaaclab.py`` (appendix A3, module 8 GPU extension). Where Isaac Lab simulates thousands of
arms inside one GPU process, this script runs one MuJoCo environment per CPU core in separate
processes (``SubprocVecEnv``) and gathers their rollouts into a single PPO update.

Usage (inside the /fsx/envs/mujoco venv created by scripts/setup_mujoco_env.sh):
    python train_mujoco.py --task Workshop-SO101-Reach-MuJoCo-v0 --num_envs 16 --total_steps 1000000

Any Gymnasium MuJoCo task ID (e.g. ``InvertedPendulum-v5``) also works and is a quick smoke test.

Outputs (under ``<log_dir>/<task-folder>/``, e.g. /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/):
    model_<steps>.zip       periodic checkpoints (every --save_interval env steps)
    model_final.zip         policy at the end of training
    model_best.zip          policy with the best evaluation return seen during training
    vecnormalize.pkl        observation-normalisation statistics (needed to run any of the models)
    best_checkpoint.json    which evaluation produced model_best.zip and its metrics
    tb/                     TensorBoard event files (rollout/, train/, eval/, reward_terms/)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import time
from pathlib import Path

import gymnasium as gym
import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback, EvalCallback
from stable_baselines3.common.env_util import make_vec_env
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv, VecNormalize

import mujoco_workshop  # noqa: F401 — registers Workshop-SO101-Reach-MuJoCo-v0

# Folder layout mirrors the Isaac Lab path (/fsx/checkpoints/rl/reach/SO101_Reach) with a
# "-mujoco" suffix so checkpoints from the two simulators never get mixed up.
TASK_FOLDERS = {
    "Workshop-SO101-Reach-MuJoCo-v0": Path("reach-mujoco") / "SO101_Reach",
}


def task_folder(task: str) -> Path:
    return TASK_FOLDERS.get(task, Path(task.lower().replace("-", "_")))


class ProgressCallback(BaseCallback):
    """Print one summary line per PPO iteration and log the per-term reward breakdown to TensorBoard."""

    def __init__(self, total_steps: int, num_envs: int, n_steps: int):
        super().__init__()
        self.total_steps = total_steps
        self.iter_steps = num_envs * n_steps
        self.total_iters = max(1, math.ceil(total_steps / self.iter_steps))
        self.iteration = 0
        self.t0 = time.time()
        self._term_sums: dict[str, float] = {}
        self._term_count = 0
        self._successes: list[float] = []

    def _on_step(self) -> bool:
        for info in self.locals.get("infos", []):
            terms = info.get("reward_terms")
            if terms:
                for k, v in terms.items():
                    self._term_sums[k] = self._term_sums.get(k, 0.0) + float(v)
                self._term_count += 1
            # TimeLimit sets "TimeLimit.truncated"; SB3 Monitor adds "episode" at episode end.
            if "episode" in info and "is_success" in info:
                self._successes.append(float(info["is_success"]))
        return True

    def _on_rollout_end(self) -> None:
        self.iteration += 1
        elapsed = time.time() - self.t0
        fps = int(self.num_timesteps / max(elapsed, 1e-6))
        ep_rew = self.model.ep_info_buffer
        mean_rew = float(np.mean([e["r"] for e in ep_rew])) if len(ep_rew) else float("nan")
        if self._term_count:
            for k, v in self._term_sums.items():
                self.logger.record(f"reward_terms/{k}", v / self._term_count)
        if self._successes:
            self.logger.record("rollout/success_rate", float(np.mean(self._successes)))
        succ = f", success: {np.mean(self._successes):.2f}" if self._successes else ""
        print(
            f"[INFO] Iteration {self.iteration}/{self.total_iters} | steps: {self.num_timesteps}, "
            f"fps: {fps}, elapsed: {elapsed:.0f}s, mean episode reward: {mean_rew:.2f}{succ}",
            flush=True,
        )
        self._term_sums.clear()
        self._term_count = 0
        self._successes.clear()


def make_env_fn(task: str):
    def _init():
        env = gym.make(task)
        return Monitor(env, info_keywords=("is_success",) if "SO101" in task else ())

    return _init


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", default="Workshop-SO101-Reach-MuJoCo-v0")
    parser.add_argument("--num_envs", type=int, default=0, help="parallel env processes (0 = all CPU cores)")
    parser.add_argument("--total_steps", type=int, default=1_000_000, help="total environment steps")
    parser.add_argument("--log_dir", default="/fsx/checkpoints/rl")
    parser.add_argument("--checkpoint", default="", help="resume from a saved model .zip")
    parser.add_argument("--save_interval", type=int, default=100_000, help="checkpoint every N env steps")
    parser.add_argument("--eval_interval", type=int, default=50_000, help="evaluate every N env steps")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--n_steps", type=int, default=256, help="rollout length per env per PPO iteration")
    parser.add_argument("--n_epochs", type=int, default=10, help="gradient passes over each rollout batch")
    parser.add_argument("--no_normalize", action="store_true", help="disable running observation normalisation")
    parser.add_argument("--log_std_init", type=float, default=-1.0,
                        help="initial log std of the Gaussian policy (-1 → std 0.37; 0 → std 1.0)")
    args = parser.parse_args()

    num_envs = args.num_envs or (os.cpu_count() or 4)
    torch.set_num_threads(max(1, min(4, (os.cpu_count() or 4) // 4)))  # env processes need the cores

    out_dir = Path(args.log_dir) / task_folder(args.task)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Training: {args.task}")
    print(f"  Envs: {num_envs} (SubprocVecEnv, one MuJoCo instance per process)")
    print(f"  Total steps: {args.total_steps}")
    print(f"  Log dir: {out_dir}")
    print(f"  Device: cpu (torch threads={torch.get_num_threads()})", flush=True)

    vec_env = make_vec_env(
        make_env_fn(args.task), n_envs=num_envs, seed=args.seed,
        vec_env_cls=SubprocVecEnv, vec_env_kwargs={"start_method": "forkserver"},
    )
    eval_env = make_vec_env(make_env_fn(args.task), n_envs=4, seed=args.seed + 1000, vec_env_cls=DummyVecEnv)

    # Observation normalisation: joint angles (rad), velocities (rad/s, up to ~10) and positions (m, ~0.3)
    # live on very different scales; PPO learns much faster when each input has unit variance. The running
    # mean/std are saved next to the checkpoints (vecnormalize.pkl) because the policy only works with them.
    normalize = not args.no_normalize
    stats_path = Path(args.checkpoint).parent / "vecnormalize.pkl" if args.checkpoint else None
    if normalize:
        if stats_path and stats_path.exists():
            vec_env = VecNormalize.load(stats_path, vec_env)
            vec_env.training = True
        else:
            vec_env = VecNormalize(vec_env, norm_obs=True, norm_reward=False, clip_obs=10.0)
        # EvalCallback copies the running statistics into eval_env before every evaluation.
        eval_env = VecNormalize(eval_env, norm_obs=True, norm_reward=False, clip_obs=10.0, training=False)

    def linear_schedule(initial: float):
        # Anneal the learning rate to 0 over training: large steps early, fine adjustments at the end.
        return lambda progress_remaining: initial * progress_remaining

    if args.checkpoint:
        print(f"  Resuming from: {args.checkpoint}")
        model = PPO.load(args.checkpoint, env=vec_env, tensorboard_log=str(out_dir / "tb"))
    else:
        model = PPO(
            "MlpPolicy", vec_env,
            n_steps=args.n_steps, batch_size=min(512, num_envs * args.n_steps // 8), n_epochs=args.n_epochs,
            learning_rate=linear_schedule(3e-4), gamma=0.99, gae_lambda=0.95, clip_range=0.2, ent_coef=0.0,
            policy_kwargs={"net_arch": [256, 128], "activation_fn": torch.nn.ELU, "log_std_init": args.log_std_init},
            tensorboard_log=str(out_dir / "tb"), seed=args.seed, verbose=0, device="cpu",
        )

    def save_norm_stats(_locals=None, _globals=None) -> bool:
        if normalize:
            vec_env.save(str(out_dir / "vecnormalize.pkl"))
        return True

    save_freq = max(1, args.save_interval // num_envs)   # SB3 counts callback calls per env step batch
    eval_freq = max(1, args.eval_interval // num_envs)
    callbacks = [
        ProgressCallback(args.total_steps, num_envs, args.n_steps),
        CheckpointCallback(save_freq=save_freq, save_path=str(out_dir), name_prefix="model", verbose=0),
        EvalCallback(
            eval_env, best_model_save_path=str(out_dir), log_path=str(out_dir / "eval"),
            eval_freq=eval_freq, n_eval_episodes=8, deterministic=True, render=False, verbose=0,
            callback_on_new_best=None,
        ),
    ]

    t0 = time.time()
    model.learn(total_timesteps=args.total_steps, callback=callbacks, tb_log_name="ppo", progress_bar=False)
    model.save(out_dir / "model_final")
    save_norm_stats()
    vec_env.close()
    eval_env.close()

    # EvalCallback writes best_model.zip; expose it under the same name the Isaac Lab path uses.
    best_src = out_dir / "best_model.zip"
    eval_cb = callbacks[2]
    if best_src.exists():
        shutil.move(best_src, out_dir / "model_best.zip")
        summary = {
            "task": args.task,
            "best_mean_reward": float(eval_cb.best_mean_reward),
            "last_mean_reward": float(eval_cb.last_mean_reward),
            "total_steps": int(model.num_timesteps),
            "num_envs": num_envs,
            "elapsed_s": round(time.time() - t0, 1),
        }
        (out_dir / "best_checkpoint.json").write_text(json.dumps(summary, indent=2))
        print(f"[INFO] Best eval mean reward {summary['best_mean_reward']:.2f} → model_best.zip; "
              f"final policy → model_final.zip")
    print(f"Training complete! Checkpoints at: {out_dir}")


if __name__ == "__main__":
    main()
