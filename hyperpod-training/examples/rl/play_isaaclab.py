"""Isaac Lab RL Policy Playback on HyperPod (GUI / DCV).

Loads a checkpoint trained by train_isaaclab.py and runs it in a
small number of rendered environments so a human can watch the SO-101
arm execute the learned policy over a DCV session.

Tasks:
  Workshop-SO101-Reach-v0  — 5-DOF arm reaches random targets
  Workshop-SO101-Lift-v0   — 5-DOF arm + gripper lifts object

Usage:
  # Inside the Isaac Lab container on the debug node (DCV session, GUI):
  python play_isaaclab.py \
    --task Workshop-SO101-Reach-v0 \
    --checkpoint /fsx/checkpoints/rl/reach/<run>_ppo_torch/checkpoints/model_300.pt \
    --num_envs 4
"""

import argparse
import importlib
import os
import sys

import torch
from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Isaac Lab RL Policy Playback")
    parser.add_argument("--task", type=str, default="Workshop-SO101-Reach-v0",
                        help="Task ID (Workshop-SO101-Reach-v0 or Workshop-SO101-Lift-v0)")
    parser.add_argument("--checkpoint", type=str, required=True,
                        help="Path to a checkpoint written by train_isaaclab.py")
    parser.add_argument("--num_envs", type=int, default=4,
                        help="Number of parallel environments to render")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    args.headless = False
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

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

    env_cfg.scene.num_envs = args.num_envs

    env = gym.make(args.task, cfg=env_cfg, render_mode="human")
    env = RslRlVecEnvWrapper(env)

    print(f"Loading checkpoint: {args.checkpoint}")
    runner = OnPolicyRunner(env, agent_cfg.to_dict(), log_dir=None, device=agent_cfg.device)
    runner.load(args.checkpoint)
    policy = runner.get_inference_policy(device=env.unwrapped.device)

    print(f"Playing: {args.task}  (envs: {args.num_envs})")
    print("Close the Isaac Sim window, or Ctrl+C the job, to stop.")

    obs, _ = env.get_observations()
    while simulation_app.is_running():
        with torch.inference_mode():
            actions = policy(obs)
            obs, _, _, _ = env.step(actions)

    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
