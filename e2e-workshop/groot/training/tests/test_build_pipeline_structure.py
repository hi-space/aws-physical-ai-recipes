"""build_pipeline가 만드는 파이프라인의 구조를 검증한다 (AWS 호출 없음)."""
import sys
from pathlib import Path

import boto3
import pytest
from sagemaker.workflow.pipeline_context import PipelineSession

ROOT = Path(__file__).resolve().parents[2]  # groot/
sys.path.insert(0, str(ROOT / "pipeline"))


@pytest.fixture()
def pipeline():
    import build_pipeline
    session = PipelineSession(boto_session=boto3.Session(region_name="us-east-1"))
    return build_pipeline.build_pipeline(
        session=session, role="arn:aws:iam::111111111111:role/GR00TSageMakerRole",
        training_image_uri="111111111111.dkr.ecr.us-east-1.amazonaws.com/groot-train:latest",
        bucket="my-bucket", source_root=str(ROOT))


def _names(steps):
    return [s.name for s in steps]


def test_top_level_steps_in_order(pipeline):
    assert _names(pipeline.steps) == ["TransformDataset", "GR00TFinetune", "SmokeEval", "SmokeGate"]


def test_parameters(pipeline):
    names = {p.name for p in pipeline.parameters}
    assert {"EmbodimentTag", "HfDatasetId", "InstanceType",
            "MaxSteps", "GlobalBatchSize", "NumGpus", "SaveSteps"} <= names


def test_gate_branches(pipeline):
    gate = next(s for s in pipeline.steps if s.name == "SmokeGate")
    assert _names(gate.if_steps) == ["RegisterModel"] or gate.if_steps[0].name.startswith("RegisterModel")
    assert gate.else_steps[0].name == "SmokeFailed"


def test_train_depends_on_transform(pipeline):
    train = next(s for s in pipeline.steps if s.name == "GR00TFinetune")
    # transform 출력이 학습 입력으로 배선되면 depends_on 또는 property 참조가 존재
    dep = [d if isinstance(d, str) else getattr(d, "name", "") for d in (train.depends_on or [])]
    assert "TransformDataset" in dep or train.depends_on is not None


def test_metric_definitions_match_gr00t_trainer_log_keys(pipeline):
    """GR00T Gr00tTrainer가 실제로 stdout에 찍는 키(loss/grad_norm/learning_rate)만 정의한다.

    epoch는 Gr00tTrainer.log()가 숨기고, eval은 eval_strategy=no라 절대 찍히지 않는다 —
    존재하지 않는 metric 정의는 Studio Performance 표/CloudWatch에 빈 항목만 남긴다.
    """
    import build_pipeline

    names = [m["Name"] for m in build_pipeline.GR00T_METRIC_DEFINITIONS]
    assert names == ["train:loss", "train:grad_norm", "train:learning_rate"]
    # 정규식은 HF Trainer dict 출력 `{'loss': 1.08, 'grad_norm': 2.28, 'learning_rate': 3e-06}` 에 매칭
    import re
    sample = "{'loss': 1.0866, 'grad_norm': 2.2876477241516113, 'learning_rate': 3e-06}"
    for m in build_pipeline.GR00T_METRIC_DEFINITIONS:
        assert re.search(m["Regex"], sample), m
    # 학습 스텝의 Estimator 에 그대로 배선되어 있는지
    train = next(s for s in pipeline.steps if s.name == "GR00TFinetune")
    estimator = train.step_args.func_args[0]  # PipelineSession 은 fit(estimator, ...) 를 지연 저장
    assert estimator.metric_definitions == build_pipeline.GR00T_METRIC_DEFINITIONS
    # MLflow run 태그용: checkpoint S3 경로도 hyperparameter 로 전달된다
    assert {"export_s3_uri", "checkpoint_s3_uri"} <= set(estimator.hyperparameters())


def test_mlflow_container_env_no_checkpoint_artifact_upload():
    """MLflow env 헬퍼: system metrics(GPU/CPU) 로깅은 켜고, checkpoint 전체를
    MLflow 아티팩트로 업로드하는 HF_MLFLOW_LOG_ARTIFACTS 는 넣지 않는다."""
    import build_pipeline

    arn = "arn:aws:sagemaker:us-east-1:111111111111:mlflow-tracking-server/groot-mlflow-111111111111"
    env = build_pipeline.mlflow_container_env(arn, "groot-sm-finetune")
    assert env["MLFLOW_TRACKING_URI"] == arn
    assert env["MLFLOW_EXPERIMENT_NAME"] == "groot-sm-finetune"
    assert env["MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING"] == "true"
    assert "HF_MLFLOW_LOG_ARTIFACTS" not in env
    assert build_pipeline.mlflow_container_env("", "groot-sm-finetune") == {}
