#!/usr/bin/env python3
"""CodeBuild를 사용하여 GR00T 컨테이너 이미지를 빌드하고 ECR에 푸시합니다.

AWS CodeBuild를 사용하므로 로컬 Docker 설치가 불필요합니다.
빌드 로그는 CloudWatch Logs에서 확인할 수 있습니다.

사전 조건:
    - infra/deploy_stack.py 실행 완료 (CodeBuild 프로젝트 생성됨)
    - CodeBuild 프로젝트에 소스 설정 필요 (GitHub 연결 또는 S3 소스)

사용법:
    # 모든 컨테이너 빌드
    python scripts/trigger_build.py --type all

    # 학습 컨테이너만 빌드
    python scripts/trigger_build.py --type training

    # 추론 컨테이너만 빌드 (빌드 완료까지 대기하지 않음)
    python scripts/trigger_build.py --type inference --no-wait

S3 소스 업로드 방식 (GitHub 미사용 시):
    # 소스 코드를 S3에 업로드하여 CodeBuild 빌드 트리거
    python scripts/trigger_build.py --type all --upload-source --bucket my-bucket
"""

import argparse
import io
import os
import sys
import time
import zipfile
from pathlib import Path

import boto3
import yaml
from botocore.exceptions import ClientError

PROJECT_ROOT = Path(__file__).parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.yaml"

# CodeBuild 프로젝트 이름
PROJECT_NAMES = {
    "training": "groot-n16-training-build",
    "inference": "groot-n16-inference-build",
}


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def upload_source_to_s3(bucket: str, region: str) -> str:
    """프로젝트 소스 코드를 zip으로 압축하여 S3에 업로드합니다.

    CodeBuild S3 소스 방식에서 사용됩니다.

    Args:
        bucket: S3 버킷 이름.
        region: AWS 리전.

    Returns:
        업로드된 S3 키.
    """
    s3 = boto3.client("s3", region_name=region)
    timestamp = int(time.time())
    s3_key = f"codebuild-source/groot-n16-{timestamp}.zip"

    print(f"소스 코드 압축 및 S3 업로드 중: s3://{bucket}/{s3_key}")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        include_paths = [
            PROJECT_ROOT / "container",
            PROJECT_ROOT / "config.yaml",
        ]
        for include_path in include_paths:
            if include_path.is_dir():
                for file_path in include_path.rglob("*"):
                    if file_path.is_file():
                        arcname = file_path.relative_to(PROJECT_ROOT)
                        zf.write(file_path, arcname)
            elif include_path.is_file():
                zf.write(include_path, include_path.relative_to(PROJECT_ROOT))

    buffer.seek(0)
    s3.put_object(Bucket=bucket, Key=s3_key, Body=buffer.getvalue())
    print(f"소스 업로드 완료: s3://{bucket}/{s3_key}")
    return s3_key


def start_build(
    project_name: str,
    region: str,
    source_s3_bucket: str = "",
    source_s3_key: str = "",
) -> str:
    """CodeBuild 빌드를 시작합니다.

    Args:
        project_name: CodeBuild 프로젝트 이름.
        region: AWS 리전.
        source_s3_bucket: S3 소스 버킷 (S3 소스 방식 사용 시).
        source_s3_key: S3 소스 키 (S3 소스 방식 사용 시).

    Returns:
        CodeBuild 빌드 ID.
    """
    cb = boto3.client("codebuild", region_name=region)

    kwargs = {"projectName": project_name}

    if source_s3_bucket and source_s3_key:
        kwargs["sourceLocationOverride"] = f"{source_s3_bucket}/{source_s3_key}"
        kwargs["sourceTypeOverride"] = "S3"

    try:
        response = cb.start_build(**kwargs)
    except ClientError as e:
        if "does not exist" in str(e):
            print(f"오류: CodeBuild 프로젝트 '{project_name}'이 존재하지 않습니다.")
            print("  infra/deploy_stack.py를 먼저 실행하여 인프라를 배포하세요.")
        raise

    build_id = response["build"]["id"]
    print(f"빌드 시작: {project_name} (ID: {build_id})")
    return build_id


def wait_for_build(build_id: str, region: str, poll_interval: int = 30) -> str:
    """CodeBuild 빌드 완료를 기다립니다.

    Args:
        build_id: CodeBuild 빌드 ID.
        region: AWS 리전.
        poll_interval: 상태 확인 간격 (초).

    Returns:
        빌드 최종 상태 ("SUCCEEDED", "FAILED", "STOPPED").
    """
    cb = boto3.client("codebuild", region_name=region)

    print(f"빌드 완료 대기 중: {build_id}")

    while True:
        response = cb.batch_get_builds(ids=[build_id])
        build = response["builds"][0]
        status = build["buildStatus"]
        phase = build.get("currentPhase", "UNKNOWN")

        print(f"  상태: {status} | 현재 단계: {phase}")

        if status in ("SUCCEEDED", "FAILED", "STOPPED", "TIMED_OUT", "FAULT"):
            break

        time.sleep(poll_interval)

    if status == "SUCCEEDED":
        print(f"빌드 성공!")
    else:
        print(f"빌드 실패: {status}")
        # 로그 URL 출력
        logs = build.get("logs", {})
        group = logs.get("groupName", "")
        stream = logs.get("streamName", "")
        if group and stream:
            print(f"CloudWatch 로그: https://console.aws.amazon.com/cloudwatch/home?region={region}"
                  f"#logEvents:group={group};stream={stream}")

    return status


