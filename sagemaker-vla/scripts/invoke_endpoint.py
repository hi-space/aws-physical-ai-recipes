#!/usr/bin/env python3
"""Example script to invoke a SageMaker Endpoint for GR00T-N1.6 inference.

Loads an RGB image from disk, encodes it as base64, and sends an inference
request to a deployed SageMaker endpoint. Prints the returned action vectors
and timestamp.

Usage:
    python scripts/invoke_endpoint.py \
        --endpoint-name groot-inference \
        --image-path /path/to/image.png \
        --proprioception 0.1,0.2,0.3,0.4,0.5,0.6,0.7 \
        --instruction "pick up the red block" \
        --region us-east-1

Requirements referenced: 3.2
"""

import argparse
import base64
import json
import sys

# Graceful handling when boto3 is not installed
try:
    import boto3
except ImportError:
    boto3 = None


def load_and_encode_image(image_path: str) -> str:
    """Read an image file from disk and return its base64-encoded string.

    Args:
        image_path: Path to an RGB image file (e.g. PNG, JPEG).

    Returns:
        Base64-encoded string of the image bytes.

    Raises:
        FileNotFoundError: If the image file does not exist.
    """
    with open(image_path, "rb") as f:
        image_bytes = f.read()
    return base64.b64encode(image_bytes).decode("utf-8")


def parse_proprioception(raw: str) -> list[float]:
    """Parse a comma-separated string of floats into a list.

    Args:
        raw: Comma-separated float values, e.g. "0.1,0.2,0.3".

    Returns:
        List of float values.

    Raises:
        ValueError: If any value cannot be converted to float.
    """
    return [float(v.strip()) for v in raw.split(",")]


def invoke_endpoint(
    endpoint_name: str,
    image_b64: str,
    proprioception: list[float],
    instruction: str,
    region: str = "us-east-1",
) -> dict:
    """Send an inference request to the SageMaker endpoint.

    Constructs a JSON payload with the image, proprioception vector, and
    instruction, then invokes the endpoint via the sagemaker-runtime API.

    Args:
        endpoint_name: Name of the deployed SageMaker endpoint.
        image_b64: Base64-encoded RGB image string.
        proprioception: Robot proprioception vector as a list of floats.
        instruction: Natural language task instruction.
        region: AWS region where the endpoint is deployed.

    Returns:
        Parsed response dict with "actions" and "timestamp" keys.

    Raises:
        ImportError: If boto3 is not installed.
        RuntimeError: If the endpoint invocation fails.
    """
    if boto3 is None:
        raise ImportError("boto3 is required. Install with: pip install boto3")

    # Build the request payload matching the inference handler's expected schema
    payload = {
        "image": image_b64,
        "proprioception": proprioception,
        "instruction": instruction,
    }

    # Use sagemaker-runtime client to invoke the endpoint
    runtime_client = boto3.client("sagemaker-runtime", region_name=region)

    try:
        response = runtime_client.invoke_endpoint(
            EndpointName=endpoint_name,
            ContentType="application/json",
            Accept="application/json",
            Body=json.dumps(payload),
        )
    except Exception as e:
        raise RuntimeError(f"Failed to invoke endpoint '{endpoint_name}': {e}")

    # Read and parse the response body
    response_body = response["Body"].read().decode("utf-8")
    return json.loads(response_body)


def main() -> None:
    """CLI entrypoint for invoking a GR00T SageMaker endpoint."""
    parser = argparse.ArgumentParser(
        description="Invoke a SageMaker Endpoint for GR00T-N1.6 inference."
    )
    parser.add_argument(
        "--endpoint-name", required=True,
        help="Name of the deployed SageMaker endpoint",
    )
    parser.add_argument(
        "--image-path", required=True,
        help="Path to an RGB image file (PNG, JPEG, etc.)",
    )
    parser.add_argument(
        "--proprioception", required=True,
        help="Comma-separated floats for the robot proprioception vector",
    )
    parser.add_argument(
        "--instruction", required=True,
        help="Natural language task instruction for the model",
    )
    parser.add_argument(
        "--region", default="us-east-1",
        help="AWS region (default: us-east-1)",
    )

    args = parser.parse_args()

    # Step 1: Load the image and encode as base64
    print(f"Loading image from: {args.image_path}")
    image_b64 = load_and_encode_image(args.image_path)
    print(f"Image encoded ({len(image_b64)} base64 chars)")

    # Step 2: Parse the proprioception vector
    proprioception = parse_proprioception(args.proprioception)
    print(f"Proprioception vector: {proprioception}")

    # Step 3: Invoke the endpoint
    print(f"Invoking endpoint: {args.endpoint_name} (region: {args.region})")
    result = invoke_endpoint(
        endpoint_name=args.endpoint_name,
        image_b64=image_b64,
        proprioception=proprioception,
        instruction=args.instruction,
        region=args.region,
    )

    # Step 4: Print the response
    print("\n--- Inference Response ---")
    print(f"Timestamp: {result.get('timestamp', 'N/A')}")
    actions = result.get("actions", [])
    print(f"Actions ({len(actions)} steps):")
    for i, action in enumerate(actions):
        print(f"  Step {i}: {action}")


if __name__ == "__main__":
    main()
