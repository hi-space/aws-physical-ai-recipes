"""학습된 VLA/RL 모델을 Isaac Sim에서 검증하는 스크립트.

DCV debug 세션에서 실행:
  python verify_in_sim.py --checkpoint /fsx/checkpoints/vla/groot-aloha/model_final.pt
"""
import argparse

import torch


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=str, required=True)
    parser.add_argument("--env", type=str, default="Isaac-Lift-Franka-v0")
    parser.add_argument("--num-episodes", type=int, default=10)
    parser.add_argument("--render", action="store_true", default=True)
    return parser.parse_args()


def main():
    args = parse_args()

    from omni.isaac.lab.app import AppLauncher
    app_launcher = AppLauncher(headless=not args.render)
    simulation_app = app_launcher.app

    import omni.isaac.lab_tasks  # noqa: F401
    import gymnasium as gym

    env = gym.make(args.env, render_mode="human" if args.render else None)

    device = torch.device("cuda:0")
    model_state = torch.load(args.checkpoint, map_location=device)

    # NOTE: 실제 사용 시 모델 아키텍처에 맞게 로드 방식 변경
    from gr00t.model import GR00TModel
    model = GR00TModel.from_pretrained("nvidia/GR00T-N1.6-3B")
    model.load_state_dict(model_state)
    model = model.to(device).eval()

    success_count = 0
    for episode in range(args.num_episodes):
        obs, info = env.reset()
        done = False
        steps = 0

        while not done:
            with torch.no_grad():
                obs_tensor = {k: torch.tensor(v).unsqueeze(0).to(device) for k, v in obs.items()}
                action = model.predict(obs_tensor)
                action = action.squeeze(0).cpu().numpy()

            obs, reward, terminated, truncated, info = env.step(action)
            done = terminated or truncated
            steps += 1

        success = info.get("is_success", False)
        success_count += int(success)
        print(f"Episode {episode+1}: {'SUCCESS' if success else 'FAIL'} ({steps} steps)")

    print(f"\nResults: {success_count}/{args.num_episodes} success ({100*success_count/args.num_episodes:.0f}%)")

    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
