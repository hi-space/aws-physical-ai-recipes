"""GR00T-N1.6 엔드포인트 배포 Lambda 핸들러.

SageMaker Pipeline의 LambdaStep에서 호출되어,
Model Registry의 최신 승인 모델로 엔드포인트를 생성/업데이트합니다.

입력 이벤트:
    model_package_group: Model Registry 패키지 그룹 이름
    endpoint_name:       생성/업데이트할 엔드포인트 이름
    instance_type:       추론 인스턴스 타입
    role_arn:            SageMaker 실행 역할 ARN
"""

import time

import boto3
from botocore.exceptions import ClientError


def handler(event, context):
    sm = boto3.client("sagemaker")

    model_package_group = event["model_package_group"]
    endpoint_name = event["endpoint_name"]
    instance_type = event["instance_type"]
    role_arn = event["role_arn"]

    # 1. Model Registry에서 최신 승인 모델 조회
    response = sm.list_model_packages(
        ModelPackageGroupName=model_package_group,
        ModelApprovalStatus="Approved",
        SortBy="CreationTime",
        SortOrder="Descending",
        MaxResults=1,
    )
    packages = response.get("ModelPackageSummaryList", [])
    if not packages:
        return {
            "statusCode": 404,
            "endpoint_name": endpoint_name,
            "action": "skipped",
            "error": f"No approved model in '{model_package_group}'",
        }

    model_package_arn = packages[0]["ModelPackageArn"]
    timestamp = int(time.time())
    model_name = f"groot-n16-{timestamp}"
    config_name = f"{endpoint_name}-{timestamp}"

    # 2. SageMaker Model 생성 (Model Package 참조)
    sm.create_model(
        ModelName=model_name,
        PrimaryContainer={"ModelPackageName": model_package_arn},
        ExecutionRoleArn=role_arn,
    )

    # 3. Endpoint Configuration 생성
    sm.create_endpoint_config(
        EndpointConfigName=config_name,
        ProductionVariants=[
            {
                "VariantName": "AllTraffic",
                "ModelName": model_name,
                "InstanceType": instance_type,
                "InitialInstanceCount": 1,
            }
        ],
    )

    # 4. Endpoint 생성 또는 업데이트
    try:
        ep = sm.describe_endpoint(EndpointName=endpoint_name)
        status = ep["EndpointStatus"]
        if status in ("InService", "Failed"):
            sm.update_endpoint(
                EndpointName=endpoint_name,
                EndpointConfigName=config_name,
            )
            action = "updated"
        else:
            # Creating/Updating/Deleting 상태면 건너뜀
            return {
                "statusCode": 409,
                "endpoint_name": endpoint_name,
                "action": "skipped",
                "error": f"Endpoint is {status}, cannot update",
            }
    except ClientError:
        sm.create_endpoint(
            EndpointName=endpoint_name,
            EndpointConfigName=config_name,
        )
        action = "created"

    return {
        "statusCode": 200,
        "endpoint_name": endpoint_name,
        "action": action,
        "model_package_arn": model_package_arn,
    }
