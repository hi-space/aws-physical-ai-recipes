#!/usr/bin/env python3
"""GR00T-N1.6 SageMaker Endpoint 배포/삭제 스크립트.

Model Registry에서 승인된 최신 모델을 배포하거나,
model.tar.gz S3 URI를 직접 지정하여 배포합니다.

사용법:
    # Model Registry에서 최신 승인 모델 배포 (권장):
    python scripts/deploy_endpoint.py

    # S3 URI로 직접 배포:
    python scripts/deploy_endpoint.py \\
        --model-s3-uri s3://my-bucket/output/job-name/output/model.tar.gz

    # 엔드포인트 삭제:
    python scripts/deploy_endpoint.py --action delete
"""

import argparse
import sys
from pathlib import Path

import boto3
import yaml
from botocore.exceptions import ClientError

PROJECT_ROOT = Path(__file__).parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.yaml"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def get_latest_approved_model(model_package_group: str, region: str) -> str:
    """Model Registry에서 최신 승인된 모델 패키지 ARN을 가져옵니다.

    Args:
        model_package_group: 모델 패키지 그룹 이름.
        region: AWS 리전.

    Returns:
        모델 패키지 ARN.

    Raises:
        ValueError: 승인된 모델이 없는 경우.
    """
    sm = boto3.client("sagemaker", region_name=region)

    response = sm.list_model_packages(
        ModelPackageGroupName=model_package_group,
        ModelApprovalStatus="Approved",
        SortBy="CreationTime",
        SortOrder="Descending",
        MaxResults=1,
    )

    packages = response.get("ModelPackageSummaryList", [])
    if not packages:
        raise ValueError(
            f"'{model_package_group}' 그룹에 승인된 모델이 없습니다.\n"
            "  SageMaker 콘솔 → Model Registry에서 모델을 승인하세요."
        )

    arn = packages[0]["ModelPackageArn"]
    print(f"최신 승인 모델: {arn}")
    return arn


def deploy_from_model_registry(
    model_package_arn: str,
    endpoint_name: str,
    instance_type: str,
    role_arn: str,
    region: str,
) -> None:
    """Model Registry의 모델 패키지로 엔드포인트를 배포합니다."""
    try:
        import sagemaker
        from sagemaker.model import ModelPackage
    except ImportError:
        print("오류: sagemaker SDK가 설치되지 않았습니다.")
        print("  pip install sagemaker")
        sys.exit(1)

    session = sagemaker.Session(
        boto_session=boto3.Session(region_name=region)
    )

    model = ModelPackage(
        role=role_arn,
        model_package_arn=model_package_arn,
        sagemaker_session=session,
    )

    print(f"엔드포인트 배포 중: {endpoint_name}")
    print(f"  인스턴스 타입: {instance_type}")
    print(f"  (완료까지 수 분 소요됩니다...)")

    model.deploy(
        initial_instance_count=1,
        instance_type=instance_type,
        endpoint_name=endpoint_name,
    )

    print(f"\n엔드포인트 배포 완료!")
    print(f"  엔드포인트 이름: {endpoint_name}")


def deploy_from_s3_uri(
    model_s3_uri: str,
    inference_image_uri: str,
    endpoint_name: str,
    instance_type: str,
    role_arn: str,
    region: str,
) -> None:
    """S3 URI의 model.tar.gz로 엔드포인트를 직접 배포합니다."""
    try:
        import sagemaker
        from sagemaker.model import Model
    except ImportError:
        print("오류: sagemaker SDK가 설치되지 않았습니다.")
        print("  pip install sagemaker")
        sys.exit(1)

    session = sagemaker.Session(
        boto_session=boto3.Session(region_name=region)
    )

    model = Model(
        image_uri=inference_image_uri,
        model_data=model_s3_uri,
        role=role_arn,
        sagemaker_session=session,
    )

    print(f"엔드포인트 배포 중: {endpoint_name}")
    print(f"  모델 URI:      {model_s3_uri}")
    print(f"  인스턴스 타입: {instance_type}")
    print(f"  (완료까지 수 분 소요됩니다...)")

    model.deploy(
        initial_instance_count=1,
        instance_type=instance_type,
        endpoint_name=endpoint_name,
    )

    print(f"\n엔드포인트 배포 완료!")
    print(f"  엔드포인트 이름: {endpoint_name}")


