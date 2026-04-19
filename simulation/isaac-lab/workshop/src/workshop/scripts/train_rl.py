"""RL training for SO-101 tasks using rsl_rl PPO."""
import argparse

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train SO-101 RL policy")
    parser.add_argument("--task", required=True, help="Gym environment ID (e.g. Workshop-SO101-Reach-v0)")
    parser.add_argument("--num_envs", type=int, default=None, help="Override number of environments")
    parser.add_argument("--max_iterations", type=int, default=None, help="Override max iterations")
    parser.add_argument("--checkpoint", type=str, default=None, help="Resume from checkpoint")
    parser.add_argument("--log_dir", type=str, default="logs/rsl_rl", help="Log directory")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import gymnasium as gym
    import importlib
    from rsl_rl.runners import OnPolicyRunner
    from isaaclab_rl.rsl_rl import RslRlVecEnvWrapper

    import workshop  # noqa: F401

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

    runner = OnPolicyRunner(
        env,
        agent_cfg.to_dict(),
        log_dir=f"{args.log_dir}/{agent_cfg.experiment_name}",
        device=agent_cfg.device,
    )

    if args.checkpoint:
        runner.load(args.checkpoint)

    runner.learn(num_learning_iterations=agent_cfg.max_iterations)

    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
