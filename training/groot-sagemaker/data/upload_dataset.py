#!/usr/bin/env python3
"""LeRobot 데이터셋을 검증하고 S3에 업로드합니다.

v3 형식 데이터셋은 자동으로 v2.1로 변환한 뒤 업로드합니다.
(GR00T 파인튜닝에는 LeRobot v2 형식이 필요합니다.)

사용법:
    # 로컬 데이터셋 업로드:
    python data/upload_dataset.py \
        --local-path ./my-robot-dataset \
        --bucket my-groot-artifacts

    # S3 접두사 지정:
    python data/upload_dataset.py \
        --local-path ./my-robot-dataset \
        --bucket my-groot-artifacts \
        --prefix datasets/my-robot-v1

    # HuggingFace 데이터셋 다운로드 후 업로드 (v3이면 자동 변환):
    python data/upload_dataset.py \
        --hf-dataset-id lerobot/aloha_static_screw_driver \
        --bucket my-groot-artifacts
"""

import argparse
import json
import os
import sys
import tempfile
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


def download_hf_dataset(dataset_id: str, local_dir: str, hf_token: str = "") -> str:
    """HuggingFace Hub에서 LeRobot 데이터셋을 다운로드합니다.

    Args:
        dataset_id: HuggingFace 데이터셋 ID (예: lerobot/aloha_sim_transfer_cube_human).
        local_dir: 로컬 저장 디렉토리.
        hf_token: HuggingFace API 토큰 (선택, 비공개 데이터셋에 필요).

    Returns:
        다운로드된 로컬 경로.
    """
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("오류: huggingface_hub이 설치되지 않았습니다.")
        print("  pip install huggingface_hub")
        sys.exit(1)

    print(f"HuggingFace에서 데이터셋 다운로드 중: {dataset_id}")
    print(f"저장 위치: {local_dir}")

    kwargs = {
        "repo_id": dataset_id,
        "repo_type": "dataset",
        "local_dir": local_dir,
    }
    if hf_token:
        kwargs["token"] = hf_token

    snapshot_download(**kwargs)
    print(f"데이터셋 다운로드 완료: {local_dir}")
    return local_dir


def get_hf_token_from_ssm(region: str) -> str:
    """SSM Parameter Store에서 HuggingFace 토큰을 가져옵니다."""
    try:
        ssm = boto3.client("ssm", region_name=region)
        response = ssm.get_parameter(Name="/groot/hf-token", WithDecryption=True)
        value = response["Parameter"]["Value"]
        if value.startswith("PLACEHOLDER"):
            return ""
        return value
    except Exception:
        return ""


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

    # tasks.jsonl 필수 — 없으면 자동 생성
    from convert_v3_to_v2 import ensure_tasks_jsonl

    if ensure_tasks_jsonl(local_path):
        print("  tasks.jsonl 없음 → 기본 파일 자동 생성.")
    else:
        print("  tasks.jsonl 확인 완료.")

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
  # 로컬 데이터셋 업로드 (v3이면 자동 변환):
  python data/upload_dataset.py --local-path ./my-dataset
  python data/upload_dataset.py --local-path ./my-dataset --prefix datasets/my-robot-v1

  # HuggingFace 실제 로봇 데이터셋 다운로드 후 업로드:
  python data/upload_dataset.py --hf-dataset-id lerobot/aloha_static_screw_driver
  python data/upload_dataset.py --hf-dataset-id lerobot/aloha_static_screw_driver --hf-token hf_xxxx
        """,
    )

    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument(
        "--local-path",
        help="업로드할 로컬 데이터셋 경로",
    )
    source_group.add_argument(
        "--hf-dataset-id",
        help="HuggingFace 데이터셋 ID (예: lerobot/aloha_sim_transfer_cube_human)",
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
        "--hf-token",
        default="",
        help="HuggingFace API 토큰 (비공개 데이터셋에 필요). 미지정 시 SSM /groot/hf-token 참조.",
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

    # HuggingFace 데이터셋 다운로드 모드
    use_temp = False
    if args.hf_dataset_id:
        # HuggingFace 토큰: 인수 → SSM → 환경변수 순서로 확인
        hf_token = args.hf_token
        if not hf_token:
            hf_token = get_hf_token_from_ssm(args.region)
        if not hf_token:
            hf_token = os.environ.get("HF_TOKEN", "")

        use_temp = True
        tmp_dir = tempfile.mkdtemp(prefix="groot-dataset-")
        local_path = tmp_dir
        print(f"임시 디렉토리 사용: {local_path}")
        download_hf_dataset(args.hf_dataset_id, local_path, hf_token)
    else:
        local_path = args.local_path

    print(f"데이터셋 경로: {local_path}")

    try:
        # 0. v3 → v2 자동 변환
        sys.path.insert(0, str(Path(__file__).parent))
        from convert_v3_to_v2 import is_v3_dataset, convert_v3_to_v2

        if is_v3_dataset(local_path):
            print("LeRobot v3 형식 감지 → v2.1로 자동 변환합니다.")
            convert_v3_to_v2(local_path)

        # 1. 형식 검증
        if not args.skip_validation:
            print("LeRobot v2 형식 검증 중...")
            try:
                validate_lerobot_dataset(local_path)
            except ValueError as e:
                print(f"오류: {e}", file=sys.stderr)
                sys.exit(1)
        else:
            print("형식 검증 건너뜀.")

        # 2. S3 업로드
        try:
            s3_uri = upload_to_s3(local_path, args.bucket, args.prefix, args.region)
        except ClientError as e:
            print(f"S3 업로드 오류: {e}", file=sys.stderr)
            sys.exit(1)

        print(f"\n완료! 데이터셋 S3 URI:")
        print(f"  {s3_uri}")
        print(f"\n이 URI를 학습 시 사용하세요:")
        print(f"  --dataset-s3-uri {s3_uri}")
    finally:
        if use_temp:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)
            print("임시 디렉토리 정리 완료.")


if __name__ == "__main__":
    main()
