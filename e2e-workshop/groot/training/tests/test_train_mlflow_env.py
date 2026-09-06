"""Unit tests for train.py:build_mlflow_env — MLflow run 이름/태그를 SageMaker Job 에 연결."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "container"))

import train  # noqa: E402

JOB = "pipelines-hninl9n748f6-GR00TFinetune-aPmtyuDQ9R"
SM_TRAINING_ENV = json.dumps({"job_name": JOB, "current_instance_type": "ml.g6e.12xlarge"})
TRAIN_ENV = {
    "export_s3_uri": "s3://bkt/models/groot-sm/hninl9n748f6",
    "checkpoint_s3_uri": "s3://bkt/checkpoints/hninl9n748f6",
    "groot_version": "n1.6",
    "embodiment_tag": "NEW_EMBODIMENT",
}


def test_no_tracking_uri_means_no_mlflow_env():
    out = train.build_mlflow_env(TRAIN_ENV, environ={"SM_TRAINING_ENV": SM_TRAINING_ENV})
    assert out == {}


def test_run_name_and_tags_link_run_to_training_job():
    environ = {"MLFLOW_TRACKING_URI": "arn:aws:sagemaker:ap-northeast-1:1:mlflow-tracking-server/x",
               "SM_TRAINING_ENV": SM_TRAINING_ENV}
    out = train.build_mlflow_env(TRAIN_ENV, environ=environ)

    # HF MLflowCallback 이 run 이름으로 쓰던 output_dir(/opt/ml/checkpoints) 대신 Job 이름
    assert out["MLFLOW_RUN_NAME"] == JOB
    tags = json.loads(out["MLFLOW_TAGS"])
    assert tags["sagemaker.training_job_name"] == JOB
    assert tags["sagemaker.instance_type"] == "ml.g6e.12xlarge"
    # SageMaker 는 CheckpointConfig 를 컨테이너에 노출하지 않으므로 hyperparameter 로 받은 값
    assert tags["sagemaker.checkpoint_s3_uri"] == "s3://bkt/checkpoints/hninl9n748f6"
    assert tags["sagemaker.export_s3_uri"] == TRAIN_ENV["export_s3_uri"]
    assert tags["gr00t.version"] == "n1.6"
    assert tags["gr00t.embodiment_tag"] == "NEW_EMBODIMENT"


def test_existing_mlflow_tags_and_run_name_are_preserved():
    environ = {"MLFLOW_TRACKING_URI": "arn:x", "SM_TRAINING_ENV": SM_TRAINING_ENV,
               "MLFLOW_RUN_NAME": "my-run", "MLFLOW_TAGS": json.dumps({"team": "robotics"})}
    out = train.build_mlflow_env(dict(TRAIN_ENV, checkpoint_s3_uri=""), environ=environ)
    assert out["MLFLOW_RUN_NAME"] == "my-run"
    tags = json.loads(out["MLFLOW_TAGS"])
    assert tags["team"] == "robotics"
    assert tags["sagemaker.training_job_name"] == JOB
    assert "sagemaker.checkpoint_s3_uri" not in tags  # hyperparameter 미지정 → 생략


def test_job_name_falls_back_to_training_job_name_env():
    environ = {"MLFLOW_TRACKING_URI": "arn:x", "TRAINING_JOB_NAME": "groot-finetune-2026"}
    out = train.build_mlflow_env(TRAIN_ENV, environ=environ)
    assert out["MLFLOW_RUN_NAME"] == "groot-finetune-2026"
    assert json.loads(out["MLFLOW_TAGS"])["sagemaker.training_job_name"] == "groot-finetune-2026"


def test_checkpoint_s3_uri_hyperparameter_is_parsed(monkeypatch):
    for key in list(__import__("os").environ):
        if key.startswith("SM_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SM_HP_CHECKPOINT_S3_URI", "s3://bkt/checkpoints/exec-1")
    assert train.parse_sagemaker_env()["checkpoint_s3_uri"] == "s3://bkt/checkpoints/exec-1"
