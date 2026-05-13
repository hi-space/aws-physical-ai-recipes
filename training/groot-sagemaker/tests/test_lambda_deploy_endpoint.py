"""Unit tests for pipeline/lambda_deploy_endpoint.py.

boto3 SageMaker client를 모킹하여 cleanup → create_model → create_endpoint_config
→ create_endpoint 시퀀스가 의도대로 호출되는지 검증한다.
"""
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
HANDLER_PATH = ROOT / "pipeline" / "lambda_deploy_endpoint.py"


def _load_handler():
    spec = importlib.util.spec_from_file_location("lambda_deploy_endpoint", HANDLER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def event():
    return {
        "endpoint_name": "groot-test-ep",
        "instance_type": "ml.g5.2xlarge",
        "model_data": "s3://my-bucket/output/job/output/model.tar.gz",
        "image_uri": "111.dkr.ecr.us-east-1.amazonaws.com/groot-inf:latest",
        "role_arn": "arn:aws:iam::111:role/SageMakerRole",
        "region": "us-east-1",
    }


def _not_found_error():
    return ClientError(
        {"Error": {"Code": "ValidationException", "Message": "Could not find endpoint"}},
        "DescribeEndpoint",
    )


def test_endpoint_not_found_creates_fresh(event):
    handler = _load_handler()
    sm = MagicMock()
    sm.describe_endpoint.side_effect = _not_found_error()

    with patch.object(handler.boto3, "client", return_value=sm):
        result = handler.handler(event, context=None)

    sm.delete_endpoint.assert_not_called()
    sm.create_model.assert_called_once()
    sm.create_endpoint_config.assert_called_once()
    sm.create_endpoint.assert_called_once()
    assert result["statusCode"] == 200
    assert result["endpoint_name"] == "groot-test-ep"
    assert result["cleanup"]["action"] == "skipped"


def test_endpoint_in_service_is_deleted_then_recreated(event):
    handler = _load_handler()
    sm = MagicMock()
    sm.describe_endpoint.return_value = {
        "EndpointStatus": "InService",
        "EndpointConfigName": "old-config",
    }
    sm.describe_endpoint_config.return_value = {
        "ProductionVariants": [{"ModelName": "old-model"}]
    }
    sm.get_waiter.return_value = MagicMock()

    with patch.object(handler.boto3, "client", return_value=sm):
        result = handler.handler(event, context=None)

    sm.delete_endpoint.assert_called_once_with(EndpointName="groot-test-ep")
    sm.delete_endpoint_config.assert_called_once_with(EndpointConfigName="old-config")
    sm.delete_model.assert_called_once_with(ModelName="old-model")
    sm.create_model.assert_called_once()
    sm.create_endpoint_config.assert_called_once()
    sm.create_endpoint.assert_called_once()
    assert result["cleanup"]["action"] == "deleted"


def test_endpoint_in_transient_state_raises(event):
    handler = _load_handler()
    sm = MagicMock()
    sm.describe_endpoint.return_value = {
        "EndpointStatus": "Creating",
        "EndpointConfigName": "x",
    }

    with patch.object(handler.boto3, "client", return_value=sm):
        with pytest.raises(RuntimeError, match="transient state"):
            handler.handler(event, context=None)

    sm.delete_endpoint.assert_not_called()
    sm.create_endpoint.assert_not_called()


def test_create_calls_use_correct_args(event):
    handler = _load_handler()
    sm = MagicMock()
    sm.describe_endpoint.side_effect = _not_found_error()

    with patch.object(handler.boto3, "client", return_value=sm):
        handler.handler(event, context=None)

    cm_kwargs = sm.create_model.call_args.kwargs
    assert cm_kwargs["PrimaryContainer"]["Image"] == event["image_uri"]
    assert cm_kwargs["PrimaryContainer"]["ModelDataUrl"] == event["model_data"]
    assert cm_kwargs["ExecutionRoleArn"] == event["role_arn"]

    cec_kwargs = sm.create_endpoint_config.call_args.kwargs
    variant = cec_kwargs["ProductionVariants"][0]
    assert variant["InstanceType"] == event["instance_type"]
    assert variant["InitialInstanceCount"] == 1
    assert variant["VariantName"] == "AllTraffic"

    ce_kwargs = sm.create_endpoint.call_args.kwargs
    assert ce_kwargs["EndpointName"] == event["endpoint_name"]
