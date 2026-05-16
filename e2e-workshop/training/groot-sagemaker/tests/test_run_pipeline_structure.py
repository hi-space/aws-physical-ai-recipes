"""build_pipeline()이 만드는 파이프라인 그래프 구조를 검증한다.

실제 AWS 호출은 하지 않고 객체 구조(steps, parameters, depends_on)만 확인.
"""
import argparse
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def pipeline():
    spec = importlib.util.spec_from_file_location("rp", ROOT / "pipeline" / "run_pipeline.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    cfg = {
        "aws": {
            "bucket_name": "test-bucket",
            "region": "us-east-1",
            "role_arn": "arn:aws:iam::111:role/Test",
            "alias": "test",
        },
        "ecr": {
            "training_uri": "111.dkr.ecr.us-east-1.amazonaws.com/train:latest",
            "inference_uri": "111.dkr.ecr.us-east-1.amazonaws.com/inf:latest",
        },
        "inference": {
            "endpoint_name": "test-endpoint",
            "instance_type": "ml.g5.2xlarge",
            "model_package_group": "test-group",
        },
        "lambda": {
            "deploy_endpoint_arn": "arn:aws:lambda:us-east-1:111:function:test-deploy",
        },
        "training": {"use_spot": False},
    }
    ns = argparse.Namespace(
        embodiment_tag="NEW_EMBODIMENT",
        dataset_s3_uri="s3://test/data",
        bucket="test-bucket",
        region="us-east-1",
        role_arn="arn:aws:iam::111:role/Test",
        training_image_uri=cfg["ecr"]["training_uri"],
        inference_image_uri=cfg["ecr"]["inference_uri"],
        instance_type=None,
        max_steps=None,
        global_batch_size=None,
        num_gpus=None,
        hf_dataset_id="",
        hf_token="",
        groot_version=None,
        use_spot=False,
        upsert_only=True,
        start_only=False,
        endpoint_name="test-endpoint",
        endpoint_instance_type="ml.g5.2xlarge",
        deploy_lambda_arn="arn:aws:lambda:us-east-1:111:function:test-deploy",
    )
    return mod.build_pipeline(cfg, ns)


def test_pipeline_has_three_steps(pipeline):
    names = [s.name for s in pipeline.steps]
    assert names == ["GR00TFinetune", "RegisterModel", "DeployEndpoint"]


def test_pipeline_parameters_include_endpoint_overrides(pipeline):
    names = {p.name for p in pipeline.parameters}
    assert "EndpointName" in names
    assert "EndpointInstanceType" in names


def test_register_model_uses_approved_status(pipeline):
    """RegisterModel step이 Approved 상태로 등록되도록 변경되었는지 확인."""
    register_step = next(s for s in pipeline.steps if s.name == "RegisterModel")
    # ModelStep의 step_args 안에 RegisterModel 호출 인자가 들어있음
    request_args = register_step.step_args
    # step_args 객체는 Approval 정보를 포함 — string repr에 'Approved' 검사
    assert "Approved" in str(request_args.create_model_package_request.get(
        "ModelApprovalStatus", str(request_args)
    )) or any(
        "Approved" in str(v) for v in getattr(request_args, "create_model_package_request", {}).values()
    )


def test_deploy_step_depends_on_training(pipeline):
    deploy_step = next(s for s in pipeline.steps if s.name == "DeployEndpoint")
    depends = [
        d.name if hasattr(d, "name") else d
        for d in deploy_step.depends_on or []
    ]
    assert "GR00TFinetune" in depends
