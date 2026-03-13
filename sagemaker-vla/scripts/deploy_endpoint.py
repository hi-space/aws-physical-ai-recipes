#!/usr/bin/env python3
"""SageMaker Endpoint deployment and management for GR00T-N1.6 inference.

Creates and deletes SageMaker Endpoints for serving fine-tuned GR00T models.

Usage:
    # Deploy an endpoint
    python scripts/deploy_endpoint.py --action deploy \
        --model-s3-uri s3://bucket/output/finetuned/model.tar.gz \
        --instance-type ml.g5.2xlarge \
        --endpoint-name groot-inference \
        --container-image-uri 123456789.dkr.ecr.us-east-1.amazonaws.com/groot-inference:latest \
        --role-arn arn:aws:iam::123456789:role/SageMakerRole

    # Delete an endpoint
    python scripts/deploy_endpoint.py --action delete \
        --endpoint-name groot-inference \
        --region us-east-1
"""

import argparse
import sys
import os
from datetime import datetime

# Add parent directory to path so we can import from src
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.config import DeploymentConfig

try:
    import boto3
except ImportError:
    boto3 = None


def deploy_endpoint(config: DeploymentConfig, role_arn: str) -> dict:
    """Create a SageMaker Model, EndpointConfig, and Endpoint.

    Args:
        config: DeploymentConfig with deployment parameters.
        role_arn: IAM role ARN for SageMaker execution.

    Returns:
        Dict with endpoint_name and endpoint_url.

    Raises:
        ImportError: If boto3 is not installed.
        RuntimeError: If endpoint creation fails.
    """
    if boto3 is None:
        raise ImportError("boto3 is required. Install with: pip install boto3")

    sm_client = boto3.client("sagemaker")
    region = sm_client.meta.region_name
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")

    model_name = f"{config.endpoint_name}-model-{timestamp}"
    endpoint_config_name = f"{config.endpoint_name}-config-{timestamp}"

    # Create SageMaker Model
    try:
        sm_client.create_model(
            ModelName=model_name,
            PrimaryContainer={
                "Image": config.container_image_uri,
                "ModelDataUrl": config.model_s3_uri,
            },
            ExecutionRoleArn=role_arn,
        )
        print(f"Created model: {model_name}")
    except Exception as e:
        raise RuntimeError(f"Failed to create model '{model_name}': {e}")

    # Create EndpointConfig
    try:
        sm_client.create_endpoint_config(
            EndpointConfigName=endpoint_config_name,
            ProductionVariants=[
                {
                    "VariantName": "primary",
                    "ModelName": model_name,
                    "InstanceType": config.instance_type,
                    "InitialInstanceCount": 1,
                },
            ],
        )
        print(f"Created endpoint config: {endpoint_config_name}")
    except Exception as e:
        raise RuntimeError(
            f"Failed to create endpoint config '{endpoint_config_name}': {e}"
        )

    # Create Endpoint
    try:
        sm_client.create_endpoint(
            EndpointName=config.endpoint_name,
            EndpointConfigName=endpoint_config_name,
        )
        print(f"Creating endpoint: {config.endpoint_name} (this may take several minutes)")
    except Exception as e:
        raise RuntimeError(
            f"Failed to create endpoint '{config.endpoint_name}': {e}. "
            "Check instance availability and service quotas."
        )

    endpoint_url = (
        f"https://runtime.sagemaker.{region}.amazonaws.com"
        f"/endpoints/{config.endpoint_name}/invocations"
    )

    print(f"Endpoint name: {config.endpoint_name}")
    print(f"Endpoint URL: {endpoint_url}")

    return {"endpoint_name": config.endpoint_name, "endpoint_url": endpoint_url}


