"""transform_dataset.stage_dataset 단위 테스트 (네트워크 불필요)."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # groot/
sys.path.insert(0, str(ROOT / "training" / "data"))


def _make_fake_lerobot(root: Path) -> None:
    (root / "meta").mkdir(parents=True)
    (root / "data").mkdir()
    (root / "meta" / "info.json").write_text(json.dumps(
        {"robot_type": "so101", "fps": 20, "features": {}, "total_episodes": 1}))
    (root / "data" / "ep0.parquet").write_bytes(b"parquet-bytes")


def test_stage_dataset_copies_and_manifests(tmp_path):
    import transform_dataset
    src = tmp_path / "src"
    src.mkdir()
    _make_fake_lerobot(src)
    out = tmp_path / "out"
    manifest = transform_dataset.stage_dataset(str(src), str(out))

    # 모든 파일 복사됨
    assert (out / "meta" / "info.json").exists()
    assert (out / "data" / "ep0.parquet").read_bytes() == b"parquet-bytes"
    # 매니페스트 기록됨
    written = json.loads((out / "_processing_manifest.json").read_text())
    assert written == manifest
    assert manifest["format"] == "lerobot"
    assert manifest["num_files"] == 2  # info.json, ep0.parquet (source files only; manifest itself is written to out, not counted)
    # SHA-256 정확
    want = hashlib.sha256(b"parquet-bytes").hexdigest()
    got = next(f["sha256"] for f in manifest["files"] if f["path"].endswith("ep0.parquet"))
    assert got == want
