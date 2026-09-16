"""Deterministic real closed-loop evaluation; never infer success from reward."""
import argparse
from pathlib import Path
import time

import imageio.v2 as imageio
import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import VecNormalize

from common import TASK, load_bundle, make_env, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, help="trusted matched checkpoint bundle directory")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--task", default=TASK, choices=[TASK])
    parser.add_argument("--seed", type=int, default=1042)
    parser.add_argument("--episodes", type=int, default=5)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    args = parser.parse_args()
    if args.episodes <= 0 or min(args.width, args.height) < 16:
        parser.error("positive episodes and image dimensions >= 16 required")
    checkpoint, metadata = load_bundle(args.checkpoint, args.task)
    output = Path(args.output_dir)
    (output / "videos").mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(1)
    env = VecNormalize.load(checkpoint / "vecnormalize.pkl",
                            make_env(args.task, seed=args.seed, render=True, width=args.width, height=args.height))
    env.training, env.norm_reward = False, False
    model = PPO.load(checkpoint / "model.zip", env=env, device="cpu")
    latencies, episodes = [], []
    try:
        for episode in range(args.episodes):
            env.seed(args.seed + episode)
            obs, total, steps = env.reset(), 0.0, 0
            video = f"videos/episode-{episode:04d}.mp4"
            with imageio.get_writer(output / video, fps=20, codec="libx264", macro_block_size=1) as writer:
                while True:
                    # Capture the current physics state before SB3 auto-resets terminal episodes.
                    writer.append_data(env.venv.envs[0].render())
                    started = time.perf_counter()
                    action, _ = model.predict(obs, deterministic=True)
                    latencies.append((time.perf_counter() - started) * 1000)
                    obs, reward, done, infos = env.step(action)
                    steps += 1
                    total += float(reward[0])
                    if done[0]:
                        info = infos[0]
                        success = bool(info["is_success"])
                        episodes.append({"index": episode, "seed": args.seed + episode, "steps": steps,
                                         "return": total, "finalDistance": float(info["distance"]),
                                         "success": success, "timeout": bool(info["TimeLimit.truncated"]),
                                         "videoUri": video})
                        break
    finally:
        env.close()
    successes = sum(e["success"] for e in episodes)
    write_json(output / "evaluation.json", {
        "schemaVersion": 1, "type": "closed_loop", "task": args.task, "seed": args.seed,
        "episodeCount": len(episodes), "successCount": successes, "successRate": successes / len(episodes),
        "timeoutCount": sum(e["timeout"] for e in episodes), "timeoutSeconds": 10,
        "successCriterion": "final end-effector distance < 0.03 m (workshop is_success)",
        "latencyMs": {key: float(np.quantile(latencies, q)) for key, q in (("p50", .5), ("p95", .95), ("p99", .99))},
        "checkpointDigest": metadata["sha256"]["model.zip"],
        "normalizationDigest": metadata["sha256"]["vecnormalize.pkl"],
        "simulator": metadata["simulator"], "videoUri": episodes[0]["videoUri"], "episodes": episodes,
    })


if __name__ == "__main__":
    main()
