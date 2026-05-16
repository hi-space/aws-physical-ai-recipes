"""Unit tests for trigger_build.py CLI behavior."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def test_groot_version_n17_passes_overrides():
    """--groot-version n1.7로 학습 빌드 트리거 시 환경변수 override가 들어가야 한다."""
    import trigger_build

    fake_cb = MagicMock()
    fake_cb.start_build.return_value = {"build": {"id": "fake-build-id"}}
    with patch("trigger_build.boto3.client", return_value=fake_cb):
        trigger_build.start_build(
            project_name="groot-sm-training-build",
            region="us-east-1",
            source_s3_bucket="bucket",
            source_s3_key="key.zip",
            buildspec_path="container/training/buildspec.yml",
            environment_overrides=[
                {"name": "GROOT_VERSION", "value": "n1.7", "type": "PLAINTEXT"},
                {"name": "BASE_MODEL_PATH", "value": "nvidia/GR00T-N1.7-3B", "type": "PLAINTEXT"},
            ],
        )
    args, kwargs = fake_cb.start_build.call_args
    assert kwargs["environmentVariablesOverride"] == [
        {"name": "GROOT_VERSION", "value": "n1.7", "type": "PLAINTEXT"},
        {"name": "BASE_MODEL_PATH", "value": "nvidia/GR00T-N1.7-3B", "type": "PLAINTEXT"},
    ]
    assert kwargs["projectName"] == "groot-sm-training-build"


def test_resolve_project_names_no_alias():
    """alias 없을 때 기본 프로젝트 이름을 반환한다."""
    import trigger_build

    names = trigger_build.resolve_project_names({})
    assert names == {
        "training": "groot-sm-training-build",
        "inference": "groot-sm-inference-build",
    }


def test_resolve_project_names_with_alias():
    """config의 codebuild.* 값이 우선, 없으면 aws.alias로 폴백."""
    import trigger_build

    # 1) config에 명시된 이름 사용
    names = trigger_build.resolve_project_names({
        "codebuild": {
            "training_project": "explicit-train",
            "inference_project": "explicit-infer",
        },
    })
    assert names == {"training": "explicit-train", "inference": "explicit-infer"}

    # 2) codebuild.* 미존재, aws.alias만 있을 때 폴백
    names = trigger_build.resolve_project_names({"aws": {"alias": "alice"}})
    assert names == {
        "training": "groot-sm-training-build-alice",
        "inference": "groot-sm-inference-build-alice",
    }


def test_no_overrides_when_groot_version_omitted():
    """env override 없이 호출하면 environmentVariablesOverride 키가 없어야 한다."""
    import trigger_build

    fake_cb = MagicMock()
    fake_cb.start_build.return_value = {"build": {"id": "fake-build-id"}}
    with patch("trigger_build.boto3.client", return_value=fake_cb):
        trigger_build.start_build(
            project_name="groot-sm-inference-build",
            region="us-east-1",
            source_s3_bucket="bucket",
            source_s3_key="key.zip",
        )
    args, kwargs = fake_cb.start_build.call_args
    assert "environmentVariablesOverride" not in kwargs
