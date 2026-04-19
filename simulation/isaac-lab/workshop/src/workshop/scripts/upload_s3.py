"""Upload local directory to S3 (dataset, checkpoint, or model)."""
import argparse
import os
from pathlib import Path

import boto3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload to S3")
    parser.add_argument("--local_path", required=True, help="Local directory or file to upload")
    parser.add_argument("--bucket", required=True, help="S3 bucket name")
    parser.add_argument("--s3_prefix", required=True, help="S3 key prefix (e.g. datasets/so101)")
    parser.add_argument("--region", default="us-east-1", help="AWS region")
    return parser.parse_args()


def main():
    args = parse_args()
    local_path = Path(args.local_path)
    s3 = boto3.client("s3", region_name=args.region)

    if local_path.is_file():
        key = f"{args.s3_prefix}/{local_path.name}"
        print(f"Uploading {local_path} → s3://{args.bucket}/{key}")
        s3.upload_file(str(local_path), args.bucket, key)
    elif local_path.is_dir():
        file_count = 0
        for root, _, files in os.walk(local_path):
            for fname in files:
                fpath = Path(root) / fname
                relative = fpath.relative_to(local_path)
                key = f"{args.s3_prefix}/{relative}"
                s3.upload_file(str(fpath), args.bucket, key)
                file_count += 1
        print(f"Uploaded {file_count} files → s3://{args.bucket}/{args.s3_prefix}/")
    else:
        raise FileNotFoundError(f"{local_path} does not exist")

    print(f"S3 URI: s3://{args.bucket}/{args.s3_prefix}")


if __name__ == "__main__":
    main()
