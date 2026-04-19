"""Download SO-101 dataset from HuggingFace, convert to LeRobot v2.1, apply modality config."""
import argparse
import shutil
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download HF SO-101 dataset")
    parser.add_argument("--repo_id", required=True, help="HuggingFace dataset repo (e.g. izuluaga/finish_sandwich)")
    parser.add_argument("--output_dir", required=True, help="Output directory for converted dataset")
    parser.add_argument("--groot_dir", default="~/environment/Isaac-GR00T", help="Isaac-GR00T repo path")
    return parser.parse_args()


def main():
    args = parse_args()
    groot_dir = Path(args.groot_dir).expanduser()
    output_dir = Path(args.output_dir)

    if not groot_dir.exists():
        raise FileNotFoundError(f"Isaac-GR00T not found at {groot_dir}. Run setup.sh first.")

    print(f"Downloading and converting {args.repo_id}...")
    subprocess.run(
        [
            "uv", "run", "--project", str(groot_dir / "scripts" / "lerobot_conversion"),
            "python", str(groot_dir / "scripts" / "lerobot_conversion" / "convert_v3_to_v2.py"),
            "--repo-id", args.repo_id,
            "--root", str(output_dir),
        ],
        check=True,
    )

    dataset_path = output_dir / args.repo_id.replace("/", "/")
    if not dataset_path.exists():
        candidates = list(output_dir.rglob("meta/info.json"))
        if candidates:
            dataset_path = candidates[0].parent.parent
        else:
            raise FileNotFoundError(f"Converted dataset not found under {output_dir}")

    modality_src = Path(__file__).resolve().parents[3] / "configs" / "modality.json"
    modality_dst = dataset_path / "meta" / "modality.json"
    shutil.copy2(modality_src, modality_dst)
    print(f"Copied modality.json → {modality_dst}")

    print(f"\nDataset ready at: {dataset_path}")
    print(f"Episodes: {sum(1 for _ in (dataset_path / 'data').rglob('*.parquet'))}")
    print("\nNext: upload_s3 --local_path <path> --bucket <name> --s3_prefix datasets/so101")


if __name__ == "__main__":
    main()
