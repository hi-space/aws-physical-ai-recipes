#!/usr/bin/env python3
"""SageMaker Training Job launcher for GR00T-N1.6 fine-tuning.

Configures and launches a SageMaker Training Job using the SageMaker Python SDK.
Validates instance types and S3 URIs before submission.

Usage:
    python scripts/launch_training.py \
        --base-model-s3-uri s3://bucket/models/groot-n16 \
        --dataset-s3-uri s3://bucket/datasets/lerobot-v2 \
        --output-s3-uri s3://bucket/output/finetuned \
        --embodiment-tag my_robot \
        --container-image-uri 123456789.dkr.ecr.us-east-1.amazonaws.com/groot-training:latest \
        --role-arn arn:aws:iam::123456789:role/SageMakerRole
"""

import argparse
import sys
import os

# Add parent directory to path so we can import from src
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.config import TrainingConfig, validate_instance_type, validate_s3_uri, get_instance_recommendations

try:
    import sagemaker
    from sagemaker.estimator import Estimator
    from sagemaker.inputs import TrainingInput
except ImportError:
    sagemaker = None
    Estimator = None
    TrainingInput = None


def launch_training_job(config: TrainingConfig, container_image_uri: str, role_arn: str) -> str:
    """Launch a SageMaker Training Job for GR00T-N1.6 fine-tuning.

    Args:
        config: TrainingConfig with all training parameters.
        container_image_uri: ECR image URI for the training container.
        role_arn: IAM role ARN for SageMaker execution.

    Returns:
        The SageMaker training job name.

    Raises:
        ValueError: If instance type or S3 URIs are invalid.
        ImportError: If sagemaker SDK is not installed.
        RuntimeError: If the training job fails.
    """
    # Validate instance type meets VRAM requirements (no SDK needed)
    if not validate_instance_type(config.instance_type, "training"):
        recommendations = get_instance_recommendations("training")
        rec_types = [r["type"] for r in recommendations]
        raise ValueError(
            f"Instance type '{config.instance_type}' does not meet the minimum 48GB VRAM "
            f"requirement for training. Recommended instance types: {', '.join(rec_types)}"
        )

    # Validate all S3 URIs (no SDK needed)
    for uri_name, uri_value in [
        ("base_model_s3_uri", config.base_model_s3_uri),
        ("dataset_s3_uri", config.dataset_s3_uri),
        ("output_s3_uri", config.output_s3_uri),
    ]:
        if not validate_s3_uri(uri_value):
            raise ValueError(
                f"Invalid S3 URI for {uri_name}: '{uri_value}'. "
                "Expected format: s3://bucket-name/path"
            )

    # Check sagemaker SDK availability after validation
    if sagemaker is None:
        raise ImportError(
            "sagemaker SDK is required. Install with: pip install sagemaker"
        )

    # Build hyperparameters dict
    hyperparameters = {
        "embodiment_tag": config.embodiment_tag,
        "max_steps": str(config.max_steps),
        "global_batch_size": str(config.global_batch_size),
        "save_steps": str(config.save_steps),
        "num_gpus": str(config.num_gpus),
    }
    if config.wandb_api_key:
        hyperparameters["wandb_api_key"] = config.wandb_api_key

    # Create SageMaker Estimator
    estimator = Estimator(
        image_uri=container_image_uri,
        role=role_arn,
        instance_type=config.instance_type,
        instance_count=config.instance_count,
        output_path=config.output_s3_uri,
        hyperparameters=hyperparameters,
    )

    # Set up S3 input channels
    inputs = {
        "model": TrainingInput(s3_data=config.base_model_s3_uri),
        "dataset": TrainingInput(s3_data=config.dataset_s3_uri),
    }

    # Launch the training job
    try:
        estimator.fit(inputs=inputs)
        job_name = estimator.latest_training_job.name
        print(f"Training job completed: {job_name}")
        return job_name
    except Exception as e:
        # Attempt to surface CloudWatch log link on failure
        job_name = getattr(
            getattr(estimator, "latest_training_job", None), "name", "unknown"
        )
        if job_name != "unknown":
            session = estimator.sagemaker_session
            region = session.boto_region_name
            log_url = (
                f"https://{region}.console.aws.amazon.com/cloudwatch/home"
                f"?region={region}#logsV2:log-groups/log-group/"
                f"%2Faws%2Fsagemaker%2FTrainingJobs/log-events/{job_name}"
            )
            print(f"Training job '{job_name}' failed. Check CloudWatch logs: {log_url}")
        raise


def main() -> None:
    """CLI entrypoint for launching a SageMaker training job."""
    parser = argparse.ArgumentParser(
        description="Launch a SageMaker Training Job for GR00T-N1.6 fine-tuning."
    )
    parser.add_argument(
        "--base-model-s3-uri", required=True,
        help="S3 URI of the base GR00T model artifacts",
    )
    parser.add_argument(
        "--dataset-s3-uri", required=True,
        help="S3 URI of the LeRobot v2 dataset",
    )
    parser.add_argument(
        "--output-s3-uri", required=True,
        help="S3 URI for fine-tuned model output",
    )
    parser.add_argument(
        "--instance-type", default="ml.p4d.24xlarge",
        help="SageMaker instance type (default: ml.p4d.24xlarge)",
    )
    parser.add_argument(
        "--instance-count", type=int, default=1,
        help="Number of training instances (default: 1)",
    )
    parser.add_argument(
        "--embodiment-tag", required=True,
        help="Robot embodiment identifier",
    )
    parser.add_argument(
        "--max-steps", type=int, default=10000,
        help="Maximum training steps (default: 10000)",
    )
    parser.add_argument(
        "--global-batch-size", type=int, default=32,
        help="Global batch size (default: 32)",
    )
    parser.add_argument(
        "--save-steps", type=int, default=2000,
        help="Checkpoint save interval (default: 2000)",
    )
    parser.add_argument(
        "--num-gpus", type=int, default=1,
        help="Number of GPUs per instance (default: 1)",
    )
    parser.add_argument(
        "--wandb-api-key", default=None,
        help="Weights & Biases API key (optional)",
    )
    parser.add_argument(
        "--container-image-uri", required=True,
        help="ECR container image URI for training",
    )
    parser.add_argument(
        "--role-arn", required=True,
        help="SageMaker execution role ARN",
    )

    args = parser.parse_args()

    config = TrainingConfig(
        base_model_s3_uri=args.base_model_s3_uri,
        dataset_s3_uri=args.dataset_s3_uri,
        output_s3_uri=args.output_s3_uri,
        instance_type=args.instance_type,
        instance_count=args.instance_count,
        embodiment_tag=args.embodiment_tag,
        max_steps=args.max_steps,
        global_batch_size=args.global_batch_size,
        save_steps=args.save_steps,
        wandb_api_key=args.wandb_api_key,
        num_gpus=args.num_gpus,
    )

    job_name = launch_training_job(
        config=config,
        container_image_uri=args.container_image_uri,
        role_arn=args.role_arn,
    )
    print(f"Training job name: {job_name}")


if __name__ == "__main__":
    main()
