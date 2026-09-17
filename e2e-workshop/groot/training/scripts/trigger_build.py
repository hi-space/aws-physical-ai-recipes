#!/usr/bin/env python3
"""CodeBuild로 GR00T 학습 컨테이너 이미지를 다시 빌드하고 ECR에 푸시합니다.

GrootFinetune 스택은 배포 시 `training/container/` 를 S3 asset 으로 올려 CodeBuild
(`groot-sm-training-build`)를 자동으로 시작하므로, 평소에는 이 스크립트가 필요 없습니다
(모듈 3 §3.4 는 상태 확인만 합니다). 이 스크립트는 로컬에서 Dockerfile 을 고친 뒤 그 내용으로
다시 빌드할 때 씁니다: `training/container/` 를 zip 으로 올리고 sourceLocationOverride 로
CodeBuild 를 시작합니다. 로컬 Docker 는 필요 없고, 빌드 로그는 CloudWatch Logs 에 남습니다.

사전 조건:
    - GrootFinetune 스택 배포 + update-config.ts 실행 (config.yaml 에 aws.bucket_name 등이 채워짐)

사용법:
    # 학습 컨테이너 재빌드 (완료까지 대기)
    python training/scripts/trigger_build.py --type training

    # 빌드 완료까지 대기하지 않음
    python training/scripts/trigger_build.py --type training --no-wait

    # 다른 버킷으로 소스 업로드
    python training/scripts/trigger_build.py --type training --bucket my-bucket
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

DOMAIN_ROOT = Path(__file__).resolve().parents[2]      # groot/
TRAINING_ROOT = Path(__file__).resolve().parents[1]    # groot/training/
CONFIG_PATH = DOMAIN_ROOT / "config.yaml"

# 업로드하는 zip 의 루트 디렉터리 (CDK 의 S3 asset 과 같은 레이아웃: Dockerfile/buildspec.yml 이 루트).
SOURCE_DIRS = {
    "training": TRAINING_ROOT / "container",
}

# CodeBuild 프로젝트별 buildspec 경로 (zip 루트 기준 상대 경로)
BUILDSPEC_PATHS = {
    "training": "buildspec.yml",
}


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def resolve_project_names(config: dict) -> dict:
    """config.yaml에서 CodeBuild 프로젝트 이름을 읽음.

    update-config.ts가 스택 outputs의 이름을 config.yaml에 기록하므로,
    여기서는 단순히 그 값을 사용한다. 누락 시 고정 기본값으로 폴백
    (CodeBuild 프로젝트는 계정당 1개, 이름 고정).
    """
    cb = config.get("codebuild", {}) or {}
    return {
        "training": cb.get("training_project") or "groot-sm-training-build",
    }


def build_source_zip(source_dir: Path) -> bytes:
    """source_dir 의 내용을 zip 루트에 놓은 zip 바이트를 만든다 (CDK S3 asset 과 같은 레이아웃).

    __pycache__ / *.pyc 는 제외한다. Dockerfile 은 COPY 를 하지 않으므로 train.py 등이 들어가도
    이미지 내용은 바뀌지 않지만, buildspec.yml 과 Dockerfile 이 루트에 있어야 한다.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(source_dir.rglob("*")):
            if not file_path.is_file():
                continue
            if "__pycache__" in file_path.parts or file_path.suffix == ".pyc":
                continue
            zf.write(file_path, file_path.relative_to(source_dir))
    return buffer.getvalue()


def upload_source_to_s3(bucket: str, region: str, source_dir: Path = None) -> str:
    """training/container 디렉터리를 zip으로 압축하여 S3에 업로드합니다.

    CodeBuild 의 sourceLocationOverride(S3) 로 쓰입니다.

    Args:
        bucket: S3 버킷 이름.
        region: AWS 리전.
        source_dir: zip 루트가 될 디렉터리 (기본 training/container).

    Returns:
        업로드된 S3 키.
    """
    source_dir = source_dir or SOURCE_DIRS["training"]
    s3 = boto3.client("s3", region_name=region)
    timestamp = int(time.time())
    s3_key = f"codebuild-source/groot-sm-{timestamp}.zip"

    print(f"소스 코드 압축 및 S3 업로드 중: {source_dir} -> s3://{bucket}/{s3_key}")
    s3.put_object(Bucket=bucket, Key=s3_key, Body=build_source_zip(source_dir))
    print(f"소스 업로드 완료: s3://{bucket}/{s3_key}")
    return s3_key


