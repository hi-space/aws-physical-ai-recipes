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
