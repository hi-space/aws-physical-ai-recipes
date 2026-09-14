#!/usr/bin/env python3
"""Evaluate a trained SO-101 MuJoCo policy and record it as mp4/gif — no GPU or display needed.

CPU counterpart of ``play_isaaclab.py --video`` (module 10 GPU extension, appendix E4). Runs the policy for a few
episodes, prints success rate / final distance, and renders every frame offscreen with
MuJoCo's software renderer so the result can be watched from S3 or code-server.

Usage:
    MUJOCO_GL=egl python play_mujoco.py \
        --task Workshop-SO101-Reach-MuJoCo-v0 \
        --checkpoint /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip \
        --episodes 5 --video_dir /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/videos

    # "before training" reference: a freshly initialised policy, exploration noise included
    MUJOCO_GL=egl python play_mujoco.py --untrained --episodes 2 --video_dir <dir>   # -> untrained.{mp4,gif}

    # live window instead of a file: run from a terminal inside the DCV desktop of a CPU node (S3.10)
    python play_mujoco.py --viewer --checkpoint <model.zip> --episodes 5

MUJOCO_GL selects the OpenGL backend and must be set before MuJoCo is imported: ``egl`` (Mesa
llvmpipe, package libegl1 + libgl1-mesa-dri) or ``osmesa`` (package libosmesa6) for offscreen video;
``--viewer`` forces ``glfw`` (a window on $DISPLAY, software-rendered by Mesa on a CPU node).
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

# Must be decided before `import mujoco`. Offscreen video: EGL (Mesa llvmpipe, works headless).
# --viewer: a GLFW window on the X display of the DCV desktop; Mesa renders it in software on a CPU node.
if "--viewer" in sys.argv:
    os.environ["MUJOCO_GL"] = "glfw"
else:
    os.environ.setdefault("MUJOCO_GL", "egl")

import gymnasium as gym  # noqa: E402
import numpy as np  # noqa: E402
from stable_baselines3 import PPO  # noqa: E402
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize  # noqa: E402

import mujoco_workshop  # noqa: E402,F401

TARGET_RGBA = np.array([0.1, 0.9, 0.1, 0.8], dtype=np.float32)


def _open_viewer(core):
    """Passive MuJoCo window over the env's own model/data, framed like the offscreen camera in so101_reach.py."""
    import mujoco
    import mujoco.viewer

    v = mujoco.viewer.launch_passive(core.model, core.data, show_left_ui=False, show_right_ui=False)
    v.cam.type = mujoco.mjtCamera.mjCAMERA_FREE
    v.cam.lookat[:] = (0.22, 0.0, 0.18)
    v.cam.distance = getattr(core, "_camera_distance", 0.85)
    v.cam.azimuth, v.cam.elevation = 150.0, -20.0
    return v


def _sync_viewer(v, target: np.ndarray) -> None:
    """Redraw the window. The target is not a body in the MJCF, so add it as a green sphere (as render() does)."""
    import mujoco

    scn = v.user_scn
    scn.ngeom = 0
    if scn.maxgeom > 0:
        mujoco.mjv_initGeom(
            scn.geoms[0], mujoco.mjtGeom.mjGEOM_SPHERE, np.array([0.015, 0, 0]),
            np.asarray(target, dtype=np.float64), np.eye(3).flatten(), TARGET_RGBA,
        )
        scn.ngeom = 1
    v.sync()


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
    parser.add_argument("--viewer", action="store_true",
                        help="open an interactive MuJoCo window instead of recording a file (needs a display: "
                             "run it from a terminal inside the DCV desktop)")
    parser.add_argument("--speed", type=float, default=1.0, help="--viewer playback speed, 1.0 = real time")
    args = parser.parse_args()
    if args.viewer:
        args.no_video = True  # the window is the output

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
    output = "viewer window" if args.viewer else ("off" if args.no_video else video_dir)
    print(f"Task: {args.task}  episodes: {args.episodes}  video: {output}")
    print(f"MUJOCO_GL={os.environ['MUJOCO_GL']}", flush=True)

    core = env.unwrapped  # So101ReachEnv: .model / .data / .target / .dt
    viewer = _open_viewer(core) if args.viewer else None

    frames: list[np.ndarray] = []
    returns, final_dists, successes = [], [], []
    for ep in range(args.episodes):
        obs, info = env.reset(seed=args.seed + ep)
        if viewer is not None:
            _sync_viewer(viewer, core.target)
            time.sleep(0.5)  # hold the home pose for a beat so the new target is visible before the arm moves
        done, ep_ret, aborted = False, 0.0, False
        while not done:
            t0 = time.perf_counter()
            policy_obs = normalizer.normalize_obs(obs) if normalizer else obs
            action, _ = model.predict(policy_obs, deterministic=deterministic)
            obs, r, term, trunc, info = env.step(action)
            ep_ret += float(r)
            done = term or trunc
            if not args.no_video:
                frames.append(env.render())
            if viewer is not None:
                if not viewer.is_running():
                    aborted = True
                    break
                _sync_viewer(viewer, core.target)
                # Pace the loop to the control period (dt = 50 ms) so the arm moves at real speed.
                time.sleep(max(0.0, core.dt / args.speed - (time.perf_counter() - t0)))
        if aborted:
            print("Viewer window closed, stopping.")
            break
        returns.append(ep_ret)
        final_dists.append(info.get("distance", float("nan")))
        successes.append(bool(info.get("is_success", False)))
        print(f"  episode {ep + 1}: return {ep_ret:8.2f}  final distance {final_dists[-1] * 100:5.1f} cm  "
              f"{'SUCCESS' if successes[-1] else 'miss'}", flush=True)

    if not returns:
        print("No completed episodes.")
        if viewer is not None:
            viewer.close()
        env.close()
        return
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
    if viewer is not None:
        if viewer.is_running():
            print("Done. Close the viewer window to exit.", flush=True)
            while viewer.is_running():
                time.sleep(0.2)
        viewer.close()
    env.close()


if __name__ == "__main__":
    main()
