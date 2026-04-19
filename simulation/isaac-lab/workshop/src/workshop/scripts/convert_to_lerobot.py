"""Convert collected .npz demo episodes to LeRobot v2.1 format."""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

FPS = 30
JOINT_NAMES = [
    "shoulder_pan.pos",
    "shoulder_lift.pos",
    "elbow_flex.pos",
    "wrist_flex.pos",
    "wrist_roll.pos",
    "gripper.pos",
]


def write_info_json(output_path: Path, total_episodes: int, total_frames: int) -> None:
    info = {
        "codebase_version": "v2.1",
        "robot_type": "so101_follower",
        "total_episodes": total_episodes,
        "total_frames": total_frames,
        "total_tasks": 1,
        "chunks_size": 1000,
        "fps": FPS,
        "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "features": {
            "action": {"dtype": "float32", "shape": [6], "names": JOINT_NAMES},
            "observation.state": {"dtype": "float32", "shape": [6], "names": JOINT_NAMES},
            "timestamp": {"dtype": "float32", "shape": [1]},
        },
    }
    (output_path / "meta" / "info.json").write_text(json.dumps(info, indent=2))


def write_episodes_jsonl(output_path: Path, episodes: list[dict]) -> None:
    with open(output_path / "meta" / "episodes.jsonl", "w") as f:
        for ep in episodes:
            f.write(json.dumps(ep) + "\n")


def write_tasks_jsonl(output_path: Path, task_description: str) -> None:
    with open(output_path / "meta" / "tasks.jsonl", "w") as f:
        f.write(json.dumps({"task_index": 0, "task": task_description}) + "\n")


def write_modality_json(output_path: Path) -> None:
    modality = {
        "state": {
            "single_arm": {"start": 0, "end": 5},
            "gripper": {"start": 5, "end": 6},
        },
        "action": {
            "single_arm": {"start": 0, "end": 5},
            "gripper": {"start": 5, "end": 6},
        },
        "annotation": {
            "human.task_description": {"original_key": "task_index"},
        },
    }
    (output_path / "meta" / "modality.json").write_text(json.dumps(modality, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert .npz demos to LeRobot v2.1")
    parser.add_argument("--input_dir", required=True, help="Directory with episode_*.npz files")
    parser.add_argument("--output_dir", required=True, help="Output LeRobot dataset directory")
    parser.add_argument("--task_description", default="lift cube to target height", help="Task text")
    return parser.parse_args()


def main():
    args = parse_args()
    input_path = Path(args.input_dir)
    output_path = Path(args.output_dir)

    (output_path / "meta").mkdir(parents=True, exist_ok=True)
    (output_path / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)

    npz_files = sorted(input_path.glob("episode_*.npz"))
    if not npz_files:
        raise FileNotFoundError(f"No episode_*.npz files found in {input_path}")

    episodes_meta = []
    global_idx = 0
    total_frames = 0

    for ep_idx, npz_file in enumerate(npz_files):
        data = np.load(npz_file)
        states = data["states"].astype(np.float32)
        actions = data["actions"].astype(np.float32)
        ep_len = min(len(states), len(actions))

        if states.shape[1] < 6:
            pad = np.zeros((ep_len, 6 - states.shape[1]), dtype=np.float32)
            states = np.concatenate([states[:ep_len], pad], axis=1)
        if actions.shape[1] < 6:
            pad = np.zeros((ep_len, 6 - actions.shape[1]), dtype=np.float32)
            actions = np.concatenate([actions[:ep_len], pad], axis=1)

        rows = []
        for i in range(ep_len):
            rows.append({
                "observation.state": states[i].tolist(),
                "action": actions[i].tolist(),
                "timestamp": float(i) / FPS,
                "frame_index": i,
                "episode_index": ep_idx,
                "index": global_idx,
                "task_index": 0,
                "next.done": i == ep_len - 1,
                "next.reward": 0.0,
            })
            global_idx += 1

        df = pd.DataFrame(rows)
        df.to_parquet(output_path / "data" / "chunk-000" / f"episode_{ep_idx:06d}.parquet")

        episodes_meta.append({
            "episode_index": ep_idx,
            "tasks": [args.task_description],
            "length": ep_len,
        })
        total_frames += ep_len

    write_info_json(output_path, len(npz_files), total_frames)
    write_episodes_jsonl(output_path, episodes_meta)
    write_tasks_jsonl(output_path, args.task_description)
    write_modality_json(output_path)

    print(f"\nConverted {len(npz_files)} episodes ({total_frames} frames) → {output_path}")
    print("Next: run stats.py to generate normalization statistics")


if __name__ == "__main__":
    main()