def update_config_with_ecr_uris(config: dict, region: str) -> None:
    """ECR URI를 config.yaml에 업데이트합니다."""
    import boto3
    sts = boto3.client("sts", region_name=region)
    account_id = sts.get_caller_identity()["Account"]

    config["ecr"]["training_uri"] = (
        f"{account_id}.dkr.ecr.{region}.amazonaws.com/groot-n16-training:latest"
    )
    config["ecr"]["inference_uri"] = (
        f"{account_id}.dkr.ecr.{region}.amazonaws.com/groot-n16-inference:latest"
    )

    CONFIG_PATH.write_text(
        yaml.dump(config, allow_unicode=True, default_flow_style=False),
        encoding="utf-8",
    )
    print(f"config.yaml ECR URI 업데이트 완료.")


def main() -> None:
    config = load_config()
    aws_cfg = config.get("aws", {})

    parser = argparse.ArgumentParser(
        description="CodeBuild로 GR00T 컨테이너 빌드 트리거",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python scripts/trigger_build.py --type all
  python scripts/trigger_build.py --type training --no-wait
  python scripts/trigger_build.py --type all --upload-source --bucket my-bucket
        """,
    )
    parser.add_argument(
        "--type",
        choices=["training", "inference", "all"],
        default="all",
        help="빌드할 컨테이너 타입 (기본값: all)",
    )
    parser.add_argument(
        "--region",
        default=aws_cfg.get("region", "ap-northeast-2"),
        help="AWS 리전",
    )
    parser.add_argument(
        "--bucket",
        default=aws_cfg.get("bucket_name", ""),
        help="S3 소스 업로드용 버킷 (--upload-source 사용 시 필요)",
    )
    parser.add_argument(
        "--upload-source",
        action="store_true",
        help="소스를 S3에 업로드하여 빌드 트리거 (GitHub 미연결 시 사용)",
    )
    parser.add_argument(
        "--no-wait",
        action="store_true",
        help="빌드 완료를 기다리지 않음 (백그라운드 실행)",
    )
    parser.add_argument(
        "--no-update-config",
        action="store_true",
        help="빌드 완료 후 config.yaml ECR URI 업데이트 건너뜀",
    )

    args = parser.parse_args()

    # 빌드할 프로젝트 목록 결정
    if args.type == "all":
        build_types = ["training", "inference"]
    else:
        build_types = [args.type]

    # S3 소스 업로드 (선택)
    source_s3_bucket = ""
    source_s3_key = ""
    if args.upload_source:
        if not args.bucket:
            print("오류: --upload-source 사용 시 --bucket이 필요합니다.")
            sys.exit(1)
        source_s3_key = upload_source_to_s3(args.bucket, args.region)
        source_s3_bucket = args.bucket

    # 빌드 시작
    build_ids = {}
    for build_type in build_types:
        project_name = PROJECT_NAMES[build_type]
        try:
            build_id = start_build(
                project_name,
                args.region,
                source_s3_bucket,
                source_s3_key,
            )
            build_ids[build_type] = build_id
        except ClientError as e:
            print(f"오류: {build_type} 빌드 시작 실패: {e}", file=sys.stderr)
            sys.exit(1)

    if args.no_wait:
        print("\n빌드가 백그라운드에서 실행 중입니다.")
        print("CloudWatch Logs에서 빌드 로그를 확인하세요:")
        for build_type, build_id in build_ids.items():
            print(f"  {build_type}: {build_id}")
        return

    # 빌드 완료 대기
    all_succeeded = True
    for build_type, build_id in build_ids.items():
        print(f"\n{build_type} 빌드 대기 중...")
        status = wait_for_build(build_id, args.region)
        if status != "SUCCEEDED":
            all_succeeded = False

    if all_succeeded:
        print("\n모든 빌드 성공!")
        if not args.no_update_config:
            update_config_with_ecr_uris(config, args.region)
        print("\n다음 단계:")
        print("  python pipeline/run_pipeline.py --embodiment-tag my_robot --dataset-s3-uri s3://...")
    else:
        print("\n일부 빌드 실패. CloudWatch 로그를 확인하세요.")
        sys.exit(1)


if __name__ == "__main__":
    main()
