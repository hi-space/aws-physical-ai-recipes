#!/usr/bin/env python3
"""Evaluate a trained SO-101 MuJoCo policy and record it as mp4/gif — no GPU or display needed.

CPU counterpart of ``play_isaaclab.py --video`` (module 10 GPU extension, appendix A5). Runs the policy for a few
episodes, prints success rate / final distance, and renders every frame offscreen with
MuJoCo's software renderer so the result can be watched from S3 or code-server.

Usage:
    MUJOCO_GL=egl python play_mujoco.py \
        --task Workshop-SO101-Reach-MuJoCo-v0 \
        --checkpoint /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip \
        --episodes 5 --video_dir /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/videos

    # "before training" reference: a freshly initialised policy, exploration noise included
    MUJOCO_GL=egl python play_mujoco.py --untrained --episodes 2 --video_dir <dir>   # -> untrained.{mp4,gif}

MUJOCO_GL selects the offscreen OpenGL backend and must be set before MuJoCo is imported:
``egl`` (Mesa llvmpipe, package libegl1 + libgl1-mesa-dri) or ``osmesa`` (package libosmesa6).
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

# Must be decided before `import mujoco`; default to EGL which works headless with Mesa.
os.environ.setdefault("MUJOCO_GL", "egl")

import gymnasium as gym  # noqa: E402
import numpy as np  # noqa: E402
from stable_baselines3 import PPO  # noqa: E402
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize  # noqa: E402

import mujoco_workshop  # noqa: E402,F401


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", default="Workshop-SO101-Reach-MuJoCo-v0")
    parser.add_argument("--checkpoint", default="", help="model_best.zip / model_final.zip / model_<steps>.zip")
    parser.add_argument("--untrained", action="store_true",
                        help="instead of a checkpoint, run a freshly initialised policy (what PPO iteration 0 does, "
                             "exploration noise included) — the 'before training' reference video")
    parser.add_argument("--episodes", type=int, default=5)
    parser.add_argument("--video_dir", default="", help="default: <checkpoint dir>/videos (./videos with --untrained)")
    parser.add_argument("--no_video", action="store_true", help="metrics only, skip rendering")
    parser.add_argument("--gif_every", type=int, default=2, help="keep every Nth frame in the gif (smaller file)")
    parser.add_argument("--gif_scale", type=int, default=2, help="downscale the gif by this integer factor (2 → 320x240)")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    if bool(args.checkpoint) == args.untrained:
        raise SystemExit("Give exactly one of --checkpoint <model.zip> or --untrained")

    env = gym.make(args.task, render_mode=None if args.no_video else "rgb_array")
    normalizer = None
    if args.untrained:
        # Same network and initial action noise as train_mujoco.py, before a single update.
        import torch

        model = PPO("MlpPolicy", DummyVecEnv([lambda: gym.make(args.task)]), device="cpu", seed=args.seed,
                    policy_kwargs={"net_arch": [256, 128], "activation_fn": torch.nn.ELU, "log_std_init": -1.0})
        deterministic = False  # iteration-0 behaviour is the exploration noise itself
        stem = "untrained"
        video_dir = Path(args.video_dir) if args.video_dir else Path.cwd() / "videos"
        print(f"Untrained policy (fresh PPO init, stochastic actions, seed {args.seed})")
    else:
        ckpt = Path(args.checkpoint)
        if not ckpt.is_file():
            raise SystemExit(f"Checkpoint not found: {ckpt}")
        model = PPO.load(ckpt, device="cpu")
        deterministic = True
        stem = ckpt.stem
        video_dir = Path(args.video_dir) if args.video_dir else ckpt.parent / "videos"
        # The policy was trained on normalised observations; apply the saved running mean/std.
        stats_path = ckpt.parent / "vecnormalize.pkl"
        if stats_path.exists():
            normalizer = VecNormalize.load(stats_path, DummyVecEnv([lambda: gym.make(args.task)]))
            normalizer.training = False
        print(f"Loaded {ckpt}")
        print(f"Observation normalisation: {'on (' + stats_path.name + ')' if normalizer else 'off'}")
    print(f"Task: {args.task}  episodes: {args.episodes}  video: {'off' if args.no_video else video_dir}")
    print(f"MUJOCO_GL={os.environ['MUJOCO_GL']}", flush=True)

    frames: list[np.ndarray] = []
    returns, final_dists, successes = [], [], []
    for ep in range(args.episodes):
        obs, info = env.reset(seed=args.seed + ep)
        done, ep_ret = False, 0.0
        while not done:
            policy_obs = normalizer.normalize_obs(obs) if normalizer else obs
            action, _ = model.predict(policy_obs, deterministic=deterministic)
            obs, r, term, trunc, info = env.step(action)
            ep_ret += float(r)
            done = term or trunc
            if not args.no_video:
                frames.append(env.render())
        returns.append(ep_ret)
        final_dists.append(info.get("distance", float("nan")))
        successes.append(bool(info.get("is_success", False)))
        print(f"  episode {ep + 1}: return {ep_ret:8.2f}  final distance {final_dists[-1] * 100:5.1f} cm  "
              f"{'SUCCESS' if successes[-1] else 'miss'}", flush=True)

    print("=== Evaluation summary ===")
    print(f"  success rate:        {np.mean(successes):.2f} ({sum(successes)}/{len(successes)})")
    print(f"  mean final distance: {np.mean(final_dists) * 100:.1f} cm")
    print(f"  mean return:         {np.mean(returns):.2f}")

    if not args.no_video:
        import imageio.v2 as imageio

        video_dir.mkdir(parents=True, exist_ok=True)
        fps = env.metadata.get("render_fps", 20)
        mp4 = video_dir / f"{stem}.mp4"
        gif = video_dir / f"{stem}.gif"
        imageio.mimwrite(mp4, frames, fps=fps, codec="libx264", quality=7)
        # GIF is for a quick look in code-server: subsample in time and space to keep it a few MB.
        k = max(1, args.gif_scale)
        imageio.mimwrite(gif, [f[::k, ::k] for f in frames[:: args.gif_every]], duration=args.gif_every / fps, loop=0)
        print(f"  MP4: {mp4}")
        print(f"  GIF: {gif}")
    env.close()


if __name__ == "__main__":
    main()
