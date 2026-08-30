#!/usr/bin/env python3
"""TransformDataset ProcessingStep 엔트리포인트.

HF에서 LeRobot 데이터셋을 받아 (필요 시) v3→v2.1 변환하고 검증한 뒤,
/opt/ml/processing/output 으로 stage하고 SHA-256 매니페스트를 남긴다.
검증 실패 시 스텝을 실패시켜(GPU 학습 전) 싼 게이트로 동작한다.

upload_dataset.py / convert_v3_to_v2.py 의 함수를 재사용한다(DRY).
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

MANIFEST_NAME = "_processing_manifest.json"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def stage_dataset(src_dir: str, out_dir: str) -> dict:
    """src_dir의 모든 파일을 out_dir로 복사하고 매니페스트를 반환·기록한다."""
    src = Path(src_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    info_path = src / "meta" / "info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}

    files = []
    for f in sorted(p for p in src.rglob("*") if p.is_file()):
        rel = f.relative_to(src)
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)
        files.append({"path": str(rel), "bytes": f.stat().st_size, "sha256": _sha256(f)})

    manifest = {
        "format": "lerobot",
        "repo_id": os.environ.get("DATASET_REPO_ID", ""),
        "codebase_version": info.get("codebase_version", ""),
        "episodes": info.get("total_episodes"),
        "num_files": len(files),
        "total_bytes": sum(x["bytes"] for x in files),
        "files": files,
    }
    (out / MANIFEST_NAME).write_text(json.dumps(manifest))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hf-dataset-id", required=True)
    parser.add_argument("--output-dir", default="/opt/ml/processing/output")
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()

    # 같은 디렉토리의 기존 로직 재사용
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from upload_dataset import download_hf_dataset, validate_lerobot_dataset, get_hf_token_from_ssm
    from convert_v3_to_v2 import is_v3_dataset, convert_v3_to_v2

    os.environ["DATASET_REPO_ID"] = args.hf_dataset_id
    token = os.environ.get("HF_TOKEN", "") or get_hf_token_from_ssm(args.region)

    tmp = tempfile.mkdtemp(prefix="transform-")
    download_hf_dataset(args.hf_dataset_id, tmp, token)
    if is_v3_dataset(tmp):
        print("v3 감지 → v2.1 변환")
        convert_v3_to_v2(tmp)
    validate_lerobot_dataset(tmp)  # 실패 시 예외 → 스텝 실패(의도된 게이트)
    manifest = stage_dataset(tmp, args.output_dir)
    print("TRANSFORM DONE:", manifest["num_files"], "files,", manifest["total_bytes"], "bytes")


if __name__ == "__main__":
    main()
