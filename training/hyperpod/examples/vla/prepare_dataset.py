"""GR00T dataset preparation and validation tool.

Validates LeRobot v2 format requirements and generates missing metadata files.

Usage:
  python prepare_dataset.py --dataset-path /fsx/datasets/groot/aloha --validate
  python prepare_dataset.py --dataset-path /fsx/datasets/groot/aloha --generate-tasks "pick up the block"
"""

import argparse
import json
import sys
from pathlib import Path


def validate_dataset(dataset_path: Path) -> list[str]:
    """Validate LeRobot v2 dataset structure. Returns list of errors."""
    errors = []

    meta_dir = dataset_path / "meta"
    if not meta_dir.is_dir():
        errors.append(f"Missing meta/ directory at {meta_dir}")
        return errors

    if not (meta_dir / "info.json").is_file():
        errors.append("Missing required file: meta/info.json")

    if (meta_dir / "info.json").is_file():
        try:
            info = json.loads((meta_dir / "info.json").read_text())
            if "codebase_version" not in info:
                errors.append("meta/info.json missing 'codebase_version' field")
        except json.JSONDecodeError as e:
            errors.append(f"meta/info.json is invalid JSON: {e}")

    has_episodes = (meta_dir / "episodes.jsonl").is_file() or (
        (meta_dir / "episodes").is_dir() and list((meta_dir / "episodes").rglob("*.parquet"))
    )
    if not has_episodes:
        errors.append("Missing episodes data (meta/episodes.jsonl or meta/episodes/)")

    has_tasks = (meta_dir / "tasks.jsonl").is_file() or (meta_dir / "tasks.parquet").is_file()
    if not has_tasks:
        errors.append("Missing tasks data (meta/tasks.jsonl or meta/tasks.parquet)")

    data_dir = dataset_path / "data"
    if not data_dir.is_dir():
        errors.append("Missing data/ directory")
    else:
        parquet_files = list(data_dir.rglob("*.parquet"))
        if not parquet_files:
            errors.append("No .parquet files found in data/")

    videos_dir = dataset_path / "videos"
    if not videos_dir.is_dir():
        errors.append("Missing videos/ directory (required for video modality)")

    return errors


def generate_tasks_jsonl(dataset_path: Path, task_description: str) -> None:
    """Generate meta/tasks.jsonl with a single task entry."""
    meta_dir = dataset_path / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)

    tasks_file = meta_dir / "tasks.jsonl"
    entry = {"task_index": 0, "task": task_description}
    tasks_file.write_text(json.dumps(entry) + "\n")
    print(f"Generated {tasks_file}")


def print_dataset_summary(dataset_path: Path) -> None:
    """Print dataset statistics."""
    meta_dir = dataset_path / "meta"

    episodes_dir = meta_dir / "episodes"
    episodes_file = meta_dir / "episodes.jsonl"
    if episodes_dir.is_dir():
        num_episodes = len(list(episodes_dir.rglob("*.parquet")))
        print(f"  Episode shards: {num_episodes}")
    elif episodes_file.is_file():
        num_episodes = sum(1 for _ in episodes_file.open())
        print(f"  Episodes: {num_episodes}")

    data_dir = dataset_path / "data"
    if data_dir.is_dir():
        parquet_files = list(data_dir.rglob("*.parquet"))
        print(f"  Data shards: {len(parquet_files)}")

    videos_dir = dataset_path / "videos"
    if videos_dir.is_dir():
        video_files = list(videos_dir.rglob("*.mp4"))
        print(f"  Video files: {len(video_files)}")


def main():
    parser = argparse.ArgumentParser(description="GR00T dataset preparation tool")
    parser.add_argument("--dataset-path", type=str, required=True)
    parser.add_argument("--validate", action="store_true", help="Validate dataset format")
    parser.add_argument(
        "--generate-tasks", type=str, default=None, help="Generate tasks.jsonl with given description"
    )
    args = parser.parse_args()

    dataset_path = Path(args.dataset_path)
    if not dataset_path.is_dir():
        print(f"ERROR: Dataset path does not exist: {dataset_path}")
        sys.exit(1)

    print(f"Dataset: {dataset_path}")

    if args.generate_tasks:
        generate_tasks_jsonl(dataset_path, args.generate_tasks)

    if args.validate:
        print("Validating LeRobot v2 format...")
        errors = validate_dataset(dataset_path)
        if errors:
            print(f"\nFAILED - {len(errors)} error(s):")
            for err in errors:
                print(f"  ✗ {err}")
            sys.exit(1)
        else:
            print("  ✓ All checks passed")
            print_dataset_summary(dataset_path)


if __name__ == "__main__":
    main()