def delete_endpoint(endpoint_name: str, region: str = "us-east-1") -> None:
    """Delete a SageMaker endpoint, its config, and associated model.

    Args:
        endpoint_name: Name of the endpoint to delete.
        region: AWS region where the endpoint is deployed.

    Raises:
        ImportError: If boto3 is not installed.
    """
    if boto3 is None:
        raise ImportError("boto3 is required. Install with: pip install boto3")

    sm_client = boto3.client("sagemaker", region_name=region)

    # Get endpoint config name from the endpoint
    try:
        endpoint_desc = sm_client.describe_endpoint(EndpointName=endpoint_name)
        endpoint_config_name = endpoint_desc["EndpointConfigName"]
    except Exception as e:
        print(f"Warning: Could not describe endpoint '{endpoint_name}': {e}")
        endpoint_config_name = None

    # Get model name from the endpoint config
    model_name = None
    if endpoint_config_name:
        try:
            config_desc = sm_client.describe_endpoint_config(
                EndpointConfigName=endpoint_config_name
            )
            variants = config_desc.get("ProductionVariants", [])
            if variants:
                model_name = variants[0].get("ModelName")
        except Exception as e:
            print(f"Warning: Could not describe endpoint config '{endpoint_config_name}': {e}")

    # Delete endpoint
    try:
        sm_client.delete_endpoint(EndpointName=endpoint_name)
        print(f"Deleted endpoint: {endpoint_name}")
    except Exception as e:
        print(f"Warning: Could not delete endpoint '{endpoint_name}': {e}")

    # Delete endpoint config
    if endpoint_config_name:
        try:
            sm_client.delete_endpoint_config(EndpointConfigName=endpoint_config_name)
            print(f"Deleted endpoint config: {endpoint_config_name}")
        except Exception as e:
            print(f"Warning: Could not delete endpoint config '{endpoint_config_name}': {e}")

    # Delete model
    if model_name:
        try:
            sm_client.delete_model(ModelName=model_name)
            print(f"Deleted model: {model_name}")
        except Exception as e:
            print(f"Warning: Could not delete model '{model_name}': {e}")

    print(f"Endpoint '{endpoint_name}' cleanup complete.")


def main() -> None:
    """CLI entrypoint for deploying or deleting a SageMaker endpoint."""
    parser = argparse.ArgumentParser(
        description="Deploy or delete a SageMaker Endpoint for GR00T-N1.6 inference."
    )
    parser.add_argument(
        "--action", required=True, choices=["deploy", "delete"],
        help="Action to perform: deploy or delete",
    )
    parser.add_argument(
        "--model-s3-uri", default=None,
        help="S3 URI of the fine-tuned model artifacts (required for deploy)",
    )
    parser.add_argument(
        "--instance-type", default="ml.g5.2xlarge",
        help="SageMaker instance type (default: ml.g5.2xlarge)",
    )
    parser.add_argument(
        "--endpoint-name", required=True,
        help="Name for the SageMaker endpoint",
    )
    parser.add_argument(
        "--container-image-uri", default=None,
        help="ECR container image URI for inference (required for deploy)",
    )
    parser.add_argument(
        "--role-arn", default=None,
        help="SageMaker execution role ARN (required for deploy)",
    )
    parser.add_argument(
        "--region", default="us-east-1",
        help="AWS region (default: us-east-1, used for delete)",
    )

    args = parser.parse_args()

    if args.action == "deploy":
        # Validate required deploy args
        missing = []
        if not args.model_s3_uri:
            missing.append("--model-s3-uri")
        if not args.container_image_uri:
            missing.append("--container-image-uri")
        if not args.role_arn:
            missing.append("--role-arn")
        if missing:
            parser.error(f"deploy action requires: {', '.join(missing)}")

        config = DeploymentConfig(
            model_s3_uri=args.model_s3_uri,
            instance_type=args.instance_type,
            endpoint_name=args.endpoint_name,
            container_image_uri=args.container_image_uri,
        )
        result = deploy_endpoint(config=config, role_arn=args.role_arn)
        print(f"\nDeployment result: {result}")

    elif args.action == "delete":
        delete_endpoint(endpoint_name=args.endpoint_name, region=args.region)


if __name__ == "__main__":
    main()
