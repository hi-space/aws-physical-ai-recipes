"""IsaacLab RL 학습 (Actor-Learner with Ray).

Usage:
  python train_isaaclab.py \
    --env Isaac-Cartpole-v0 \
    --num-actors 8 \
    --checkpoint-dir /fsx/checkpoints/rl/cartpole-001
"""
import argparse
import os

import mlflow
import ray
import torch


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=str, default="Isaac-Cartpole-v0")
    parser.add_argument("--num-actors", type=int, default=8)
    parser.add_argument("--total-timesteps", type=int, default=10_000_000)
    parser.add_argument("--checkpoint-dir", type=str, required=True)
    parser.add_argument("--checkpoint-freq", type=int, default=100_000)
    parser.add_argument("--experiment", type=str, default="rl-training")
    return parser.parse_args()


@ray.remote(num_gpus=1)
class IsaacLabActor:
    """IsaacLab 환경을 실행하는 Ray Actor."""

    def __init__(self, env_name: str, actor_id: int):
        from omni.isaac.lab.app import AppLauncher
        app_launcher = AppLauncher(headless=True)

        import omni.isaac.lab_tasks  # noqa: F401
        import gymnasium as gym

        self.env = gym.make(env_name)
        self.actor_id = actor_id

    def rollout(self, policy_weights):
        """하나의 에피소드를 수행하고 trajectory를 반환."""
        obs, _ = self.env.reset()
        trajectory = []
        done = False

        while not done:
            action = self._get_action(obs, policy_weights)
            next_obs, reward, terminated, truncated, info = self.env.step(action)
            trajectory.append((obs, action, reward, next_obs, terminated))
            obs = next_obs
            done = terminated or truncated

        return trajectory

    def _get_action(self, obs, policy_weights):
        import numpy as np
        # NOTE: 실제 구현에서는 policy network forward pass로 교체
        return self.env.action_space.sample()


def main():
    args = parse_args()

    ray.init()
    os.makedirs(args.checkpoint_dir, exist_ok=True)

    mlflow.set_experiment(args.experiment)
    mlflow.start_run()
    mlflow.log_params(vars(args))

    actors = [IsaacLabActor.remote(args.env, i) for i in range(args.num_actors)]

    total_steps = 0
    episode_count = 0
    policy_weights = None

    while total_steps < args.total_timesteps:
        trajectory_futures = [actor.rollout.remote(policy_weights) for actor in actors]
        trajectories = ray.get(trajectory_futures)

        for traj in trajectories:
            episode_reward = sum(t[2] for t in traj)
            episode_length = len(traj)
            total_steps += episode_length
            episode_count += 1

            mlflow.log_metrics({
                "reward": episode_reward,
                "episode_length": episode_length,
                "total_steps": total_steps,
            }, step=episode_count)

        if total_steps % args.checkpoint_freq < args.num_actors * 1000:
            ckpt_path = os.path.join(args.checkpoint_dir, f"step-{total_steps}.pt")
            torch.save({"step": total_steps, "policy": policy_weights}, ckpt_path)
            print(f"[Step {total_steps}] Checkpoint saved: {ckpt_path}")

    mlflow.end_run()
    ray.shutdown()


if __name__ == "__main__":
    main()
