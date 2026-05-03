"""Download GR00T-compatible LeRobot v2 dataset from HuggingFace.

Usage:
  python download_dataset.py --repo-id lerobot/aloha_sim_transfer_cube_human --output /fsx/datasets/groot/aloha
  python download_dataset.py --name aloha
"""
import argparse
from huggingface_hub import snapshot_download

RECOMMENDED_DATASETS = {
    "aloha": "lerobot/aloha_sim_transfer_cube_human",
    "pusht": "lerobot/pusht_sim",
    "xarm": "lerobot/xarm_lift_medium_human",
}


def main():
    parser = argparse.ArgumentParser(description="Download LeRobot v2 dataset")
    parser.add_argument("--repo-id", type=str, default=None, help="HuggingFace dataset repo ID")
    parser.add_argument(
        "--name",
        type=str,
        default="aloha",
        choices=RECOMMENDED_DATASETS.keys(),
        help="Preset dataset name",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory (default: /fsx/datasets/groot/<name>)",
    )
    args = parser.parse_args()

    repo_id = args.repo_id or RECOMMENDED_DATASETS.get(args.name)
    output_dir = args.output or f"/fsx/datasets/groot/{args.name}"

    print(f"Downloading {repo_id} → {output_dir}")
    snapshot_download(repo_id=repo_id, repo_type="dataset", local_dir=output_dir)
    print(f"✓ Dataset downloaded to {output_dir}")


if __name__ == "__main__":
    main()
