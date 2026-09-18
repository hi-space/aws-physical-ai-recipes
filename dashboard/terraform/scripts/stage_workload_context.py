#!/usr/bin/env python3
"""Stage the narrow workload Docker build context (mirror of infra/lib/constructs/workload-images.ts).

Used by the `external` data source at plan time. Reads {"repository_root": ..., "output_dir": ...}
on stdin and prints {"context": <dir>, "hash": <sha256 of the staged tree>}. Only workload source is
copied, so a dashboard UI edit never rebuilds the model images. File modes are normalized (0755/0644)
so Docker layer caches are stable across checkouts.
"""
import hashlib
import json
import os
import shutil
import stat
import sys
from pathlib import Path

SOURCES = [
    "dashboard/images", "dashboard/recipes",
    "hyperpod-training/mujoco-workshop", "hyperpod-training/isaac-lab-workshop",
    "hyperpod-training/examples/rl/play_isaaclab.py",
    "hyperpod-training/configs/so101_modality.py",
    "e2e-workshop/groot/training/data/convert_v3_to_v2.py",
]
SKIP_NAMES = {"__pycache__", ".pytest_cache", ".venv", ".git", "node_modules"}


def wanted(path: Path) -> bool:
    return path.name not in SKIP_NAMES and not path.name.endswith(".egg-info") and not path.name.endswith(".pyc")


def copy_tree(source: Path, destination: Path) -> None:
    if source.is_dir():
        destination.mkdir(parents=True, exist_ok=True)
        for child in sorted(source.iterdir()):
            if wanted(child):
                copy_tree(child, destination / child.name)
    elif source.is_file() and wanted(source):
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        mode = source.stat().st_mode
        destination.chmod(0o755 if mode & 0o111 else 0o644)


def tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        digest.update(rel.encode())
        digest.update(b"\0")
        digest.update(b"x" if path.stat().st_mode & 0o111 else b"-")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    query = json.load(sys.stdin)
    repository_root = Path(query["repository_root"]).resolve()
    output = Path(query["output_dir"]).resolve()
    if output.exists():
        shutil.rmtree(output)
    for source in SOURCES:
        target = repository_root / source
        if not target.exists():
            raise SystemExit(f"workload source missing: {target}")
        copy_tree(target, output / source)
    for path in output.rglob("*"):
        if path.is_dir():
            path.chmod(0o755)
    print(json.dumps({"context": str(output), "hash": tree_hash(output)}))


if __name__ == "__main__":
    main()
