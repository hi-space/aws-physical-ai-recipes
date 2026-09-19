"""Workshop Reach/Lift and upstream H1 PPO with per-run seed/checkpoints."""
import argparse
import importlib
import inspect
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tracking import tracked


def main():
    from isaaclab.app import AppLauncher
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--num-envs", type=int, default=2048)
    parser.add_argument("--iterations", type=int, default=300)
    parser.add_argument("--checkpoint-every", type=int, default=50)
    parser.add_argument("--resume", default="")
    parser.add_argument("--live-view", choices=["on", "off"], default="off",
                        help="Publish frames to PAI_LIVE_DIR at ~10 fps during training")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    # PAI_LIVE_DIR is a plain env var (no isaaclab import needed), so it is safe to read
    # before AppLauncher. Without it, --live-view on must be a true no-op per spec: skip
    # enabling cameras and rgb_array rendering, not just skip the frame publisher.
    from pai_live import LiveFrames
    frames = LiveFrames() if args.live_view == "on" else None
    live = frames is not None and frames.enabled
    # Cameras must be enabled before the app launches for rgb_array rendering to work.
    if live:
        args.enable_cameras = True
    app = AppLauncher(args).app
    env = None
    try:
        import gymnasium as gym
        import isaaclab_tasks  # noqa: F401
        import workshop  # noqa: F401
        from isaaclab_rl.rsl_rl import RslRlVecEnvWrapper
        from rsl_rl.algorithms import PPO
        from rsl_rl.runners import OnPolicyRunner
        from isaaclab.utils.io import dump_yaml

        def config(key):
            module, name = gym.spec(args.task).kwargs[key].rsplit(":", 1)
            return getattr(importlib.import_module(module), name)()

        environment, agent = config("env_cfg_entry_point"), config("rsl_rl_cfg_entry_point")
        environment.scene.num_envs = args.num_envs
        environment.seed = args.seed
        agent.seed, agent.save_interval = args.seed, args.checkpoint_every
        agent.logger = "tensorboard"
        algorithm = agent.to_dict()
        valid = set(inspect.signature(PPO.__init__).parameters)
        algorithm["algorithm"] = {k: v for k, v in algorithm["algorithm"].items() if k in valid or k == "class_name"}
        dump_yaml(str(output / "environment.yaml"), environment)
        dump_yaml(str(output / "agent.yaml"), agent)
        render_mode = "rgb_array" if live else None
        env = RslRlVecEnvWrapper(gym.make(args.task, cfg=environment, render_mode=render_mode))
        if live:
            from live import LiveStepPublisher
            env = LiveStepPublisher(env, frames)
        with tracked(output, {"task": args.task, "seed": args.seed, "num_envs": args.num_envs,
                              "iterations": args.iterations, "resume": args.resume}):
            runner = OnPolicyRunner(env, algorithm, log_dir=str(output / "checkpoints"), device=agent.device)
            if args.resume:
                runner.load(args.resume)
            runner.learn(num_learning_iterations=args.iterations, init_at_random_ep_len=True)
            runner.save(str(output / "model_final.pt"))
            if runner.writer:
                runner.writer.flush()
            (output / "training.json").write_text(json.dumps({
                "task": args.task, "seed": args.seed, "iterations": args.iterations,
                "resume": args.resume, "checkpoint": "model_final.pt",
                "evaluationType": "training_only",
            }, indent=2))
    finally:
        if env is not None:
            env.close()
        app.close()


if __name__ == "__main__":
    main()