def start_build(
    project_name: str,
    region: str,
    source_s3_bucket: str = "",
    source_s3_key: str = "",
    buildspec_path: str = "",
    environment_overrides: list = None,
) -> str:
    """CodeBuild 빌드를 시작합니다.

    Args:
        project_name: CodeBuild 프로젝트 이름.
        region: AWS 리전.
        source_s3_bucket: S3 소스 버킷 (S3 소스 방식 사용 시).
        source_s3_key: S3 소스 키 (S3 소스 방식 사용 시).
        buildspec_path: buildspec 파일 경로 (S3 소스 내 상대 경로).
        environment_overrides: [{"name": "...", "value": "...", "type": "PLAINTEXT"}] 형태.

    Returns:
        CodeBuild 빌드 ID.
    """
    cb = boto3.client("codebuild", region_name=region)

    kwargs = {"projectName": project_name}

    if source_s3_bucket and source_s3_key:
        kwargs["sourceLocationOverride"] = f"{source_s3_bucket}/{source_s3_key}"
        kwargs["sourceTypeOverride"] = "S3"
        if buildspec_path:
            kwargs["buildspecOverride"] = buildspec_path

    if environment_overrides:
        kwargs["environmentVariablesOverride"] = environment_overrides

    try:
        response = cb.start_build(**kwargs)
    except ClientError as e:
        if "does not exist" in str(e):
            print(f"오류: CodeBuild 프로젝트 '{project_name}'이 존재하지 않습니다.")
            print("  infra/deploy_stack.py를 먼저 실행하여 인프라를 배포하세요.")
        raise

    build_id = response["build"]["id"]
    print(f"빌드 시작: {project_name} (ID: {build_id})")
    if environment_overrides:
        for ev in environment_overrides:
            print(f"  override: {ev['name']}={ev['value']}")
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

    # ECR 리포지토리는 계정당 1개, 이름 고정(groot-sm-training).
    config["ecr"]["training_uri"] = (
        f"{account_id}.dkr.ecr.{region}.amazonaws.com/groot-sm-training:latest"
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
        description="CodeBuild로 GR00T 학습 컨테이너 재빌드 (배포 시 자동 빌드된 이미지를 로컬 Dockerfile 로 다시 빌드)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python training/scripts/trigger_build.py --type training
  python training/scripts/trigger_build.py --type training --no-wait
  python training/scripts/trigger_build.py --type training --bucket my-bucket
        """,
    )
    parser.add_argument(
        "--type",
        choices=["training"],
        default="training",
        help="빌드할 컨테이너 타입 (현재 training만 지원 — inference 트랙 제거됨)",
    )
    parser.add_argument(
        "--region",
        default=aws_cfg.get("region", "us-east-1"),
        help="AWS 리전",
    )
    parser.add_argument(
        "--bucket",
        default=aws_cfg.get("bucket_name", ""),
        help="S3 소스 업로드용 버킷 (--upload-source 사용 시 필요)",
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
    parser.add_argument(
        "--groot-version",
        choices=["n1.6", "n1.7"],
        default=None,
        help="학습 컨테이너에 사용할 GR00T 버전. 미지정 시 CodeBuild 프로젝트 디폴트(n1.6) 사용.",
    )

    args = parser.parse_args()

    # 빌드할 프로젝트 목록 결정 (inference 트랙 제거 후 training만 존재)
    build_types = ["training"]

    # 로컬 training/container 를 S3 에 올려 프로젝트 기본 소스(CDK asset) 대신 쓰게 한다.
    source_s3_bucket = ""
    source_s3_key = ""
    if not args.bucket:
        print("오류: --bucket이 필요합니다. (config.yaml의 aws.bucket_name 또는 --bucket 옵션)")
        sys.exit(1)
    source_s3_key = upload_source_to_s3(args.bucket, args.region, SOURCE_DIRS["training"])
    source_s3_bucket = args.bucket

    # 빌드 시작
    project_names = resolve_project_names(config)
    build_ids = {}
    for build_type in build_types:
        project_name = project_names[build_type]
        buildspec_path = BUILDSPEC_PATHS.get(build_type, "")

        # GROOT_VERSION override는 학습 빌드에만 적용
        env_overrides = None
        if build_type == "training" and args.groot_version:
            base_model = (
                "nvidia/GR00T-N1.6-3B" if args.groot_version == "n1.6"
                else "nvidia/GR00T-N1.7-3B"
            )
            env_overrides = [
                {"name": "GROOT_VERSION", "value": args.groot_version, "type": "PLAINTEXT"},
                {"name": "BASE_MODEL_PATH", "value": base_model, "type": "PLAINTEXT"},
            ]

        try:
            build_id = start_build(
                project_name,
                args.region,
                source_s3_bucket,
                source_s3_key,
                buildspec_path,
                environment_overrides=env_overrides,
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
        print("  code-server에서 notebooks/02_sagemaker_pipeline.ipynb를 열어 학습 파이프라인을 실행하세요.")
    else:
        print("\n일부 빌드 실패. CloudWatch 로그를 확인하세요.")
        sys.exit(1)


if __name__ == "__main__":
    main()
