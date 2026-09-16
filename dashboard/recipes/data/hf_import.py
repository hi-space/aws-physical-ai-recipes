"""Download a revisioned LeRobot dataset, convert in place, and validate every episode."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

from convert_v3_to_v2 import convert_v3_to_v2, is_v3_dataset


def validate(root):
    import pyarrow.parquet as pq

    info = json.loads((root / "meta/info.json").read_text())
    if info["codebase_version"] != "v2.1":
        raise ValueError("Expected LeRobot v2.1 after conversion")
    episodes = [json.loads(line) for line in (root / "meta/episodes.jsonl").read_text().splitlines() if line]
    if not episodes or len(episodes) != info["total_episodes"]:
        raise ValueError("Episode count does not match metadata")
    if not (root / "meta/tasks.jsonl").is_file():
        raise ValueError("Missing task descriptions")
    video_keys = [k for k, v in info["features"].items() if v["dtype"] == "video"]
    for episode in episodes:
        index = episode["episode_index"]
        chunk = index // info.get("chunks_size", 1000)
        parquet = root / info["data_path"].format(episode_chunk=chunk, episode_index=index)
        if pq.read_metadata(parquet).num_rows != episode["length"]:
            raise ValueError(f"Incomplete episode {index}")
        for key in video_keys:
            video = root / info["video_path"].format(episode_chunk=chunk, episode_index=index, video_key=key)
            if not video.is_file() or video.stat().st_size == 0:
                raise ValueError(f"Missing video for episode {index}: {key}")
    return info, episodes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--repo-id")
    source.add_argument("--source-dir", help="local fixture or staged dataset; original stays immutable")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    root = output / "dataset"
    if root.exists():
        raise FileExistsError(root)
    revision = args.revision
    if args.source_dir:
        shutil.copytree(args.source_dir, root)
    else:
        from huggingface_hub import HfApi, snapshot_download
        revision = HfApi().dataset_info(args.repo_id, revision=args.revision).sha
        snapshot_download(repo_id=args.repo_id, repo_type="dataset", revision=revision, local_dir=root)
    if is_v3_dataset(str(root)):
        # The workshop converter accepts ONE argument and changes this copy in place.
        # It can warn and skip absent files, so post-conversion validation is mandatory.
        convert_v3_to_v2(str(root))
    info, episodes = validate(root)
    manifest = {"schemaVersion": 1, "format": info["codebase_version"], "episodeCount": len(episodes),
                "source": args.repo_id or str(Path(args.source_dir).resolve()), "revision": revision,
                "infoSha256": hashlib.sha256((root / "meta/info.json").read_bytes()).hexdigest()}
    (output / "dataset-manifest.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