def delete_endpoint(endpoint_name: str, region: str) -> None:
    """엔드포인트, 엔드포인트 설정, 모델을 삭제합니다."""
    sm = boto3.client("sagemaker", region_name=region)

    try:
        ep = sm.describe_endpoint(EndpointName=endpoint_name)
        config_name = ep["EndpointConfigName"]
    except ClientError:
        print(f"엔드포인트 '{endpoint_name}'을 찾을 수 없습니다.")
        return

    print(f"엔드포인트 삭제 중: {endpoint_name}")
    sm.delete_endpoint(EndpointName=endpoint_name)

    try:
        cfg = sm.describe_endpoint_config(EndpointConfigName=config_name)
        model_name = cfg["ProductionVariants"][0]["ModelName"]
        sm.delete_endpoint_config(EndpointConfigName=config_name)
        print(f"엔드포인트 설정 삭제: {config_name}")
        sm.delete_model(ModelName=model_name)
        print(f"모델 삭제: {model_name}")
    except Exception as e:
        print(f"경고: 정리 중 오류 발생: {e}")

    print(f"\n엔드포인트 삭제 완료: {endpoint_name}")


def main() -> None:
    config = load_config()
    aws_cfg = config.get("aws", {})
    infer_cfg = config.get("inference", {})
    ecr_cfg = config.get("ecr", {})

    parser = argparse.ArgumentParser(
        description="GR00T-N1.6 SageMaker Endpoint 배포/삭제",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  # Model Registry에서 최신 승인 모델 배포 (권장)
  python scripts/deploy_endpoint.py

  # S3 URI 직접 지정
  python scripts/deploy_endpoint.py \\
      --model-s3-uri s3://my-bucket/output/job-name/output/model.tar.gz

  # 엔드포인트 삭제
  python scripts/deploy_endpoint.py --action delete
        """,
    )
    parser.add_argument("--action", choices=["deploy", "delete"], default="deploy",
                        help="실행할 액션 (기본값: deploy)")
    parser.add_argument("--endpoint-name", default=infer_cfg.get("endpoint_name", "groot-n16-endpoint"),
                        help="엔드포인트 이름")
    parser.add_argument("--instance-type", default=infer_cfg.get("instance_type", "ml.g5.2xlarge"),
                        help="추론 인스턴스 타입")
    parser.add_argument("--region", default=aws_cfg.get("region", "ap-northeast-2"),
                        help="AWS 리전")
    parser.add_argument("--role-arn", default=aws_cfg.get("role_arn", ""),
                        help="SageMaker 실행 역할 ARN")
    parser.add_argument("--model-s3-uri", default="",
                        help="모델 S3 URI (미지정 시 Model Registry 사용)")
    parser.add_argument("--inference-image-uri", default=ecr_cfg.get("inference_uri", ""),
                        help="추론 컨테이너 ECR URI (--model-s3-uri 사용 시 필요)")
    parser.add_argument("--model-package-group",
                        default=infer_cfg.get("model_package_group", "groot-n16-models"),
                        help="Model Registry 패키지 그룹 이름")
    parser.add_argument("--model-package-arn", default="",
                        help="특정 모델 패키지 ARN (미지정 시 최신 승인 모델 사용)")

    args = parser.parse_args()

    if args.action == "delete":
        delete_endpoint(args.endpoint_name, args.region)
        return

    if not args.role_arn:
        print("오류: --role-arn이 필요합니다.")
        print("  infra/deploy_stack.py를 먼저 실행하거나 --role-arn을 지정하세요.")
        sys.exit(1)

    if args.model_s3_uri:
        if not args.inference_image_uri:
            print("오류: --model-s3-uri 사용 시 --inference-image-uri가 필요합니다.")
            sys.exit(1)
        deploy_from_s3_uri(
            model_s3_uri=args.model_s3_uri,
            inference_image_uri=args.inference_image_uri,
            endpoint_name=args.endpoint_name,
            instance_type=args.instance_type,
            role_arn=args.role_arn,
            region=args.region,
        )
    else:
        model_package_arn = args.model_package_arn
        if not model_package_arn:
            try:
                model_package_arn = get_latest_approved_model(
                    args.model_package_group, args.region
                )
            except ValueError as e:
                print(f"오류: {e}", file=sys.stderr)
                sys.exit(1)

        deploy_from_model_registry(
            model_package_arn=model_package_arn,
            endpoint_name=args.endpoint_name,
            instance_type=args.instance_type,
            role_arn=args.role_arn,
            region=args.region,
        )

    print(f"\n추론 테스트:")
    print(f"  python scripts/invoke_endpoint.py \\")
    print(f"      --endpoint-name {args.endpoint_name} \\")
    print(f"      --image-path test.png \\")
    print(f"      --proprioception 0.1,0.2,0.3,0.4,0.5,0.6,0.7 \\")
    print(f"      --instruction \"pick up the red block\"")


if __name__ == "__main__":
    main()
