#!/usr/bin/env python3
"""GR00T-N1.6 AWS 인프라 스택 배포 스크립트.

CloudFormation 스택을 배포하여 필요한 모든 AWS 리소스를 생성하고,
결과값(버킷명, 역할 ARN, ECR URI 등)을 config.yaml에 자동으로 기입합니다.

사용법:
    python infra/deploy_stack.py \
        --stack-name groot-n16-stack \
        --bucket-name my-groot-artifacts-20240101 \
        --region ap-northeast-2
"""

import argparse
import json
import sys
import time
from pathlib import Path

import boto3
import yaml
from botocore.exceptions import ClientError

# 프로젝트 루트 (sagemaker-vla/)
PROJECT_ROOT = Path(__file__).parent.parent
CFN_TEMPLATE_PATH = Path(__file__).parent / "cloudformation.yaml"
CONFIG_PATH = PROJECT_ROOT / "config.yaml"


def get_account_id(session: boto3.Session) -> str:
    sts = session.client("sts")
    return sts.get_caller_identity()["Account"]


def deploy_stack(
    stack_name: str,
    bucket_name: str,
    region: str,
    role_name: str = "GR00TSageMakerRole",
    repository_url: str = "",
) -> dict:
    """CloudFormation 스택을 생성 또는 업데이트합니다.

    Args:
        stack_name: CloudFormation 스택 이름.
        bucket_name: S3 버킷 이름 (전 세계 고유해야 함).
        region: AWS 리전.
        role_name: SageMaker 실행 역할 이름.
        repository_url: CodeBuild 소스 GitHub URL (선택).

    Returns:
        스택 출력값 딕셔너리 (BucketName, SageMakerRoleArn, ECR URIs 등).
    """
    session = boto3.Session(region_name=region)
    cfn = session.client("cloudformation")
    account_id = get_account_id(session)

    template_body = CFN_TEMPLATE_PATH.read_text(encoding="utf-8")

    parameters = [
        {"ParameterKey": "BucketName", "ParameterValue": bucket_name},
        {"ParameterKey": "RoleName", "ParameterValue": role_name},
        {"ParameterKey": "RepositoryUrl", "ParameterValue": repository_url},
    ]

    # 스택 존재 여부 확인
    stack_exists = False
    try:
        cfn.describe_stacks(StackName=stack_name)
        stack_exists = True
    except ClientError as e:
        if "does not exist" not in str(e):
            raise

    try:
        if stack_exists:
            print(f"스택 '{stack_name}' 업데이트 중...")
            cfn.update_stack(
                StackName=stack_name,
                TemplateBody=template_body,
                Parameters=parameters,
                Capabilities=["CAPABILITY_NAMED_IAM"],
            )
            waiter = cfn.get_waiter("stack_update_complete")
        else:
            print(f"스택 '{stack_name}' 생성 중...")
            cfn.create_stack(
                StackName=stack_name,
                TemplateBody=template_body,
                Parameters=parameters,
                Capabilities=["CAPABILITY_NAMED_IAM"],
                Tags=[{"Key": "Project", "Value": "GR00T-N1.6"}],
            )
            waiter = cfn.get_waiter("stack_create_complete")

        print("배포 완료 대기 중... (수 분 소요될 수 있습니다)")
        waiter.wait(
            StackName=stack_name,
            WaiterConfig={"Delay": 10, "MaxAttempts": 60},
        )
        print("스택 배포 완료!")

    except ClientError as e:
        if "No updates are to be performed" in str(e):
            print("변경 사항 없음 - 스택이 이미 최신 상태입니다.")
        else:
            raise

    # 출력값 수집
    response = cfn.describe_stacks(StackName=stack_name)
    outputs_raw = response["Stacks"][0].get("Outputs", [])
    outputs = {o["OutputKey"]: o["OutputValue"] for o in outputs_raw}
    outputs["AccountId"] = account_id
    outputs["Region"] = region

    return outputs


def update_config_yaml(outputs: dict) -> None:
    """스택 출력값을 config.yaml에 기입합니다.

    Args:
        outputs: deploy_stack() 반환값.
    """
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))

    config["aws"]["account_id"] = outputs.get("AccountId", "")
    config["aws"]["bucket_name"] = outputs.get("BucketName", "")
    config["aws"]["role_arn"] = outputs.get("SageMakerRoleArn", "")
    config["aws"]["region"] = outputs.get("Region", config["aws"]["region"])
    config["ecr"]["training_uri"] = outputs.get("TrainingRepositoryUri", "")
    config["ecr"]["inference_uri"] = outputs.get("InferenceRepositoryUri", "")

    CONFIG_PATH.write_text(yaml.dump(config, allow_unicode=True, default_flow_style=False), encoding="utf-8")
    print(f"config.yaml 업데이트 완료: {CONFIG_PATH}")


def print_summary(outputs: dict) -> None:
    """배포 결과 요약을 출력합니다."""
    print("\n" + "=" * 60)
    print("  GR00T 인프라 배포 완료!")
    print("=" * 60)
    print(f"  AWS 계정 ID  : {outputs.get('AccountId')}")
    print(f"  리전          : {outputs.get('Region')}")
    print(f"  S3 버킷       : {outputs.get('BucketName')}")
    print(f"  SageMaker 역할: {outputs.get('SageMakerRoleArn')}")
    print(f"  학습 ECR URI  : {outputs.get('TrainingRepositoryUri')}")
    print(f"  추론 ECR URI  : {outputs.get('InferenceRepositoryUri')}")
    print("=" * 60)
    print("\n다음 단계:")
    print("  1. (선택) SSM 파라미터 업데이트:")
    print("       aws ssm put-parameter --name /groot/hf-token --value <HF_TOKEN> --overwrite")
    print("       aws ssm put-parameter --name /groot/wandb-key --value <WANDB_KEY> --overwrite")
    print("  2. 모델 다운로드:")
    print("       python data/download_model.py")
    print("  3. 데이터셋 업로드:")
    print("       python data/upload_dataset.py --local-path ./my-dataset")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="GR00T-N1.6 AWS 인프라 스택 배포",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python infra/deploy_stack.py \\
      --stack-name groot-n16-stack \\
      --bucket-name my-groot-artifacts-20240101 \\
      --region ap-northeast-2
        """,
    )
    parser.add_argument("--stack-name", required=True, help="CloudFormation 스택 이름")
    parser.add_argument("--bucket-name", required=True, help="S3 버킷 이름 (전 세계 고유)")
    parser.add_argument("--region", default="ap-northeast-2", help="AWS 리전 (기본값: ap-northeast-2)")
    parser.add_argument("--role-name", default="GR00TSageMakerRole", help="SageMaker 실행 역할 이름")
    parser.add_argument("--repository-url", default="", help="CodeBuild GitHub 소스 URL (선택)")
    parser.add_argument("--no-update-config", action="store_true", help="config.yaml 자동 업데이트 건너뜀")

    args = parser.parse_args()

    try:
        outputs = deploy_stack(
            stack_name=args.stack_name,
            bucket_name=args.bucket_name,
            region=args.region,
            role_name=args.role_name,
            repository_url=args.repository_url,
        )

        if not args.no_update_config:
            update_config_yaml(outputs)

        print_summary(outputs)

    except ClientError as e:
        print(f"오류: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n취소됨.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
