"""Isaac Lab RL Policy Playback on HyperPod (GUI / DCV).

Loads a checkpoint trained by train_isaaclab.py and runs it in a
small number of rendered environments so a human can watch the SO-101
arm execute the learned policy over a DCV session.

Tasks:
  Workshop-SO101-Reach-v0  — 5-DOF arm reaches random targets
  Workshop-SO101-Lift-v0   — 5-DOF arm + gripper reaches a target above a table

Usage:
  # Inside the Isaac Lab container on the debug node (DCV session, GUI):
  python play_isaaclab.py \
    --task Workshop-SO101-Reach-v0 \
    --checkpoint /fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt \
    --num_envs 4

  # No display needed — record an mp4 of the rendered scene instead (offscreen, any GPU node):
  python play_isaaclab.py \
    --task Workshop-SO101-Reach-v0 \
    --checkpoint /fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt \
    --num_envs 4 --video --video_length 900
  # → <checkpoint dir>/videos/<task>_<checkpoint>-step-0.mp4
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
    parser.add_argument("--video", action="store_true",
                        help="Record an mp4 of the rendered scene offscreen instead of opening a window "
                             "(implies --headless and --enable_cameras)")
    parser.add_argument("--video_length", type=int, default=900,
                        help="Number of simulation steps to record with --video (50 steps = 1 s)")
    parser.add_argument("--video_dir", type=str, default=None,
                        help="Output directory for --video (default: <checkpoint dir>/videos)")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    if args.video:
        # RecordVideo needs rgb_array frames, which Isaac Lab renders offscreen only with cameras enabled.
        args.headless = True
        args.enable_cameras = True
    # 기본은 GUI(DCV 데스크톱에서 시각 확인용, --headless 미지정 시 False).
    # --headless 를 명시하면 그대로 존중한다 — GUI 없이 체크포인트 로드와
    # 정책 실행만 검증할 때(예: SSH/SSM 터미널) 유용하다.
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

    if args.video:
        env_cfg.viewer.resolution = (1280, 720)
        # Draw the commanded target pose (goal frame marker) so the recording shows what the
        # arm is tracking — the red sphere in the scene is a fixed decoration, not the target.
        for term_name in getattr(env_cfg.commands, "__dataclass_fields__", {}) or vars(env_cfg.commands):
            term = getattr(env_cfg.commands, term_name, None)
            if hasattr(term, "debug_vis"):
                term.debug_vis = True
        env = gym.make(args.task, cfg=env_cfg, render_mode="rgb_array")
        # Frame env 0's arm from the front-right (env origins are spread on a grid).
        origin = env.unwrapped.scene.env_origins[0].cpu().numpy()
        env.unwrapped.sim.set_camera_view(
            eye=tuple(origin + (1.0, 0.9, 0.65)), target=tuple(origin + (0.25, 0.0, 0.15)))
        ckpt_stem = os.path.splitext(os.path.basename(args.checkpoint))[0]
        video_dir = args.video_dir or os.path.join(os.path.dirname(os.path.abspath(args.checkpoint)), "videos")
        env = gym.wrappers.RecordVideo(
            env, video_folder=video_dir, step_trigger=lambda step: step == 0,
            video_length=args.video_length, name_prefix=f"{args.task}_{ckpt_stem}", disable_logger=True)
        print(f"Recording {args.video_length} steps to {video_dir}/")
    else:
        env = gym.make(args.task, cfg=env_cfg, render_mode="human")
    env = RslRlVecEnvWrapper(env)

    print(f"Loading checkpoint: {args.checkpoint}")
    runner = OnPolicyRunner(env, agent_cfg.to_dict(), log_dir=None, device=agent_cfg.device)
    runner.load(args.checkpoint)
    policy = runner.get_inference_policy(device=env.unwrapped.device)

    print(f"Playing: {args.task}  (envs: {args.num_envs})")
    print("Close the Isaac Sim window, or Ctrl+C the job, to stop.")

    # rsl_rl 버전에 따라 get_observations()/step() 반환 형태가 다르다:
    # 구버전은 (obs, extras) 튜플, 신버전(rsl_rl 3.x)은 obs 단독. 둘 다 지원한다.
    def _obs_of(ret):
        return ret[0] if isinstance(ret, tuple) else ret

    obs = _obs_of(env.get_observations())
    step = 0
    while simulation_app.is_running():
        with torch.inference_mode():
            actions = policy(obs)
            obs = _obs_of(env.step(actions))
        step += 1
        if args.video and step >= args.video_length:
            break

    env.close()
    if args.video:
        print(f"Video written under {video_dir}/")
    simulation_app.close()


if __name__ == "__main__":
    main()
