"""Download SO-101 dataset from HuggingFace, convert to LeRobot v2.1, apply modality config."""
import argparse
import json
import shutil
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download HF SO-101 dataset")
    parser.add_argument("--repo_id", required=True, help="HuggingFace dataset repo (e.g. izuluaga/finish_sandwich)")
    parser.add_argument("--output_dir", required=True, help="Output directory for converted dataset")
    parser.add_argument("--groot_dir", default="~/environment/Isaac-GR00T", help="Isaac-GR00T repo path")
    parser.add_argument("--force", action="store_true", help="Re-download and convert even if dataset exists")
    return parser.parse_args()


def _find_dataset_path(output_dir: Path, repo_id: str) -> Path | None:
    direct = output_dir / repo_id
    if direct.exists():
        return direct
    candidates = list(output_dir.rglob("meta/info.json"))
    if candidates:
        return candidates[0].parent.parent
    return None


def _is_v21(dataset_path: Path) -> bool:
    info_file = dataset_path / "meta" / "info.json"
    if not info_file.exists():
        return False
    info = json.loads(info_file.read_text())
    return info.get("codebase_version", "") == "v2.1"


def main():
    args = parse_args()
    groot_dir = Path(args.groot_dir).expanduser()
    output_dir = Path(args.output_dir)

    if not groot_dir.exists():
        raise FileNotFoundError(f"Isaac-GR00T not found at {groot_dir}. Run setup.sh first.")

    dataset_path = _find_dataset_path(output_dir, args.repo_id)

    if dataset_path and _is_v21(dataset_path) and not args.force:
        print(f"Dataset already converted (v2.1) at {dataset_path}, skipping download.")
    else:
        print(f"Downloading and converting {args.repo_id}...")
        cmd = [
            "uv", "run", "--project", str(groot_dir / "scripts" / "lerobot_conversion"),
            "python", str(groot_dir / "scripts" / "lerobot_conversion" / "convert_v3_to_v2.py"),
            "--repo-id", args.repo_id,
            "--root", str(output_dir),
        ]
        if args.force:
            cmd.append("--force-conversion")
        subprocess.run(cmd, check=True)

        dataset_path = _find_dataset_path(output_dir, args.repo_id)
        if not dataset_path:
            raise FileNotFoundError(f"Converted dataset not found under {output_dir}")

    modality_src = Path(__file__).resolve().parents[3] / "configs" / "modality.json"
    modality_dst = dataset_path / "meta" / "modality.json"
    shutil.copy2(modality_src, modality_dst)
    print(f"Copied modality.json → {modality_dst}")

    print(f"\nDataset ready at: {dataset_path}")
    data_dir = dataset_path / "data"
    if data_dir.exists():
        print(f"Episodes: {sum(1 for _ in data_dir.rglob('*.parquet'))}")
    print("\nNext: upload_s3 --local_path <path> --bucket <name> --s3_prefix datasets/so101")


if __name__ == "__main__":
    main()
