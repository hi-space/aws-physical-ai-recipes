"""SageMaker inference handler for GR00T-N1.6 model.

Implements the four SageMaker inference functions:
- model_fn: Load model from model directory
- input_fn: Parse and validate JSON request
- predict_fn: Execute model inference (stub)
- output_fn: Serialize prediction to JSON
"""

import base64
import json
import os
from datetime import datetime, timezone


def model_fn(model_dir: str):
    """Load the GR00T model from the model directory.

    Since the actual GR00T library is not available in this codebase,
    this is a stub that verifies the model directory exists and contains
    expected files, then returns model metadata.

    Args:
        model_dir: Path to the directory containing model artifacts.

    Returns:
        A dict with model metadata (model_dir, config info).

    Raises:
        FileNotFoundError: If model_dir does not exist.
        ValueError: If model_dir is missing expected files.
    """
    if not os.path.isdir(model_dir):
        raise FileNotFoundError(f"Model directory does not exist: {model_dir}")

    contents = os.listdir(model_dir)
    if not contents:
        raise ValueError(f"Model directory is empty: {model_dir}")

    # Build model metadata from directory contents
    model_info = {
        "model_dir": model_dir,
        "files": contents,
        "loaded": True,
    }

    # Try to load config if present
    config_path = os.path.join(model_dir, "config.json")
    if os.path.isfile(config_path):
        with open(config_path, "r") as f:
            model_info["config"] = json.load(f)

    return model_info


def input_fn(request_body: bytes, content_type: str) -> dict:
    """Parse JSON request body and validate required fields.

    Args:
        request_body: Raw request bytes.
        content_type: MIME type of the request (must be "application/json").

    Returns:
        Parsed and validated input dict with keys: image, proprioception, instruction.

    Raises:
        ValueError: If content_type is not application/json, required fields are
            missing, or field values are invalid.
    """
    if content_type != "application/json":
        raise ValueError(
            f"Unsupported content type: {content_type}. "
            "Only application/json is supported."
        )

    try:
        data = json.loads(request_body)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(f"Invalid JSON in request body: {e}")

    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object.")

    # Check required fields
    required_fields = ["image", "proprioception", "instruction"]
    missing = [f for f in required_fields if f not in data]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")

    # Validate image: must be a non-empty base64-decodable string
    image = data["image"]
    if not isinstance(image, str) or not image:
        raise ValueError("Field 'image' must be a non-empty base64-encoded string.")
    try:
        base64.b64decode(image, validate=True)
    except Exception:
        raise ValueError("Field 'image' contains invalid base64 data.")

    # Validate proprioception: must be a non-empty list of numbers
    proprioception = data["proprioception"]
    if not isinstance(proprioception, list) or len(proprioception) == 0:
        raise ValueError("Field 'proprioception' must be a non-empty list of floats.")
    for i, v in enumerate(proprioception):
        if not isinstance(v, (int, float)):
            raise ValueError(
                f"Field 'proprioception[{i}]' must be a number, got {type(v).__name__}."
            )

    # Validate instruction: must be a non-empty string
    instruction = data["instruction"]
    if not isinstance(instruction, str) or not instruction.strip():
        raise ValueError("Field 'instruction' must be a non-empty string.")

    return {
        "image": image,
        "proprioception": [float(v) for v in proprioception],
        "instruction": instruction.strip(),
    }


def predict_fn(input_data: dict, model) -> dict:
    """Execute model inference.

    Since the actual GR00T model is not available, this stub returns a
    properly structured response with placeholder action vectors and a timestamp.

    Args:
        input_data: Validated input dict from input_fn.
        model: Model object from model_fn.

    Returns:
        Dict with "actions" (list of action vectors) and "timestamp" (ISO 8601).
    """
    # Stub: generate a placeholder action sequence
    # In production, this would run the actual GR00T model inference
    num_actions = 1
    action_dim = len(input_data.get("proprioception", [0.0] * 7))
    actions = [[0.0] * action_dim for _ in range(num_actions)]

    return {
        "actions": actions,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def output_fn(prediction: dict, accept_type: str) -> bytes:
    """Serialize prediction to JSON bytes.

    Args:
        prediction: Dict with "actions" and "timestamp" keys.
        accept_type: Desired response MIME type (application/json supported).

    Returns:
        JSON-encoded bytes of the prediction.

    Raises:
        ValueError: If accept_type is not application/json.
    """
    if accept_type != "application/json":
        raise ValueError(
            f"Unsupported accept type: {accept_type}. "
            "Only application/json is supported."
        )

    return json.dumps(prediction).encode("utf-8")
