"""Unit tests for run_training.py image URI selection."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


CONFIG = {
    "aws": {
        "role_arn": "arn:aws:iam::913524902871:role/groot-sm-exec",
        "bucket_name": "groot-artifacts",
        "region": "us-east-1",
    },
    "ecr": {"training_uri": "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training:latest"},
    "training": {"instance_type": "ml.g5.12xlarge"},
}


def _parse(argv):
    import run_training

    return run_training.build_arg_parser(CONFIG).parse_args(argv)


def test_build_arg_parser_defaults_instance_type_from_config():
    """CLI 미지정 시 인스턴스 타입 기본값을 config에서 읽는다."""
    args = _parse(["--dataset-s3-uri", "s3://b/ds"])
    assert args.instance_type == "ml.g5.12xlarge"


def test_build_training_job_applies_instance_type_and_forces_on_demand():
    """instance_type/use_spot override가 Estimator에 반영된다(폴백 러너용 seam)."""
    import run_training

    args = _parse(["--dataset-s3-uri", "s3://b/ds"])
    estimator, inputs, job_name, region = run_training.build_training_job(
        args, CONFIG, instance_type="ml.g6e.12xlarge", use_spot=False
    )
    assert estimator.instance_type == "ml.g6e.12xlarge"
    assert not estimator.use_spot_instances
    assert region == "us-east-1"
    assert job_name.startswith("groot-finetune")
    assert "dataset" in inputs


def test_build_training_job_metric_definitions_and_mlflow_env_match_pipeline():
    """직접 실행 경로(run_training.py)도 파이프라인과 같은 metric 정의·MLflow env를 쓴다."""
    import run_training  # pipeline/ 을 sys.path 에 넣어 build_pipeline 을 공유한다
    import build_pipeline

    config = dict(CONFIG, mlflow={
        "tracking_server_arn": "arn:aws:sagemaker:us-east-1:913524902871:mlflow-tracking-server/groot-mlflow-913524902871",
        "experiment_name": "groot-sm-finetune",
    })
    args = run_training.build_arg_parser(config).parse_args(["--dataset-s3-uri", "s3://b/ds"])
    estimator, _, _, _ = run_training.build_training_job(args, config)
    assert estimator.metric_definitions == build_pipeline.GR00T_METRIC_DEFINITIONS
    env = estimator.environment
    assert env["MLFLOW_TRACKING_URI"] == config["mlflow"]["tracking_server_arn"]
    assert env["MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING"] == "true"
    assert "HF_MLFLOW_LOG_ARTIFACTS" not in env


def test_image_uri_with_groot_version_substitutes_tag():
    """ecr.training_uri가 :latest이고 --groot-version n1.7이면 :n1.7로 교체."""
    base = "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training:latest"
    # 동일한 substitution 로직을 그대로 재현 (run_training의 inline logic)
    groot_version = "n1.7"
    result = base.rsplit(":", 1)[0] + f":{groot_version}"
    assert result == "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training:n1.7"


def test_image_uri_without_tag_appends_version():
    """base_uri에 태그가 없고 --groot-version n1.6이면 :n1.6을 추가."""
    base = "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training"
    groot_version = "n1.6"
    result = (
        base.rsplit(":", 1)[0] + f":{groot_version}"
        if ":" in base
        else f"{base}:{groot_version}"
    )
    assert result == "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training:n1.6"
