"""Visualize trained RL policy on SO-101 tasks."""
import argparse
import glob

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visualize trained SO-101 RL policy")
    parser.add_argument("--task", required=True, help="Play environment ID (e.g. Workshop-SO101-Reach-Play-v0)")
    parser.add_argument("--checkpoint", type=str, default=None, help="Path to checkpoint (defaults to latest)")
    parser.add_argument("--num_steps", type=int, default=1000, help="Number of simulation steps")
    parser.add_argument("--video", action="store_true", help="Record video")
    parser.add_argument("--video_length", type=int, default=200, help="Video length in steps")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import gymnasium as gym
    import importlib
    import torch
    from rsl_rl.runners import OnPolicyRunner
    from isaaclab_rl.rsl_rl import RslRlVecEnvWrapper

    import workshop  # noqa: F401

    env_cfg_entry = gym.spec(args.task).kwargs["env_cfg_entry_point"]
    agent_cfg_entry = gym.spec(args.task).kwargs["rsl_rl_cfg_entry_point"]

    module_path, class_name = env_cfg_entry.rsplit(":", 1)
    env_cfg = getattr(importlib.import_module(module_path), class_name)()

    module_path, class_name = agent_cfg_entry.rsplit(":", 1)
    agent_cfg = getattr(importlib.import_module(module_path), class_name)()

    env = gym.make(args.task, cfg=env_cfg, render_mode="rgb_array" if args.video else None)
    env = RslRlVecEnvWrapper(env)

    runner = OnPolicyRunner(env, agent_cfg.to_dict(), log_dir=None, device=agent_cfg.device)

    checkpoint = args.checkpoint
    if checkpoint is None:
        pattern = f"logs/rsl_rl/{agent_cfg.experiment_name}/model_*.pt"
        matches = sorted(glob.glob(pattern), key=lambda p: int(p.rsplit("_", 1)[-1].replace(".pt", "")))
        if not matches:
            raise FileNotFoundError(f"No checkpoint found matching {pattern}")
        checkpoint = matches[-1]
        print(f"Using latest checkpoint: {checkpoint}")

    runner.load(checkpoint)
    policy = runner.get_inference_policy(device=env.unwrapped.device)

    obs, _ = env.reset()
    for step in range(args.num_steps):
        with torch.inference_mode():
            actions = policy(obs)
        obs, _, _, _ = env.step(actions)

    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
