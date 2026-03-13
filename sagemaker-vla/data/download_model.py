#!/usr/bin/env python3
"""HuggingFace에서 GR00T-N1.6-3B 모델을 다운로드하고 S3에 업로드합니다.

사용법:
    python data/download_model.py \
        --bucket my-groot-artifacts \
        --region ap-northeast-2

    # HuggingFace 토큰이 필요한 경우 (게이트된 모델):
    python data/download_model.py \
        --bucket my-groot-artifacts \
        --hf-token hf_xxxx

    # config.yaml에서 설정 자동 로드:
    python data/download_model.py

참고:
    - GR00T-N1.6-3B 모델은 약 6GB입니다. 업로드에 수 분이 소요될 수 있습니다.
    - 다운로드에는 huggingface_hub 라이브러리가 필요합니다 (requirements-dev.txt).
    - HuggingFace 계정이 없어도 공개 모델은 다운로드 가능합니다.
"""

import argparse
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
    """config.yaml에서 설정을 로드합니다."""
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def download_from_huggingface(model_id: str, local_dir: str, hf_token: str = "") -> None:
    """HuggingFace Hub에서 모델을 다운로드합니다.

    Args:
        model_id: HuggingFace 모델 ID (예: nvidia/GR00T-N1.6-3B).
        local_dir: 로컬 저장 디렉토리.
        hf_token: HuggingFace API 토큰 (선택, 게이트된 모델에 필요).
    """
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("오류: huggingface_hub이 설치되지 않았습니다.")
        print("  pip install huggingface_hub")
        sys.exit(1)

    print(f"HuggingFace에서 다운로드 중: {model_id}")
    print(f"저장 위치: {local_dir}")

    kwargs = {
        "repo_id": model_id,
        "local_dir": local_dir,
        "ignore_patterns": ["*.msgpack", "flax_model*", "rust_model*", "tf_model*"],
    }
    if hf_token:
        kwargs["token"] = hf_token

    snapshot_download(**kwargs)
    print(f"다운로드 완료: {local_dir}")


def upload_to_s3(local_dir: str, bucket: str, prefix: str, region: str) -> str:
    """로컬 디렉토리를 S3에 업로드합니다.

    Args:
        local_dir: 업로드할 로컬 디렉토리.
        bucket: S3 버킷 이름.
        prefix: S3 키 접두사 (예: models/groot-n16).
        region: AWS 리전.

    Returns:
        업로드된 S3 URI (s3://bucket/prefix).
    """
    s3 = boto3.client("s3", region_name=region)
    local_path = Path(local_dir)

    files = list(local_path.rglob("*"))
    files_to_upload = [f for f in files if f.is_file()]

    print(f"S3 업로드 시작: {len(files_to_upload)}개 파일 → s3://{bucket}/{prefix}")

    for i, file_path in enumerate(files_to_upload):
        relative = file_path.relative_to(local_path)
        s3_key = f"{prefix}/{relative}".replace("\\", "/")

        print(f"  [{i+1}/{len(files_to_upload)}] {relative} → s3://{bucket}/{s3_key}")

        try:
            s3.upload_file(
                str(file_path),
                bucket,
                s3_key,
                ExtraArgs={"ServerSideEncryption": "AES256"},
            )
        except ClientError as e:
            print(f"  업로드 실패: {e}", file=sys.stderr)
            raise

    s3_uri = f"s3://{bucket}/{prefix}"
    print(f"\nS3 업로드 완료: {s3_uri}")
    return s3_uri


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


def main() -> None:
    config = load_config()

    parser = argparse.ArgumentParser(
        description="HuggingFace에서 GR00T 모델을 다운로드하고 S3에 업로드합니다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python data/download_model.py
  python data/download_model.py --bucket my-bucket --model-id nvidia/GR00T-N1.6-3B
  python data/download_model.py --hf-token hf_xxxx
        """,
    )
    parser.add_argument(
        "--model-id",
        default=config.get("model", {}).get("hf_model_id", "nvidia/GR00T-N1.6-3B"),
        help="HuggingFace 모델 ID (기본값: nvidia/GR00T-N1.6-3B)",
    )
    parser.add_argument(
        "--bucket",
        default=config.get("aws", {}).get("bucket_name", ""),
        help="S3 버킷 이름 (config.yaml의 aws.bucket_name 사용 가능)",
    )
    parser.add_argument(
        "--prefix",
        default=config.get("model", {}).get("s3_prefix", "models/groot-n16"),
        help="S3 키 접두사 (기본값: models/groot-n16)",
    )
    parser.add_argument(
        "--region",
        default=config.get("aws", {}).get("region", "ap-northeast-2"),
        help="AWS 리전 (기본값: ap-northeast-2)",
    )
    parser.add_argument(
        "--hf-token",
        default="",
        help="HuggingFace API 토큰 (게이트된 모델에 필요). 미지정 시 SSM /groot/hf-token 참조.",
    )
    parser.add_argument(
        "--local-dir",
        default="",
        help="모델을 저장할 로컬 디렉토리 (기본값: 임시 디렉토리)",
    )
    parser.add_argument(
        "--skip-upload",
        action="store_true",
        help="S3 업로드를 건너뜀 (로컬 다운로드만 수행)",
    )

    args = parser.parse_args()

    if not args.bucket and not args.skip_upload:
        print("오류: S3 버킷 이름이 필요합니다.")
        print("  --bucket 옵션을 지정하거나 infra/deploy_stack.py를 먼저 실행하세요.")
        sys.exit(1)

    # HuggingFace 토큰: 인수 → SSM → 환경변수 순서로 확인
    hf_token = args.hf_token
    if not hf_token:
        hf_token = get_hf_token_from_ssm(args.region)
    if not hf_token:
        hf_token = os.environ.get("HF_TOKEN", "")

    # 다운로드 디렉토리 설정
    use_temp = not args.local_dir
    if use_temp:
        tmp_dir = tempfile.mkdtemp(prefix="groot-model-")
        local_dir = tmp_dir
        print(f"임시 디렉토리 사용: {local_dir}")
    else:
        local_dir = args.local_dir
        Path(local_dir).mkdir(parents=True, exist_ok=True)

    try:
        # 1. HuggingFace에서 다운로드
        download_from_huggingface(args.model_id, local_dir, hf_token)

        # 2. S3에 업로드
        if not args.skip_upload:
            s3_uri = upload_to_s3(local_dir, args.bucket, args.prefix, args.region)
            print(f"\n완료! 베이스 모델 S3 URI:")
            print(f"  {s3_uri}")
            print(f"\n이 URI를 학습 시 사용하세요:")
            print(f"  --base-model-s3-uri {s3_uri}")
        else:
            print(f"\n로컬 다운로드 완료: {local_dir}")

    finally:
        # 임시 디렉토리 정리
        if use_temp and not args.skip_upload:
            import shutil
            shutil.rmtree(local_dir, ignore_errors=True)
            print(f"임시 디렉토리 정리 완료.")


if __name__ == "__main__":
    main()
