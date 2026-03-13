"""Configuration and instance recommendations for GR00T-N1.6 SageMaker fine-tuning and deployment."""

import re
from dataclasses import dataclass, field
from typing import Optional


# Instance recommendations for training and inference
INSTANCE_RECOMMENDATIONS: dict = {
    "training": {
        "recommended": {
            "type": "ml.p4d.24xlarge",
            "gpu": "8x A100 40GB",
            "vram": "320GB",
            "tier": "recommended",
        },
        "high_performance": {
            "type": "ml.p5.48xlarge",
            "gpu": "8x H100 80GB",
            "vram": "640GB",
            "tier": "high-performance",
        },
        "budget": {
            "type": "ml.g5.12xlarge",
            "gpu": "4x A10G 24GB",
            "vram": "96GB",
            "tier": "budget-friendly",
            "note": "단일 GPU 48GB 미만이므로 모델 병렬화 필요",
        },
    },
    "inference": {
        "recommended": {
            "type": "ml.g5.2xlarge",
            "gpu": "1x A10G 24GB",
            "vram": "24GB",
            "tier": "recommended",
        },
        "high_performance": {
            "type": "ml.p4d.24xlarge",
            "gpu": "8x A100 40GB",
            "vram": "320GB",
            "tier": "high-performance",
        },
        "budget": {
            "type": "ml.g5.xlarge",
            "gpu": "1x A10G 24GB",
            "vram": "24GB",
            "tier": "budget-friendly",
        },
    },
}

# Minimum VRAM requirements in GB
MINIMUM_VRAM_TRAINING: int = 48
MINIMUM_VRAM_INFERENCE: int = 24

# Mapping of instance types to total VRAM in GB
INSTANCE_VRAM_MAP: dict[str, int] = {
    "ml.p4d.24xlarge": 320,    # 8x A100 40GB
    "ml.p5.48xlarge": 640,     # 8x H100 80GB
    "ml.g5.xlarge": 24,        # 1x A10G 24GB
    "ml.g5.2xlarge": 24,       # 1x A10G 24GB
    "ml.g5.12xlarge": 96,      # 4x A10G 24GB
    "ml.g5.48xlarge": 192,     # 8x A10G 24GB
}

# S3 URI pattern: s3://bucket-name/path
_S3_URI_PATTERN = re.compile(r"^s3://[a-zA-Z0-9.\-_]+/.+$")


def validate_instance_type(instance_type: str, purpose: str) -> bool:
    """Validate that an instance type meets minimum VRAM requirements for the given purpose.

    Args:
        instance_type: SageMaker instance type string (e.g. "ml.p4d.24xlarge").
        purpose: Either "training" or "inference".

    Returns:
        True if the instance meets the minimum VRAM requirement, False otherwise.
    """
    if purpose not in ("training", "inference"):
        return False

    vram = INSTANCE_VRAM_MAP.get(instance_type)
    if vram is None:
        return False

    minimum = MINIMUM_VRAM_TRAINING if purpose == "training" else MINIMUM_VRAM_INFERENCE
    return vram >= minimum


def get_instance_recommendations(purpose: str) -> list[dict]:
    """Return instance recommendations for the given purpose.

    Args:
        purpose: Either "training" or "inference".

    Returns:
        List of recommendation dicts, each containing type, gpu, vram, and tier fields.
    """
    recommendations = INSTANCE_RECOMMENDATIONS.get(purpose)
    if recommendations is None:
        return []
    return list(recommendations.values())


def validate_s3_uri(uri: str) -> bool:
    """Validate that a string is a properly formatted S3 URI.

    A valid S3 URI matches the pattern: s3://bucket-name/path

    Args:
        uri: String to validate.

    Returns:
        True if the string is a valid S3 URI, False otherwise.
    """
    return bool(_S3_URI_PATTERN.match(uri))


@dataclass
class TrainingConfig:
    """Configuration for a SageMaker fine-tuning job."""

    base_model_s3_uri: str
    dataset_s3_uri: str
    output_s3_uri: str
    instance_type: str
    embodiment_tag: str
    instance_count: int = 1
    max_steps: int = 10000
    global_batch_size: int = 32
    save_steps: int = 2000
    wandb_api_key: Optional[str] = None
    num_gpus: int = 1


@dataclass
class DeploymentConfig:
    """Configuration for a SageMaker inference endpoint deployment."""

    model_s3_uri: str
    instance_type: str
    endpoint_name: str
    container_image_uri: str
