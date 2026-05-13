#!/usr/bin/env python3
"""GR00T SageMaker Endpoint 추론 호출 스크립트.

이미지 파일을 base64로 인코딩하고 배포된 SageMaker 엔드포인트에
추론 요청을 전송합니다.

사용법 (SO-101 + leisaac-pick-orange):
    python scripts/invoke_endpoint.py \\
        --endpoint-name groot-n16-endpoint \\
        --image-path /path/to/image.png \\
        --proprioception "single_arm:0.1,0.2,0.3,0.4,0.5;gripper:0.0" \\
        --instruction "pick up the orange"

실제 차원은 학습한 데이터셋의 meta/modality.json과 statistics.json에 따라
자동 감지됩니다. 잘못된 차원으로 호출하면 모델이 기대하는 형식이 에러 메시지에
출력됩니다.
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
    images_b64: dict | None = None,
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
        "instruction": instruction,
    }
    if images_b64:
        payload["images"] = images_b64
    else:
        payload["image"] = image_b64
    if isinstance(proprioception, dict) and proprioception:
        payload["state"] = proprioception
    elif isinstance(proprioception, list) and proprioception:
        payload["proprioception"] = proprioception
    # else: 서버가 modality 정보로 0 자동 채움

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
        "--image-path", required=False, default="",
        help=(
            "RGB 이미지 파일 경로 (PNG, JPEG 등). 단일 이미지를 모델의 모든 video_keys 에 broadcast.\n"
            "여러 카메라 입력을 지정하려면 대신 --images 사용."
        ),
    )
    parser.add_argument(
        "--images", default="",
        help=(
            "카메라별 이미지 경로 (세미콜론 구분). 예: front=./front.png;wrist=./wrist.png\n"
            "지정 시 --image-path 무시. 모델 video_keys 와 카메라 이름이 일치해야 함."
        ),
    )
    parser.add_argument(
        "--proprioception", default="",
        help=(
            "로봇 관절 상태 벡터 (선택). 두 가지 형식 지원:\n"
            "  Keyed (권장): single_arm:0.1,...,0.5;gripper:0.0\n"
            "  Flat:        0.1,0.2,0.3,0.4,0.5,0.0\n"
            "생략 시 서버가 모델 modality 정보로 0 으로 자동 채움 (dummy state)."
        ),
    )
    parser.add_argument(
        "--instruction", required=True,
        help="자연어 작업 지시 (예: 'pick up the orange')",
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

    # Step 1: Load image(s) and encode as base64
    images_b64 = None
    image_b64 = ""
    if args.images:
        # 카메라별 dict 형식: cam=path;cam2=path2
        images_b64 = {}
        for part in args.images.split(";"):
            if not part.strip():
                continue
            cam, path = part.split("=", 1)
            cam = cam.strip()
            path = path.strip()
            print(f"Loading image[{cam}] from: {path}")
            images_b64[cam] = load_and_encode_image(path)
        print(f"Encoded {len(images_b64)} camera images: {list(images_b64.keys())}")
    elif args.image_path:
        print(f"Loading image from: {args.image_path}")
        image_b64 = load_and_encode_image(args.image_path)
        print(f"Image encoded ({len(image_b64)} base64 chars)")
    else:
        print("오류: --image-path 또는 --images 중 하나가 필요합니다.", file=sys.stderr)
        sys.exit(1)

    # Step 2: Parse the proprioception vector (생략 시 서버가 0으로 자동 채움)
    if args.proprioception:
        proprioception = parse_proprioception(args.proprioception)
        print(f"Proprioception vector: {proprioception}")
    else:
        proprioception = []
        print("Proprioception 미지정 → 서버가 modality 정보로 0 자동 채움")

    # Step 3: Invoke the endpoint
    print(f"Invoking endpoint: {args.endpoint_name} (region: {args.region})")
    result = invoke_endpoint(
        endpoint_name=args.endpoint_name,
        image_b64=image_b64,
        proprioception=proprioception,
        instruction=args.instruction,
        region=args.region,
        inference_component_name=args.inference_component_name,
        images_b64=images_b64,
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
