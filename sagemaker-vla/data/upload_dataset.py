#!/usr/bin/env python3
"""로컬 LeRobot v2 데이터셋을 검증하고 S3에 업로드합니다.

LeRobot v2 형식:
    my-dataset/
    ├── meta/
    │   ├── info.json         # 데이터셋 메타데이터 (로봇 타입, 액션 공간 등)
    │   ├── episodes.jsonl    # 에피소드 목록
    │   └── stats.json        # 데이터 통계
    ├── data/
    │   └── chunk-000/
    │       └── episode_000000.parquet
    └── videos/               # (선택) 비디오 관측
        └── chunk-000/
            └── episode_000000.mp4

사용법:
    python data/upload_dataset.py \
        --local-path ./my-robot-dataset \
        --bucket my-groot-artifacts

    # S3 접두사 지정:
    python data/upload_dataset.py \
        --local-path ./my-robot-dataset \
        --bucket my-groot-artifacts \
        --prefix datasets/my-robot-v1
"""

import argparse
import json
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


def validate_lerobot_dataset(local_path: str) -> None:
    """LeRobot v2 데이터셋 형식을 검증합니다.

    Args:
        local_path: 데이터셋 로컬 경로.

    Raises:
        ValueError: 형식이 올바르지 않은 경우.
    """
    path = Path(local_path)

    if not path.is_dir():
        raise ValueError(f"데이터셋 경로가 존재하지 않습니다: {local_path}")

    errors = []

    # meta/info.json 필수
    info_path = path / "meta" / "info.json"
    if not info_path.exists():
        errors.append("meta/info.json 파일이 없습니다.")
    else:
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            # 핵심 필드 확인
            for field in ["robot_type", "fps", "features"]:
                if field not in info:
                    errors.append(f"meta/info.json에 '{field}' 필드가 없습니다.")
        except json.JSONDecodeError as e:
            errors.append(f"meta/info.json 파싱 오류: {e}")

    # data/ 디렉토리 필수
    data_dir = path / "data"
    if not data_dir.exists():
        errors.append("data/ 디렉토리가 없습니다.")
    else:
        parquet_files = list(data_dir.rglob("*.parquet"))
        if not parquet_files:
            errors.append("data/ 디렉토리에 .parquet 파일이 없습니다.")
        else:
            print(f"  에피소드 파일: {len(parquet_files)}개")

    if errors:
        raise ValueError(
            "LeRobot v2 형식 검증 실패:\n" + "\n".join(f"  - {e}" for e in errors)
        )

    print("  LeRobot v2 형식 검증 통과.")


def upload_to_s3(local_path: str, bucket: str, prefix: str, region: str) -> str:
    """로컬 데이터셋 디렉토리를 S3에 업로드합니다.

    Args:
        local_path: 업로드할 로컬 디렉토리.
        bucket: S3 버킷 이름.
        prefix: S3 키 접두사.
        region: AWS 리전.

    Returns:
        업로드된 S3 URI.
    """
    s3 = boto3.client("s3", region_name=region)
    local = Path(local_path)

    all_files = [f for f in local.rglob("*") if f.is_file()]
    print(f"S3 업로드 시작: {len(all_files)}개 파일 → s3://{bucket}/{prefix}")

    for i, file_path in enumerate(all_files):
        relative = file_path.relative_to(local)
        s3_key = f"{prefix}/{relative}".replace("\\", "/")

        # 진행상황 출력 (100개마다)
        if i % 100 == 0 or i == len(all_files) - 1:
            print(f"  [{i+1}/{len(all_files)}] {relative}")

        try:
            s3.upload_file(
                str(file_path),
                bucket,
                s3_key,
                ExtraArgs={"ServerSideEncryption": "AES256"},
            )
        except ClientError as e:
            print(f"  업로드 실패: {file_path} → {e}", file=sys.stderr)
            raise

    s3_uri = f"s3://{bucket}/{prefix}"
    print(f"\nS3 업로드 완료: {s3_uri}")
    return s3_uri


def main() -> None:
    config = load_config()

    parser = argparse.ArgumentParser(
        description="LeRobot v2 데이터셋을 검증하고 S3에 업로드합니다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python data/upload_dataset.py --local-path ./my-dataset
  python data/upload_dataset.py --local-path ./my-dataset --bucket my-bucket --prefix datasets/my-robot-v1
  python data/upload_dataset.py --local-path ./my-dataset --skip-validation
        """,
    )
    parser.add_argument(
        "--local-path",
        required=True,
        help="업로드할 로컬 데이터셋 경로",
    )
    parser.add_argument(
        "--bucket",
        default=config.get("aws", {}).get("bucket_name", ""),
        help="S3 버킷 이름 (config.yaml의 aws.bucket_name 사용 가능)",
    )
    parser.add_argument(
        "--prefix",
        default=config.get("dataset", {}).get("s3_prefix", "datasets/my-robot"),
        help="S3 키 접두사 (기본값: datasets/my-robot)",
    )
    parser.add_argument(
        "--region",
        default=config.get("aws", {}).get("region", "ap-northeast-2"),
        help="AWS 리전 (기본값: ap-northeast-2)",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="LeRobot v2 형식 검증 건너뜀",
    )

    args = parser.parse_args()

    if not args.bucket:
        print("오류: S3 버킷 이름이 필요합니다.")
        print("  --bucket 옵션을 지정하거나 infra/deploy_stack.py를 먼저 실행하세요.")
        sys.exit(1)

    print(f"데이터셋 경로: {args.local_path}")

    # 1. 형식 검증
    if not args.skip_validation:
        print("LeRobot v2 형식 검증 중...")
        try:
            validate_lerobot_dataset(args.local_path)
        except ValueError as e:
            print(f"오류: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print("형식 검증 건너뜀.")

    # 2. S3 업로드
    try:
        s3_uri = upload_to_s3(args.local_path, args.bucket, args.prefix, args.region)
    except ClientError as e:
        print(f"S3 업로드 오류: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"\n완료! 데이터셋 S3 URI:")
    print(f"  {s3_uri}")
    print(f"\n이 URI를 학습 시 사용하세요:")
    print(f"  --dataset-s3-uri {s3_uri}")


if __name__ == "__main__":
    main()
