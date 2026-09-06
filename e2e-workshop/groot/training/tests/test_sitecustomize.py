"""sitecustomize.py — transformers TrainingArguments 후처리(report_to에 mlflow 추가,
MLFLOW_RUN_NAME 을 run_name 으로) 검증. transformers 가 없는 환경에서는 skip."""
import importlib.util
import sys
from pathlib import Path

import pytest

transformers = pytest.importorskip("transformers")

CONTAINER = Path(__file__).resolve().parents[1] / "container"


def _load_sitecustomize(monkeypatch, env: dict):
    """stdlib 훅 이름(sitecustomize)과 충돌하지 않게 별도 모듈명으로 로드한다."""
    for k in ("MLFLOW_TRACKING_URI", "MLFLOW_RUN_NAME"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location("groot_sitecustomize", CONTAINER / "sitecustomize.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def restore_post_init():
    from transformers import TrainingArguments

    original = TrainingArguments.__post_init__
    yield
    TrainingArguments.__post_init__ = original


def test_mlflow_added_and_run_name_taken_from_env(tmp_path, monkeypatch, restore_post_init):
    _load_sitecustomize(monkeypatch, {
        "MLFLOW_TRACKING_URI": "arn:aws:sagemaker:ap-northeast-1:1:mlflow-tracking-server/x",
        "MLFLOW_RUN_NAME": "pipelines-abc-GR00TFinetune-xyz",
    })
    from transformers import TrainingArguments

    args = TrainingArguments(output_dir=str(tmp_path), report_to="none")
    assert "mlflow" in args.report_to
    # HF 기본값(run_name=output_dir) 대신 SageMaker Job 이름
    assert args.run_name == "pipelines-abc-GR00TFinetune-xyz"


def test_explicit_run_name_is_kept(tmp_path, monkeypatch, restore_post_init):
    _load_sitecustomize(monkeypatch, {"MLFLOW_TRACKING_URI": "arn:x", "MLFLOW_RUN_NAME": "from-env"})
    from transformers import TrainingArguments

    args = TrainingArguments(output_dir=str(tmp_path), report_to="none", run_name="explicit")
    assert args.run_name == "explicit"


def test_without_tracking_uri_nothing_is_patched(tmp_path, monkeypatch, restore_post_init):
    _load_sitecustomize(monkeypatch, {"MLFLOW_RUN_NAME": "ignored"})
    from transformers import TrainingArguments

    args = TrainingArguments(output_dir=str(tmp_path), report_to="none")
    assert args.report_to == []
    # HF 기본값 그대로: 4.51(컨테이너)은 output_dir, 4.57+ 는 None
    assert args.run_name in (None, str(tmp_path))
