#!/usr/bin/env python3
"""GR00T-N1.6 SageMaker Endpoint 추론 호출 스크립트.

이미지 파일을 base64로 인코딩하고 배포된 SageMaker 엔드포인트에
추론 요청을 전송합니다.

사용법:
    python scripts/invoke_endpoint.py \\
        --endpoint-name groot-n16-endpoint \\
        --image-path /path/to/image.png \\
        --proprioception 0.1,0.2,0.3,0.4,0.5,0.6,0.7 \\
        --instruction "pick up the red block"
"""

import argparse
import base64
import json
import sys
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.yaml"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


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


def parse_proprioception(raw: str):
    """Parse proprioception input as flat list or keyed dict.

    Formats:
        Flat:  "0.1,0.2,0.3,0.4"
        Dict:  "dual_arm:0.1,0.2,...,0.12;gripper:0.1,0.2"

    Returns:
        list[float] for flat format, dict[str, list[float]] for keyed format.
    """
    if ":" in raw:
        result = {}
        for part in raw.split(";"):
            key, values = part.split(":", 1)
            result[key.strip()] = [float(v.strip()) for v in values.split(",")]
        return result
    return [float(v.strip()) for v in raw.split(",")]


def invoke_endpoint(
    endpoint_name: str,
    image_b64: str,
    proprioception: list[float],
    instruction: str,
    region: str = "us-east-1",
    inference_component_name: str = "",
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
    # proprioception이 dict면 state 형식, list면 flat 형식
    payload = {
        "image": image_b64,
        "instruction": instruction,
    }
    if isinstance(proprioception, dict):
        payload["state"] = proprioception
    else:
        payload["proprioception"] = proprioception

    # Use sagemaker-runtime client to invoke the endpoint
    runtime_client = boto3.client("sagemaker-runtime", region_name=region)

    invoke_kwargs = dict(
        EndpointName=endpoint_name,
        ContentType="application/json",
        Accept="application/json",
        Body=json.dumps(payload),
    )
    if inference_component_name:
        invoke_kwargs["InferenceComponentName"] = inference_component_name

    try:
        response = runtime_client.invoke_endpoint(**invoke_kwargs)
    except Exception as e:
        raise RuntimeError(f"Failed to invoke endpoint '{endpoint_name}': {e}")

    # Read and parse the response body
    response_body = response["Body"].read().decode("utf-8")
    return json.loads(response_body)


def main() -> None:
    """CLI entrypoint for invoking a GR00T SageMaker endpoint."""
    config = load_config()
    aws_cfg = config.get("aws", {})
    infer_cfg = config.get("inference", {})

    parser = argparse.ArgumentParser(
        description="GR00T-N1.6 SageMaker Endpoint 추론 호출"
    )
    parser.add_argument(
        "--endpoint-name",
        default=infer_cfg.get("endpoint_name", "groot-n16-endpoint"),
        help="배포된 SageMaker 엔드포인트 이름",
    )
    parser.add_argument(
        "--image-path", required=True,
        help="RGB 이미지 파일 경로 (PNG, JPEG 등)",
    )
    parser.add_argument(
        "--proprioception", required=True,
        help=(
            "로봇 관절 상태 벡터. 두 가지 형식 지원:\n"
            "  Flat: 0.1,0.2,...,0.14 (단일 state 키 모델용)\n"
            "  Keyed: dual_arm:v1,...,v12;gripper:v1,v2 (다중 state 키 모델용)"
        ),
    )
    parser.add_argument(
        "--instruction", required=True,
        help="자연어 작업 지시 (예: 'pick up the red block')",
    )
    parser.add_argument(
        "--region",
        default=aws_cfg.get("region", "us-west-2"),
        help="AWS 리전",
    )
    parser.add_argument(
        "--inference-component-name",
        default="",
        help="Inference Component 이름 (IC 기반 배포 시 필요)",
    )

    args = parser.parse_args()

    # Step 0: Auto-discover inference component name if not provided
    if not args.inference_component_name:
        try:
            sm = boto3.client("sagemaker", region_name=args.region)
            ic_resp = sm.list_inference_components(
                EndpointNameEquals=args.endpoint_name,
                SortBy="CreationTime",
                SortOrder="Descending",
                MaxResults=1,
            )
            ic_list = ic_resp.get("InferenceComponents", [])
            if ic_list:
                args.inference_component_name = ic_list[0]["InferenceComponentName"]
                print(f"Auto-detected Inference Component: {args.inference_component_name}")
        except Exception:
            pass  # IC가 없는 일반 엔드포인트일 수 있음

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
        inference_component_name=args.inference_component_name,
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
