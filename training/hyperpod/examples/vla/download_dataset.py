"""Download GR00T-compatible dataset.

Supports:
1. Built-in demo datasets from the Isaac-GR00T repository
2. LeRobot v2 datasets from HuggingFace

Usage:
  python download_dataset.py --name droid_sample
  python download_dataset.py --repo-id lerobot/aloha_sim_transfer_cube_human --output /fsx/datasets/groot/aloha
"""

import argparse
import shutil
from pathlib import Path

BUILTIN_DATASETS = {
    "droid_sample": "demo_data/droid_sample",
    "cube_to_bowl_5": "demo_data/cube_to_bowl_5",
    "libero_demo": "demo_data/libero_demo",
}

HF_DATASETS = {
    "aloha": "lerobot/aloha_sim_transfer_cube_human",
    "pusht": "lerobot/pusht_sim",
    "xarm": "lerobot/xarm_lift_medium_human",
}

RECOMMENDED_DATASETS = {**BUILTIN_DATASETS, **HF_DATASETS}


def main():
    parser = argparse.ArgumentParser(description="Download/prepare GR00T dataset")
    parser.add_argument("--repo-id", type=str, default=None, help="HuggingFace dataset repo ID")
    parser.add_argument(
        "--name",
        type=str,
        default="droid_sample",
        choices=RECOMMENDED_DATASETS.keys(),
        help="Preset dataset name",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory (default: /fsx/datasets/groot/<name>)",
    )
    parser.add_argument(
        "--groot-repo",
        type=str,
        default="/fsx/scratch/Isaac-GR00T",
        help="Path to Isaac-GR00T repository (for built-in datasets)",
    )
    args = parser.parse_args()

    output_dir = args.output or f"/fsx/datasets/groot/{args.name}"
    output_path = Path(output_dir)

    if output_path.exists():
        print(f"Dataset already exists at {output_dir}")
        return

    if args.repo_id:
        from huggingface_hub import snapshot_download
        print(f"Downloading {args.repo_id} from HuggingFace...")
        snapshot_download(repo_id=args.repo_id, repo_type="dataset", local_dir=output_dir)
    elif args.name in BUILTIN_DATASETS:
        src = Path(args.groot_repo) / BUILTIN_DATASETS[args.name]
        if not src.exists():
            print(f"ERROR: Built-in dataset not found at {src}")
            print(f"  Ensure Isaac-GR00T is cloned at {args.groot_repo}")
            raise SystemExit(1)
        print(f"Copying built-in dataset {args.name}...")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, output_path)
    elif args.name in HF_DATASETS:
        from huggingface_hub import snapshot_download
        repo_id = HF_DATASETS[args.name]
        print(f"Downloading {repo_id} from HuggingFace...")
        snapshot_download(repo_id=repo_id, repo_type="dataset", local_dir=output_dir)
    else:
        print(f"ERROR: Unknown dataset '{args.name}'")
        raise SystemExit(1)

    print(f"Dataset ready at {output_dir}")


if __name__ == "__main__":
    main()
