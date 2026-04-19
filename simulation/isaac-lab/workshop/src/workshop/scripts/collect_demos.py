"""Collect demonstration episodes from a trained RL policy."""
import argparse
from pathlib import Path

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect demos from trained RL policy")
    parser.add_argument("--task", required=True, help="Play environment ID")
    parser.add_argument("--checkpoint", required=True, help="Path to RL checkpoint")
    parser.add_argument("--num_episodes", type=int, default=200, help="Number of episodes to collect")
    parser.add_argument("--output_dir", type=str, required=True, help="Output directory for .npz files")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import gymnasium as gym
    import importlib
    import numpy as np
    import torch
    from rsl_rl.runners import OnPolicyRunner

    import workshop  # noqa: F401

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    env_cfg_entry = gym.spec(args.task).kwargs["env_cfg_entry_point"]
    agent_cfg_entry = gym.spec(args.task).kwargs["rsl_rl_cfg_entry_point"]

    module_path, class_name = env_cfg_entry.rsplit(":", 1)
    env_cfg = getattr(importlib.import_module(module_path), class_name)()
    env_cfg.scene.num_envs = 1

    module_path, class_name = agent_cfg_entry.rsplit(":", 1)
    agent_cfg = getattr(importlib.import_module(module_path), class_name)()

    env = gym.make(args.task, cfg=env_cfg)
    runner = OnPolicyRunner(env, agent_cfg.to_dict(), log_dir=None, device=agent_cfg.device)
    runner.load(args.checkpoint)
    policy = runner.get_inference_policy(device=env.unwrapped.device)

    ep_count = 0
    obs, _ = env.reset()

    while ep_count < args.num_episodes:
        states_buf = []
        actions_buf = []
        done = False

        while not done:
            with torch.inference_mode():
                actions = policy(obs)

            states_buf.append(obs[0, :6].cpu().numpy())
            actions_buf.append(actions[0, :6].cpu().numpy())

            obs, _, dones, _, _ = env.step(actions)
            done = dones[0].item() if dones.numel() > 0 else False

        np.savez(
            output_dir / f"episode_{ep_count:06d}.npz",
            states=np.array(states_buf, dtype=np.float32),
            actions=np.array(actions_buf, dtype=np.float32),
        )
        print(f"Episode {ep_count + 1}/{args.num_episodes} — {len(states_buf)} steps")
        ep_count += 1
        obs, _ = env.reset()

    print(f"\nCollected {ep_count} episodes → {output_dir}")
    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
