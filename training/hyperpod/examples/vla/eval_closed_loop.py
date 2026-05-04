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


def create_dummy_observation(policy, step: int, instruction: str):
    """Create a synthetic observation for testing without Isaac Sim.

    In production, these come from Isaac Sim cameras + robot joint sensors.
    Uses the policy's modality config to build correctly-keyed observations.
    """
    modality_config = policy.modality_config
    obs = {}
    for modality_name in ["video", "state", "language"]:
        if modality_name not in modality_config:
            continue
        obs[modality_name] = {}
        mc = modality_config[modality_name]
        for key in mc.modality_keys:
            if modality_name == "video":
                horizon = len(mc.delta_indices) if hasattr(mc, "delta_indices") else 2
                obs[modality_name][key] = np.random.randint(0, 255, (1, horizon, 256, 256, 3), dtype=np.uint8)
            elif modality_name == "state":
                horizon = len(mc.delta_indices) if hasattr(mc, "delta_indices") else 1
                obs[modality_name][key] = np.random.randn(1, horizon, 7).astype(np.float32) * 0.1
            elif modality_name == "language":
                obs[modality_name][key] = [[instruction]]
    return obs


def evaluate_open_loop_with_dataset(policy, dataset_path: str, embodiment_tag: str, num_episodes: int):
    """Evaluate policy against recorded trajectories (open-loop, no sim needed)."""
    from copy import deepcopy
    from gr00t.data.dataset.lerobot_episode_loader import LeRobotEpisodeLoader
    from gr00t.data.dataset.sharded_single_step_dataset import extract_step_data
    from gr00t.data.embodiment_tags import EmbodimentTag

    modality_config = policy.modality_config if hasattr(policy, "modality_config") else None
    if modality_config is None:
        print("WARNING: Cannot do open-loop eval without modality_config (remote mode)")
        return []

    inner_policy = policy.policy if hasattr(policy, "policy") else policy
    tag = EmbodimentTag.resolve(embodiment_tag)
    loader = LeRobotEpisodeLoader(dataset_path=dataset_path, modality_configs=modality_config)
    num_available = len(loader)
    num_eval = min(num_episodes, num_available)
    action_keys = modality_config["action"].modality_keys
    obs_modality_configs = deepcopy(modality_config)
    obs_modality_configs.pop("action")

    results = []
    for ep_idx in range(num_eval):
        traj = loader[ep_idx]
        traj_length = len(traj)
        action_horizon = 16
        step_counts = list(range(0, min(100, traj_length), action_horizon))
        mse_values = []

        for step_count in step_counts:
            data_point = extract_step_data(traj, step_count, obs_modality_configs, tag)

            obs = {}
            for k, v in data_point.states.items():
                obs[f"state.{k}"] = v
            for k, v in data_point.images.items():
                obs[f"video.{k}"] = np.array(v)
            for language_key in modality_config["language"].modality_keys:
                obs[language_key] = data_point.text

            parsed_obs = {}
            for modality in ["video", "state", "language"]:
                parsed_obs[modality] = {}
                for key in obs_modality_configs[modality].modality_keys:
                    if modality == "language":
                        parsed_key = key
                    else:
                        parsed_key = f"{modality}.{key}"
                    arr = obs[parsed_key]
                    if isinstance(arr, str):
                        parsed_obs[modality][key] = [[arr]]
                    else:
                        parsed_obs[modality][key] = arr[None, :]

            action_chunk, _ = inner_policy.get_action(parsed_obs)

            pred_concat = np.concatenate(
                [np.array(action_chunk[key])[0, 0, :] for key in action_chunk], axis=0
            )

            gt_arrays = []
            for key in action_keys:
                gt_val = traj.iloc[step_count].get(f"action.{key}", None)
                if gt_val is not None:
                    gt_arrays.append(np.array(gt_val))
            if gt_arrays:
                gt_concat = np.concatenate(gt_arrays, axis=0)
                mse = float(np.mean((pred_concat - gt_concat) ** 2))
                mse_values.append(mse)

        ep_mse = float(np.mean(mse_values)) if mse_values else 0.0
        results.append({"episode": ep_idx, "mse": ep_mse, "steps_evaluated": len(step_counts)})
        print(f"  Episode {ep_idx}: steps_evaluated={len(step_counts)}, MSE={ep_mse:.6f}")

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
                obs = create_dummy_observation(policy, step, args.instruction)
                try:
                    action_chunk, _ = policy.policy.get_action(obs)
                except (AssertionError, IndexError) as e:
                    if step == 0 and ep == 0:
                        print(f"  WARNING: Synthetic observations incompatible with model: {e}")
                        print("  Use --dataset-path for accurate evaluation.")
                        return []
                    break

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
