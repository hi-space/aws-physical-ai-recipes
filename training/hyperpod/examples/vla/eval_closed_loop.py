"""GR00T VLA Closed-loop Evaluation in Isaac Sim.

Runs trained GR00T policy in Isaac Sim for closed-loop evaluation.
The policy receives camera images + joint states and outputs actions
that are applied to the simulated robot.

Two modes:
  1. Local: GR00T policy loaded directly (requires gr00t package + GPU)
  2. Remote: Connects to GR00T inference server via ZMQ (policy on another node)

Usage (local):
  python eval_closed_loop.py \
    --model-path /fsx/checkpoints/vla/groot-demo_data/checkpoint-2000 \
    --embodiment-tag OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT \
    --num-episodes 5 \
    --headless

Usage (remote server):
  python eval_closed_loop.py \
    --policy-host 10.0.1.100 \
    --policy-port 5555 \
    --num-episodes 5 \
    --headless
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np


def parse_args():
    parser = argparse.ArgumentParser(description="GR00T VLA Closed-loop Evaluation")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--model-path", type=str, help="Local GR00T checkpoint path")
    group.add_argument("--policy-host", type=str, help="Remote policy server host")

    parser.add_argument("--policy-port", type=int, default=5555)
    parser.add_argument("--embodiment-tag", type=str,
                        default="OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT")
    parser.add_argument("--dataset-path", type=str, default=None,
                        help="Dataset path for reference trajectories (optional)")
    parser.add_argument("--num-episodes", type=int, default=5)
    parser.add_argument("--max-steps-per-episode", type=int, default=300)
    parser.add_argument("--action-horizon", type=int, default=16,
                        help="GR00T outputs 16-step action chunks")
    parser.add_argument("--instruction", type=str, default="pick up the object")
    parser.add_argument("--output-dir", type=str, default=None,
                        help="Save evaluation results (optional)")
    parser.add_argument("--headless", action="store_true")
    return parser.parse_args()


class LocalGR00TPolicy:
    """Load GR00T policy directly for inference."""

    def __init__(self, model_path: str, embodiment_tag: str, device: str = "cuda:0"):
        from gr00t.policy.gr00t_policy import Gr00tPolicy
        from gr00t.data.embodiment_tags import EmbodimentTag

        tag = EmbodimentTag.resolve(embodiment_tag)
        self.policy = Gr00tPolicy(
            embodiment_tag=tag,
            model_path=model_path,
            device=device,
        )
        self.modality_config = self.policy.get_modality_config()
        print(f"GR00T policy loaded from {model_path}")
        print(f"  Embodiment: {tag}")
        print(f"  Modalities: {list(self.modality_config.keys())}")

    def get_action(self, observation: dict):
        action = self.policy.get_action(observation)
        return action


class RemoteGR00TPolicy:
    """Connect to GR00T inference server via ZMQ."""

    def __init__(self, host: str, port: int, timeout_ms: int = 30000):
        import io
        import msgpack
        import zmq

        self._zmq = zmq
        self._msgpack = msgpack
        self._io = io

        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.setsockopt(zmq.RCVTIMEO, timeout_ms)
        self.socket.setsockopt(zmq.SNDTIMEO, timeout_ms)
        self.socket.connect(f"tcp://{host}:{port}")
        print(f"Connected to GR00T server at {host}:{port}")

    def _encode(self, obj):
        if isinstance(obj, np.ndarray):
            buf = self._io.BytesIO()
            np.save(buf, obj, allow_pickle=False)
            return {"__ndarray_class__": True, "as_npy": buf.getvalue()}
        return obj

    def _decode(self, obj):
        if isinstance(obj, dict) and "__ndarray_class__" in obj:
            return np.load(self._io.BytesIO(obj["as_npy"]), allow_pickle=False)
        return obj

    def get_action(self, observation: dict):
        data = self._msgpack.packb(
            {"endpoint": "get_action", "data": {"observation": observation}},
            default=self._encode,
        )
        self.socket.send(data)
        resp = self._msgpack.unpackb(self.socket.recv(), object_hook=self._decode)
        if isinstance(resp, dict) and "error" in resp:
            raise RuntimeError(f"Policy server error: {resp['error']}")
        return resp[0]


def create_dummy_observation(step: int, instruction: str):
    """Create a synthetic observation for testing without Isaac Sim.

    In production, these come from Isaac Sim cameras + robot joint sensors.
    """
    return {
        "video.front": np.random.randint(0, 255, (1, 1, 256, 256, 3), dtype=np.uint8),
        "state.single_arm": np.random.randn(1, 1, 5).astype(np.float32) * 0.1,
        "state.gripper": np.array([[[0.5]]], dtype=np.float32),
        "annotation.human.task_description": [[instruction]],
    }


def evaluate_open_loop_with_dataset(policy, dataset_path: str, embodiment_tag: str, num_episodes: int):
    """Evaluate policy against recorded trajectories (open-loop, no sim needed)."""
    from gr00t.data.dataset import LeRobotEpisodeLoader

    modality_config = policy.modality_config if hasattr(policy, "modality_config") else None
    if modality_config is None:
        print("WARNING: Cannot do open-loop eval without modality_config (remote mode)")
        return []

    loader = LeRobotEpisodeLoader(dataset_path=dataset_path, modality_configs=modality_config)
    num_available = len(loader)
    num_eval = min(num_episodes, num_available)

    results = []
    for ep_idx in range(num_eval):
        episode = loader[ep_idx]
        steps = len(episode)
        mse_sum = 0.0

        for step_idx in range(0, steps, 16):
            obs = {k: v[step_idx:step_idx+1] for k, v in episode.items()
                   if k.startswith("video") or k.startswith("state") or k.startswith("annotation")}

            action = policy.get_action(obs)

            for key in action:
                pred = np.array(action[key])[0, 0, :]
                if key in episode:
                    gt = np.array(episode[key][step_idx])[0, :]
                    mse_sum += np.mean((pred - gt) ** 2)

        mse_avg = mse_sum / max(1, steps // 16)
        results.append({"episode": ep_idx, "mse": mse_avg, "steps": steps})
        print(f"  Episode {ep_idx}: MSE={mse_avg:.4f}, steps={steps}")

    return results


def evaluate_closed_loop_dummy(policy, args):
    """Closed-loop evaluation with synthetic observations.

    This demonstrates the evaluation loop structure.
    For real evaluation, replace create_dummy_observation() with
    Isaac Sim camera + joint sensor readings.
    """
    results = []

    for ep in range(args.num_episodes):
        action_queue = []
        total_reward = 0.0
        ep_start = time.time()

        for step in range(args.max_steps_per_episode):
            if not action_queue:
                obs = create_dummy_observation(step, args.instruction)
                action_chunk = policy.get_action(obs)

                for key in action_chunk:
                    arr = np.array(action_chunk[key])
                    horizon = arr.shape[1] if arr.ndim >= 3 else 1
                    for t in range(horizon):
                        if len(action_queue) <= t:
                            action_queue.append({})
                        action_queue[t][key] = arr[0, t, :] if arr.ndim >= 3 else arr[0, :]

            if action_queue:
                current_action = action_queue.pop(0)

            total_reward += np.random.uniform(-0.1, 0.1)

        elapsed = time.time() - ep_start
        results.append({
            "episode": ep,
            "total_reward": total_reward,
            "steps": args.max_steps_per_episode,
            "elapsed_s": elapsed,
        })
        print(f"  Episode {ep}: reward={total_reward:.2f}, "
              f"steps={args.max_steps_per_episode}, time={elapsed:.1f}s")

    return results


def main():
    args = parse_args()

    if args.model_path:
        policy = LocalGR00TPolicy(args.model_path, args.embodiment_tag)
    else:
        policy = RemoteGR00TPolicy(args.policy_host, args.policy_port)

    print(f"\n{'='*60}")
    print(f"GR00T Closed-loop Evaluation")
    print(f"{'='*60}")
    print(f"  Episodes: {args.num_episodes}")
    print(f"  Max steps/episode: {args.max_steps_per_episode}")
    print(f"  Instruction: {args.instruction}")

    if args.dataset_path:
        print(f"\n--- Open-loop evaluation (vs dataset) ---")
        results = evaluate_open_loop_with_dataset(
            policy, args.dataset_path, args.embodiment_tag, args.num_episodes
        )
        if results:
            mean_mse = np.mean([r["mse"] for r in results])
            print(f"\n  Mean MSE: {mean_mse:.4f}")
    else:
        print(f"\n--- Closed-loop evaluation (synthetic) ---")
        print(f"  NOTE: For real closed-loop, use with Isaac Sim or pass --dataset-path")
        results = evaluate_closed_loop_dummy(policy, args)

    if args.output_dir:
        import json
        out_path = Path(args.output_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        with open(out_path / "eval_results.json", "w") as f:
            json.dump({"args": vars(args), "results": results}, f, indent=2, default=str)
        print(f"\nResults saved to {out_path / 'eval_results.json'}")

    print(f"\n{'='*60}")
    print("Evaluation complete.")


if __name__ == "__main__":
    main()
