"""노트북 02가 build_pipeline을 쓰고, 수동 upload_dataset 실행 셀을 더 이상 갖지 않음을 확인."""
import json
from pathlib import Path

NB = Path(__file__).resolve().parents[2] / "notebooks" / "02_sagemaker_pipeline.ipynb"


def _sources():
    nb = json.loads(NB.read_text())
    return "\n".join("".join(c.get("source", [])) for c in nb["cells"])


def test_uses_build_pipeline():
    assert "build_pipeline" in _sources()


def test_no_manual_upload_cell():
    assert "upload_dataset.py" not in _sources()


def test_creates_model_package_group():
    assert "create_model_package_group" in _sources()


def test_mlflow_env_comes_from_shared_helper():
    """MLflow env는 build_pipeline.mlflow_container_env 한 곳에서 만든다 (run_training.py와 동일).
    checkpoint 전체를 MLflow 아티팩트로 올리던 HF_MLFLOW_LOG_ARTIFACTS 는 더 이상 켜지 않는다."""
    src = _sources()
    assert "mlflow_container_env(" in src
    assert "HF_MLFLOW_LOG_ARTIFACTS" not in src
