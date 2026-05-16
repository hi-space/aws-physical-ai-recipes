"""GR00T-N1.6 endpoint 통합 배포 Lambda 핸들러.

SageMaker Pipeline의 LambdaStep에서 호출되어 다음을 atomic하게 수행합니다:
  1. 같은 이름의 기존 endpoint가 있으면 삭제 (waiter 대기)
  2. SageMaker Model 생성 (training artifact + inference image)
  3. EndpointConfig 생성
  4. Endpoint 생성 (InService waiter는 두지 않음)

입력 이벤트 (모두 필수):
  endpoint_name : 생성/업데이트할 endpoint 이름
  instance_type : 추론 인스턴스 타입
  model_data    : training step 결과 model.tar.gz S3 URI
  image_uri     : 추론 컨테이너 ECR URI
  role_arn      : SageMaker 실행 역할 ARN
  region        : (선택) AWS 리전
"""

import time

import boto3
from botocore.exceptions import ClientError, WaiterError


def _delete_existing_endpoint(sm, endpoint_name: str) -> dict:
    """기존 endpoint가 있으면 삭제하고 EndpointConfig/Model도 best-effort 정리."""
    try:
        ep = sm.describe_endpoint(EndpointName=endpoint_name)
    except ClientError as e:
        # 없으면 skip
        if "Could not find endpoint" in str(e) or "ValidationException" in str(e):
            return {"action": "skipped", "reason": "endpoint_not_found"}
        raise

    status = ep["EndpointStatus"]
    if status not in ("InService", "Failed"):
        # Creating/Updating/Deleting 중에는 안전하게 거절
        raise RuntimeError(
            f"Endpoint '{endpoint_name}' is in transient state '{status}'; "
            "retry after it stabilizes."
        )

    config_name = ep["EndpointConfigName"]
    model_name = None
    try:
        cfg = sm.describe_endpoint_config(EndpointConfigName=config_name)
        variants = cfg.get("ProductionVariants", [])
        if variants:
            model_name = variants[0].get("ModelName")
    except ClientError:
        pass

    sm.delete_endpoint(EndpointName=endpoint_name)
    waiter = sm.get_waiter("endpoint_deleted")
    try:
        waiter.wait(
            EndpointName=endpoint_name,
            WaiterConfig={"Delay": 10, "MaxAttempts": 60},
        )
    except WaiterError as e:
        raise RuntimeError(f"endpoint_deleted waiter failed: {e}") from e

    # best-effort cleanup
    try:
        sm.delete_endpoint_config(EndpointConfigName=config_name)
    except ClientError:
        pass
    if model_name:
        try:
            sm.delete_model(ModelName=model_name)
        except ClientError:
            pass

    return {"action": "deleted", "previous_config": config_name, "previous_model": model_name}


def handler(event, context):
    region = event.get("region") or None
    sm = boto3.client("sagemaker", region_name=region) if region else boto3.client("sagemaker")

    endpoint_name = event["endpoint_name"]
    instance_type = event["instance_type"]
    model_data = event["model_data"]
    image_uri = event["image_uri"]
    role_arn = event["role_arn"]

    cleanup_result = _delete_existing_endpoint(sm, endpoint_name)

    timestamp = int(time.time())
    model_name = f"{endpoint_name}-model-{timestamp}"
    config_name = f"{endpoint_name}-{timestamp}"

    sm.create_model(
        ModelName=model_name,
        PrimaryContainer={
            "Image": image_uri,
            "ModelDataUrl": model_data,
        },
        ExecutionRoleArn=role_arn,
    )

    sm.create_endpoint_config(
        EndpointConfigName=config_name,
        ProductionVariants=[
            {
                "VariantName": "AllTraffic",
                "ModelName": model_name,
                "InstanceType": instance_type,
                "InitialInstanceCount": 1,
                # GR00T 모델(특히 base + checkpoint 통째 패킹)은 100GB+ 가 될 수 있어
                # 기본 download/health-check timeout(15분)으로는 부족.
                "ModelDataDownloadTimeoutInSeconds": 3600,
                "ContainerStartupHealthCheckTimeoutInSeconds": 1800,
            }
        ],
    )

    sm.create_endpoint(EndpointName=endpoint_name, EndpointConfigName=config_name)

    return {
        "statusCode": 200,
        "endpoint_name": endpoint_name,
        "model_name": model_name,
        "endpoint_config_name": config_name,
        "cleanup": cleanup_result,
    }
