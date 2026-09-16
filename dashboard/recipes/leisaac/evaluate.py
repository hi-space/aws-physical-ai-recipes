"""Real LeIsaac GR00T closed loop with per-round durable results and camera video.

Uses the policy and simulator APIs from LightwheelAI/leisaac
24d3bcd3f1e4585740fc79921782c41617237812, scripts/evaluation/policy_inference.py.
No synthesized observations, rewards, actions, or success labels.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checkpoint_bundle import ALGORITHM, inspect_checkpoint


def checkpoint_digest(root):
    return inspect_checkpoint(root)[1]["digest"]


def main():
    from isaaclab.app import AppLauncher
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--task", default="LeIsaac-SO101-PickOrange-v0")
    parser.add_argument("--policy-host", required=True)
    parser.add_argument("--policy-port", type=int, default=5555)
    parser.add_argument("--instruction", default="Pick three oranges and put them into the plate, then reset the arm to rest state.")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--episodes", type=int, default=5)
    parser.add_argument("--episode-seconds", type=float, default=60)
    parser.add_argument("--action-horizon", type=int, default=16)
    parser.add_argument("--startup-timeout", type=int, default=600)
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    if args.episodes < 1 or args.episode_seconds <= 0 or args.action_horizon < 1:
        parser.error("episodes, episode-seconds and action-horizon must be positive")
    if not os.environ.get("LEISAAC_SCENE_REVISION"):
        raise ValueError("LEISAAC_SCENE_REVISION must identify the provisioned scene/robot assets")
    digest = checkpoint_digest(Path(args.checkpoint))
    deadline = time.monotonic() + args.startup_timeout
    while True:
        try:
            with socket.create_connection((args.policy_host, args.policy_port), timeout=2):
                break
        except OSError:
            if time.monotonic() >= deadline:
                raise TimeoutError("GR00T policy server did not become ready")
            time.sleep(1)
    app = AppLauncher(args).app
    env = None
    output = Path(args.output_dir)
    (output / "videos").mkdir(parents=True, exist_ok=True)
    results, latency = [], []

    def persist(status):
        import numpy as np
        report = {
            "schemaVersion": 1, "type": "closed_loop", "status": status, "task": args.task,
            "seed": args.seed, "episodeCount": len(results), "requestedEpisodeCount": args.episodes,
            "successCount": sum(r["success"] for r in results),
            "successRate": sum(r["success"] for r in results) / len(results) if results else None,
            "timeoutCount": sum(r["timeout"] for r in results), "timeoutSeconds": args.episode_seconds,
            "latencyMs": {k: float(np.quantile(latency, q)) for k, q in (("p50", .5), ("p95", .95), ("p99", .99))} if latency else None,
            "checkpointDigest": digest, "checkpointDigestKind": ALGORITHM, "episodes": results,
            "simulator": {"name": "Isaac Lab", "version": "2.3.0",
                          "leisaacCommit": "24d3bcd3f1e4585740fc79921782c41617237812",
                          "sceneVersion": os.environ.get("LEISAAC_SCENE_REVISION", "unverified")},
            "videoUri": results[0]["videoUri"] if results else None,
        }
        with (output / "evaluation.json.tmp").open("w") as file:
            json.dump(report, file, indent=2, allow_nan=False)
            file.flush()
            os.fsync(file.fileno())
        os.replace(output / "evaluation.json.tmp", output / "evaluation.json")

    try:
        import gymnasium as gym
        import imageio.v2 as imageio
        import torch
        import leisaac  # noqa: F401
        from isaaclab.sensors import Camera
        from isaaclab_tasks.utils import parse_env_cfg
        from leisaac.policy import Gr00t16ServicePolicyClient
        from leisaac.utils.env_utils import get_task_type, dynamic_reset_gripper_effort_limit_sim
        cfg = parse_env_cfg(args.task, device=args.device, num_envs=1)
        task_type = get_task_type(args.task)
        if task_type != "so101leader":
            raise ValueError("This adapter validates only the SO-101 single-arm embodiment")
        cfg.use_teleop_device(task_type)
        cfg.seed, cfg.episode_length_s, cfg.recorders = args.seed, args.episode_seconds, None
        env = gym.make(args.task, cfg=cfg).unwrapped
        if "success" not in env.termination_manager.active_terms:
            raise ValueError("Task has no explicit success termination; cannot report success rate")
        cameras = [key for key, sensor in env.scene.sensors.items() if isinstance(sensor, Camera)]
        if not cameras:
            raise ValueError("Task has no camera for durable evaluation video")
        policy = Gr00t16ServicePolicyClient(host=args.policy_host, port=args.policy_port,
                                           timeout_ms=15000, camera_keys=cameras,
                                           modality_keys=["single_arm", "gripper"])
        persist("running")
        for episode in range(args.episodes):
            observations, _ = env.reset(seed=args.seed + episode)
            relative_video = f"videos/episode-{episode:04d}.mp4"
            terminated = timed_out = success = False
            steps = 0
            # Physics horizon is also an explicit upper bound if the task's timeout changes.
            max_steps = int(args.episode_seconds / env.step_dt) + 1
            with imageio.get_writer(output / relative_video, fps=max(1, round(1 / env.step_dt)), codec="libx264") as writer:
                while not (terminated or timed_out):
                    if not app.is_running() or steps >= max_steps:
                        raise RuntimeError("Simulator stopped or task failed to terminate within its configured horizon")
                    observation = observations["policy"]
                    observation["task_description"] = args.instruction
                    start = time.perf_counter()
                    with torch.inference_mode():
                        actions = policy.get_action(observation).to(env.device)
                    if actions.ndim != 3 or actions.shape[0] < 1 or actions.shape[1:] != (1, 6) or not torch.isfinite(actions).all():
                        raise ValueError("Policy returned malformed/non-finite SO-101 actions")
                    latency.append((time.perf_counter() - start) * 1000)
                    for action in actions[:args.action_horizon]:
                        frame = env.scene.sensors[cameras[0]].data.output["rgb"][0, ..., :3]
                        writer.append_data(frame.detach().cpu().numpy())
                        if cfg.dynamic_reset_gripper_effort_limit:
                            dynamic_reset_gripper_effort_limit_sim(env, task_type)
                        with torch.inference_mode():
                            observations, _, done, timeout, _ = env.step(action)
                        steps += 1
                        success = bool(env.termination_manager.get_term("success")[0].item())
                        terminated, timed_out = bool(done[0]), bool(timeout[0])
                        if terminated or timed_out:
                            break
            results.append({"index": episode, "seed": args.seed + episode, "success": success,
                            "timeout": timed_out, "steps": steps, "videoUri": relative_video})
            persist("running")
        persist("completed")
    except BaseException:
        persist("failed")
        raise
    finally:
        if env is not None:
            env.close()
        app.close()


if __name__ == "__main__":
    main()
