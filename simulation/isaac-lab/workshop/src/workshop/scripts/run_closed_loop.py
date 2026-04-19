"""Isaac Sim SO-101 Closed-loop client for GR00T Policy Server.

Runs Isaac Sim with SO-101, captures camera images + joint states,
sends observations to GR00T Policy Server (ZMQ), receives 16-step
action sequences, and applies them to the simulated robot.
"""
import argparse

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SO-101 Closed-loop with GR00T Policy Server")
    parser.add_argument("--policy_host", default="localhost", help="GR00T Policy Server host")
    parser.add_argument("--policy_port", type=int, default=5555, help="GR00T Policy Server port")
    parser.add_argument("--instruction", default="lift the cube", help="Language instruction for GR00T")
    parser.add_argument("--num_steps", type=int, default=5000, help="Number of simulation steps")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import numpy as np
    import torch
    from gr00t.policy.server_client import PolicyClient

    from isaaclab.sim import SimulationContext
    import isaaclab.sim as sim_utils
    from isaaclab.sensors import CameraCfg, Camera
    from workshop.robots import SO_ARM101_CFG

    sim_cfg = sim_utils.SimulationCfg(dt=0.01)
    sim = SimulationContext(sim_cfg)
    sim.set_camera_view(eye=[1.0, 1.0, 0.8], target=[0.3, 0.0, 0.2])

    sim_utils.GroundPlaneCfg().func("/World/ground", sim_utils.GroundPlaneCfg())
    sim_utils.DistantLightCfg(intensity=3000.0).func("/World/light", sim_utils.DistantLightCfg(intensity=3000.0))

    robot_cfg = SO_ARM101_CFG.copy()
    robot_cfg.prim_path = "/World/Robot"
    robot = robot_cfg.class_type(cfg=robot_cfg)

    camera_cfg = CameraCfg(
        prim_path="/World/Camera",
        update_period=0.033,
        height=256,
        width=256,
        data_types=["rgb"],
        spawn=sim_utils.PinholeCameraCfg(
            focal_length=24.0, focus_distance=400.0,
            horizontal_aperture=20.955, clipping_range=(0.1, 10.0),
        ),
        offset=CameraCfg.OffsetCfg(pos=(0.6, 0.0, 0.6), rot=(0.9, 0.0, -0.44, 0.0), convention="world"),
    )
    camera = Camera(camera_cfg)

    sim.reset()
    robot.reset()
    camera.reset()

    # GR00T PolicyClient handles ZMQ communication internally
    policy = PolicyClient(host=args.policy_host, port=args.policy_port)
    print(f"Connected to GR00T Policy Server at {args.policy_host}:{args.policy_port}")

    action_queue = []

    for step in range(args.num_steps):
        sim.step()
        robot.update(sim.get_physics_dt())
        camera.update(sim.get_physics_dt())

        if not action_queue:
            joint_pos = robot.data.joint_pos[0].cpu().numpy()
            rgb = camera.data.output["rgb"][0].cpu().numpy()

            # GR00T observation format: all tensors are (Batch, Time, ...)
            obs = {
                "video": {
                    "ego_view": rgb.reshape(1, 1, 256, 256, 3).astype(np.uint8),
                },
                "state": {
                    "single_arm": joint_pos[:5].reshape(1, 1, 5).astype(np.float32),
                    "gripper": joint_pos[5:6].reshape(1, 1, 1).astype(np.float32),
                },
                "language": {
                    "task": [[args.instruction]],
                },
            }

            action, info = policy.get_action(obs)
            # action shape: (horizon=16, action_dim)
            action_queue = list(action)

        if action_queue:
            action = action_queue.pop(0)
            target_pos = torch.tensor(action[:6], dtype=torch.float32, device=robot.device).unsqueeze(0)
            robot.set_joint_position_target(target_pos)

        if step % 500 == 0:
            print(f"Step {step}/{args.num_steps} — actions queued: {len(action_queue)}")

    print("Closed-loop simulation complete.")
    sim.stop()
    simulation_app.close()


if __name__ == "__main__":
    main()
