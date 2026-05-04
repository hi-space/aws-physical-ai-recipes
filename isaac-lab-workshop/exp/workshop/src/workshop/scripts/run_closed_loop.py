"""Isaac Sim SO-101 Closed-loop client for GR00T Policy Server.

Runs Isaac Sim with SO-101, captures camera images + joint states,
sends observations to GR00T Policy Server (ZMQ), receives 16-step
action sequences, and applies them to the simulated robot.

Observation format (new_embodiment):
  video:    front (B,T,H,W,3 uint8), wrist (B,T,H,W,3 uint8)  T=1
  state:    single_arm (B,T,5 float32), gripper (B,T,1 float32) T=1
  language: annotation.human.task_description [[str]]

Action output:
  single_arm (1,16,5), gripper (1,16,1) — 16-step action horizon

Usage:
  /isaac-sim/python.sh run_closed_loop.py --policy_host localhost --policy_port 5555 --headless
"""
import argparse
import subprocess
import sys

from isaaclab.app import AppLauncher


def ensure_pyzmq():
    try:
        import zmq  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyzmq", "-q"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SO-101 Closed-loop with GR00T Policy Server")
    parser.add_argument("--policy_host", default="localhost", help="GR00T Policy Server host")
    parser.add_argument("--policy_port", type=int, default=5555, help="GR00T Policy Server port")
    parser.add_argument("--instruction", default="pick up the cube", help="Language instruction for GR00T")
    parser.add_argument("--num_steps", type=int, default=5000, help="Number of simulation steps")
    parser.add_argument("--action_repeat", type=int, default=2, help="Sim steps per action step")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


# ─── Minimal PolicyClient (no gr00t dependency) ───────────────────────

class PolicyClient:
    """Standalone ZMQ client for GR00T Policy Server (msgpack protocol)."""

    def __init__(self, host: str = "localhost", port: int = 5555, timeout_ms: int = 30000):
        import io

        import msgpack
        import numpy as np
        import zmq

        self._zmq = zmq
        self._msgpack = msgpack
        self._np = np
        self._io = io

        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.setsockopt(zmq.RCVTIMEO, timeout_ms)
        self.socket.setsockopt(zmq.SNDTIMEO, timeout_ms)
        self.socket.connect(f"tcp://{host}:{port}")

    def _encode(self, obj):
        if isinstance(obj, self._np.ndarray):
            buf = self._io.BytesIO()
            self._np.save(buf, obj, allow_pickle=False)
            return {"__ndarray_class__": True, "as_npy": buf.getvalue()}
        return obj

    def _decode(self, obj):
        if not isinstance(obj, dict):
            return obj
        if "__ndarray_class__" in obj:
            return self._np.load(self._io.BytesIO(obj["as_npy"]), allow_pickle=False)
        return obj

    def _send(self, request: dict):
        data = self._msgpack.packb(request, default=self._encode)
        self.socket.send(data)
        resp = self._msgpack.unpackb(self.socket.recv(), object_hook=self._decode)
        if isinstance(resp, dict) and "error" in resp:
            raise RuntimeError(f"Policy Server error: {resp['error']}")
        return resp

    def ping(self) -> bool:
        try:
            resp = self._send({"endpoint": "ping"})
            return resp.get("status") == "ok"
        except Exception:
            return False

    def get_action(self, observation: dict):
        resp = self._send({"endpoint": "get_action", "data": {"observation": observation}})
        return resp[0], resp[1]


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    ensure_pyzmq()
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import numpy as np
    import torch

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

    # Front camera — overhead view
    front_camera_cfg = CameraCfg(
        prim_path="/World/FrontCamera",
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
    front_camera = Camera(front_camera_cfg)

    # Wrist camera — attached near end-effector
    wrist_camera_cfg = CameraCfg(
        prim_path="/World/Robot/wrist_roll_link/WristCamera",
        update_period=0.033,
        height=256,
        width=256,
        data_types=["rgb"],
        spawn=sim_utils.PinholeCameraCfg(
            focal_length=24.0, focus_distance=400.0,
            horizontal_aperture=20.955, clipping_range=(0.1, 10.0),
        ),
        offset=CameraCfg.OffsetCfg(pos=(0.0, 0.0, 0.05), rot=(1.0, 0.0, 0.0, 0.0), convention="ros"),
    )
    wrist_camera = Camera(wrist_camera_cfg)

    sim.reset()
    robot.reset()
    front_camera.reset()
    wrist_camera.reset()

    policy = PolicyClient(host=args.policy_host, port=args.policy_port)
    if policy.ping():
        print(f"Connected to GR00T Policy Server at {args.policy_host}:{args.policy_port}")
    else:
        raise RuntimeError(f"Cannot reach Policy Server at {args.policy_host}:{args.policy_port}")

    action_queue = []
    action_step = 0

    for step in range(args.num_steps):
        sim.step()
        robot.update(sim.get_physics_dt())
        front_camera.update(sim.get_physics_dt())
        wrist_camera.update(sim.get_physics_dt())

        if not action_queue and step % args.action_repeat == 0:
            joint_pos = robot.data.joint_pos[0].cpu().numpy()
            front_rgb = front_camera.data.output["rgb"][0].cpu().numpy()
            wrist_rgb = wrist_camera.data.output["rgb"][0].cpu().numpy()

            obs = {
                "video": {
                    "front": front_rgb[:, :, :3].reshape(1, 1, 256, 256, 3).astype(np.uint8),
                    "wrist": wrist_rgb[:, :, :3].reshape(1, 1, 256, 256, 3).astype(np.uint8),
                },
                "state": {
                    "single_arm": joint_pos[:5].reshape(1, 1, 5).astype(np.float32),
                    "gripper": joint_pos[5:6].reshape(1, 1, 1).astype(np.float32),
                },
                "language": {
                    "annotation.human.task_description": [[args.instruction]],
                },
            }

            action_dict, info = policy.get_action(obs)
            arm_actions = action_dict["single_arm"][0]   # (16, 5)
            gripper_actions = action_dict["gripper"][0]   # (16, 1)
            for i in range(arm_actions.shape[0]):
                action_queue.append(
                    np.concatenate([arm_actions[i], gripper_actions[i]])  # (6,)
                )
            action_step += 1

        if action_queue:
            action = action_queue.pop(0)
            target_pos = torch.tensor(action, dtype=torch.float32, device=robot.device).unsqueeze(0)
            robot.set_joint_position_target(target_pos)

        if step % 500 == 0:
            print(f"Step {step}/{args.num_steps} — policy calls: {action_step}, queued: {len(action_queue)}")

    print("Closed-loop simulation complete.")
    sim.stop()
    simulation_app.close()


if __name__ == "__main__":
    main()
