"""노트북 07이 build_pipeline을 쓰고, 수동 upload_dataset 실행 셀을 더 이상 갖지 않음을 확인."""
import json
from pathlib import Path

NB = Path(__file__).resolve().parents[2] / "notebooks" / "07_sagemaker_pipeline.ipynb"


def _sources():
    nb = json.loads(NB.read_text())
    return "\n".join("".join(c.get("source", [])) for c in nb["cells"])


def test_uses_build_pipeline():
    assert "build_pipeline" in _sources()


def test_no_manual_upload_cell():
    assert "upload_dataset.py" not in _sources()


def test_creates_model_package_group():
    assert "create_model_package_group" in _sources()
