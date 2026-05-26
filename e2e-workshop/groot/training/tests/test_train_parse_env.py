"""Unit tests for train.py:parse_sagemaker_env."""
import os
import sys
from pathlib import Path

import pytest

# Add training/container to sys.path so we can import train.py without sagemaker-training installed
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "container"))

import train  # noqa: E402


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """각 테스트 전후로 SM_*, GROOT_VERSION, BASE_MODEL_PATH 환경변수 초기화."""
    for key in list(os.environ.keys()):
        if key.startswith("SM_") or key in ("GROOT_VERSION", "BASE_MODEL_PATH"):
            monkeypatch.delenv(key, raising=False)
    yield


def test_default_base_model_is_n16(monkeypatch):
    monkeypatch.setenv("SM_CHANNEL_DATASET", "/opt/ml/input/data/dataset")
    env = train.parse_sagemaker_env()
    assert env["groot_version"] == "n1.6"
    assert env["model_dir"] == "nvidia/GR00T-N1.6-3B"


def test_groot_version_n17_maps_to_n17_model(monkeypatch):
    monkeypatch.setenv("GROOT_VERSION", "n1.7")
    env = train.parse_sagemaker_env()
    assert env["groot_version"] == "n1.7"
    assert env["model_dir"] == "nvidia/GR00T-N1.7-3B"


def test_explicit_base_model_path_env_wins_over_groot_version(monkeypatch):
    monkeypatch.setenv("GROOT_VERSION", "n1.6")
    monkeypatch.setenv("BASE_MODEL_PATH", "nvidia/GR00T-N1.7-3B")
    env = train.parse_sagemaker_env()
    assert env["model_dir"] == "nvidia/GR00T-N1.7-3B"


def test_sm_channel_model_overrides_env(monkeypatch):
    monkeypatch.setenv("BASE_MODEL_PATH", "nvidia/GR00T-N1.6-3B")
    monkeypatch.setenv("SM_CHANNEL_MODEL", "/opt/ml/input/data/model")
    env = train.parse_sagemaker_env()
    assert env["model_dir"] == "/opt/ml/input/data/model"


def test_hyperparameter_base_model_path_wins_over_all(monkeypatch):
    monkeypatch.setenv("SM_HP_BASE_MODEL_PATH", "my-org/custom-3B")
    monkeypatch.setenv("SM_CHANNEL_MODEL", "/opt/ml/input/data/model")
    monkeypatch.setenv("BASE_MODEL_PATH", "nvidia/GR00T-N1.6-3B")
    env = train.parse_sagemaker_env()
    assert env["model_dir"] == "my-org/custom-3B"


def test_robot_agnostic_defaults(monkeypatch):
    """train.py는 SO-101 같은 robot-specific 디폴트를 가지지 않아야 한다."""
    env = train.parse_sagemaker_env()
    # embodiment_tag 디폴트는 NEW_EMBODIMENT (커스텀 robot용 일반값)
    assert env["embodiment_tag"] == "NEW_EMBODIMENT"
    # video_key/state_key 디폴트는 GR00T 내장 single-arm 일반값 (single_arm + gripper 같은 SO-101 특화 X)
    assert env["video_key"] == "video.webcam"
    assert env["state_key"] == "state.single_arm"
