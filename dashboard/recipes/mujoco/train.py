"""SB3 PPO training using the unchanged workshop SO-101 physics and rewards."""
import argparse
from pathlib import Path
import signal

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import VecNormalize

from common import LiveFrames, TASK, alias_bundle, load_bundle, make_env, save_bundle, write_json
from runtime_resume import runtime_resume_bundle


def mean_return(model, stats, task, seed, episodes):
    # Evaluate a frozen copy of the *current* normalization, using fixed seeds.
    env = VecNormalize.load(stats, make_env(task, seed=seed))
    env.training, env.norm_reward = False, False
    returns = []
    try:
        for episode in range(episodes):
            env.seed(seed + episode)
            obs, total = env.reset(), 0.0
            while True:
                action, _ = model.predict(obs, deterministic=True)
                obs, reward, done, _ = env.step(action)
                total += float(reward[0])
                if done[0]:
                    break
            returns.append(total)
    finally:
        env.close()
    return float(np.mean(returns))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--task", default=TASK, choices=[TASK])
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--total-steps", type=int, default=200_000, help="additional steps when resuming; rounded to rollout")
    parser.add_argument("--num-envs", type=int, default=4)
    parser.add_argument("--n-steps", type=int, default=256)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--checkpoint-every", type=int, default=10_000)
    parser.add_argument("--eval-episodes", type=int, default=3)
    parser.add_argument("--resume", default="", help="trusted bundle directory; empty uses verified PAI_RESUME_CHECKPOINTS when available")
    args = parser.parse_args()
    if min(args.total_steps, args.num_envs, args.n_steps, args.batch_size,
           args.checkpoint_every, args.eval_episodes) < 1 or args.batch_size < 2:
        parser.error("steps, envs, checkpoints and episodes must be positive; batch-size >= 2")
    if args.n_steps * args.num_envs < 2 or (args.n_steps * args.num_envs) % args.batch_size:
        parser.error("rollout size must be >= 2 and divisible by batch-size")
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    if any((output / name).exists() for name in ("initial", "final", "checkpoints")):
        raise FileExistsError("output already contains training results; choose a new run/attempt output")
    resume = Path(args.resume) if args.resume else runtime_resume_bundle(output, args.task)
    resume_source = "explicit" if args.resume else "runtime" if resume else "fresh"
    torch.set_num_threads(1)
    live = LiveFrames()  # dashboard live view; renders only when a frame is due
    raw = make_env(args.task, args.num_envs, args.seed, render=live.enabled)
    parent = None
    if resume:
        checkpoint, parent = load_bundle(resume, args.task)
        env = VecNormalize.load(checkpoint / "vecnormalize.pkl", raw)
        env.training, env.norm_reward = True, False
        model = PPO.load(checkpoint / "model.zip", env=env, device="cpu",
                         seed=args.seed, tensorboard_log=str(output / "tb"))
        # Do not change the saved rollout buffer dimensions when restoring PPO.
        if model.n_steps != args.n_steps or model.batch_size != args.batch_size:
            raise ValueError("resume n-steps and batch-size must match the saved PPO configuration")
    else:
        env = VecNormalize(raw, norm_obs=True, norm_reward=False, clip_obs=10.0)
        model = PPO("MlpPolicy", env, n_steps=args.n_steps, batch_size=args.batch_size,
                    n_epochs=10, learning_rate=3e-4, seed=args.seed, device="cpu",
                    policy_kwargs={"log_std_init": -1.0}, tensorboard_log=str(output / "tb"), verbose=1)
    start_steps = model.num_timesteps
    save_bundle(model, env, output / "initial", task=args.task, seed=args.seed, parent=parent)
    stop_requested = False

    def stop(_sig, _frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    class Checkpoints(BaseCallback):
        def __init__(self):
            super().__init__()
            self.last = start_steps
            self.candidates = []

        def save(self):
            path = output / "checkpoints" / f"step-{model.num_timesteps:012d}"
            if path.exists():
                return
            save_bundle(model, env, path, task=args.task, seed=args.seed, parent=parent)
            reward = mean_return(model, path / "vecnormalize.pkl", args.task,
                                 args.seed + 1000, args.eval_episodes)
            self.candidates.append({"path": str(path.relative_to(output)), "timesteps": model.num_timesteps,
                                    "meanReturn": reward, "evaluationSeed": args.seed + 1000})
            self.logger.record("eval/mean_reward", reward)
            self.last = model.num_timesteps

        def _on_step(self):
            if live.due():
                live.publish(env.venv.envs[0].render())
            if model.num_timesteps - self.last >= args.checkpoint_every:
                self.save()
            return not stop_requested

    callback = Checkpoints()
    try:
        model.learn(total_timesteps=args.total_steps, callback=callback,
                    reset_num_timesteps=False, tb_log_name="ppo")
        callback.save()
        final_metadata = save_bundle(model, env, output / "final", task=args.task, seed=args.seed, parent=parent)
        # Final optimizer update occurs after the last rollout callback.
        final_reward = mean_return(model, output / "final/vecnormalize.pkl", args.task,
                                   args.seed + 1000, args.eval_episodes)
        callback.candidates.append({"path": "final", "timesteps": model.num_timesteps,
                                    "meanReturn": final_reward, "evaluationSeed": args.seed + 1000})
        best = max(callback.candidates, key=lambda x: x["meanReturn"])
        alias_bundle(output / best["path"], output, "best")
        alias_bundle(output / "final", output, "final")
        write_json(output / "best_checkpoint.json", {
            "selectionMetric": "fixed_seed_mean_return", "best": best, "candidates": callback.candidates,
            "warning": "training selection score is not independent evaluation success rate",
        })
        write_json(output / "training.json", {**final_metadata, "initialTimesteps": start_steps,
                                               "interrupted": stop_requested,
                                               "resumeSource": resume_source,
                                               "resumeBundle": str(resume) if resume else None})
    finally:
        env.close()
    if stop_requested:
        raise SystemExit(75)  # explicit RESCHEDULE; durable checkpoint is already complete


if __name__ == "__main__":
    main()
