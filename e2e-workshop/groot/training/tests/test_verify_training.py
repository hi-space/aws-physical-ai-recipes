"""Unit tests for verify_training.py pure helpers and verify() flow."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def _client_error(code, http):
    return ClientError(
        {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": http}},
        "HeadObject",
    )


def _completed_job():
    return {
        "TrainingJobStatus": "Completed",
        "ModelArtifacts": {"S3ModelArtifacts": "s3://b/output/job-1/output/model.tar.gz"},
        "HyperParameters": {"export_s3_uri": "s3://b/models/groot-sm/job-1"},
        "CheckpointConfig": {"S3Uri": "s3://b/checkpoints/job-1"},
        "ResourceConfig": {"InstanceType": "ml.g6e.12xlarge"},
    }


def _run_verify(job, *, head_ok=True, prefix_has=True, config=None):
    """verify()를 가짜 sagemaker/s3 클라이언트로 구동한다."""
    import verify_training

    sm = MagicMock()
    sm.describe_training_job.return_value = job
    s3 = MagicMock()
    if head_ok:
        s3.head_object.return_value = {}
    else:
        s3.head_object.side_effect = _client_error("404", 404)
    s3.list_objects_v2.return_value = {"Contents": [{"Key": "x"}]} if prefix_has else {}

    def fake_client(service, **kwargs):
        return {"sagemaker": sm, "s3": s3}[service]

    with patch("boto3.client", side_effect=fake_client):
        return verify_training.verify(job["_job_name"] if "_job_name" in job else "job-1", config or {})


def test_split_s3_uri_returns_bucket_and_prefix():
    import verify_training

    assert verify_training.split_s3_uri("s3://my-bucket/models/groot-sm/job-123") == (
        "my-bucket",
        "models/groot-sm/job-123",
    )


def test_split_s3_uri_strips_trailing_slash():
    import verify_training

    assert verify_training.split_s3_uri("s3://my-bucket/models/") == ("my-bucket", "models")


def test_export_uri_from_job_reads_hyperparameter():
    import verify_training

    training = {"HyperParameters": {"export_s3_uri": "s3://b/models/groot-sm/job-1"}}
    assert verify_training.export_uri_from_job(training) == "s3://b/models/groot-sm/job-1"


def test_export_uri_from_job_strips_sagemaker_quotes():
    """SageMaker가 하이퍼파라미터 문자열을 따옴표로 감싸는 경우를 벗긴다."""
    import verify_training

    training = {"HyperParameters": {"export_s3_uri": '"s3://b/models/groot-sm/job-1"'}}
    assert verify_training.export_uri_from_job(training) == "s3://b/models/groot-sm/job-1"


def test_export_uri_from_job_returns_none_when_absent():
    import verify_training

    assert verify_training.export_uri_from_job({"HyperParameters": {}}) is None


def test_checkpoint_uri_from_job_reads_checkpoint_config():
    import verify_training

    training = {"CheckpointConfig": {"S3Uri": "s3://b/checkpoints/job-1"}}
    assert verify_training.checkpoint_uri_from_job(training) == "s3://b/checkpoints/job-1"


def test_checkpoint_uri_from_job_returns_none_when_absent():
    import verify_training

    assert verify_training.checkpoint_uri_from_job({}) is None


# --- verify() 흐름 (mock boto3) -------------------------------------------

def test_verify_happy_path_returns_summary():
    """모든 산출물이 존재하면 요약에 present로 표기한다."""
    summary = _run_verify(_completed_job())
    assert summary["training_status"] == "Completed"
    assert summary["export_s3_uri"] == "s3://b/models/groot-sm/job-1"
    assert summary["export_present"] is True
    assert summary["checkpoint_present"] is True
    assert summary["mlflow"] == "not_configured"  # config에 mlflow 없음


def test_verify_raises_when_not_completed():
    import pytest

    job = _completed_job()
    job["TrainingJobStatus"] = "Failed"
    with pytest.raises(RuntimeError, match="Completed가 아닙"):
        _run_verify(job)


def test_verify_raises_when_model_artifact_missing():
    """model.tar.gz(404)는 하드 실패로 유지한다."""
    import pytest

    with pytest.raises(RuntimeError, match="model.tar.gz"):
        _run_verify(_completed_job(), head_ok=False)


def test_verify_reports_export_absent_without_raising():
    """export/checkpoint가 비어도 실패하지 않고 요약에 absent로 표기한다(best-effort)."""
    summary = _run_verify(_completed_job(), prefix_has=False)
    assert summary["training_status"] == "Completed"
    assert summary["export_present"] is False
    assert summary["checkpoint_present"] is False


def test_object_exists_reraises_on_access_denied():
    """403은 '파일 없음'으로 오판하지 않고 예외를 재발생시킨다."""
    import pytest

    import verify_training

    s3 = MagicMock()
    s3.head_object.side_effect = _client_error("403", 403)
    with pytest.raises(ClientError):
        verify_training._object_exists(s3, "s3://b/k")


def test_object_exists_false_on_404():
    """404는 False."""
    import verify_training

    s3 = MagicMock()
    s3.head_object.side_effect = _client_error("404", 404)
    assert verify_training._object_exists(s3, "s3://b/k") is False
