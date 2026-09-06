#!/usr/bin/env python3
"""GR00T SageMaker Training Job 산출물을 검증합니다.

`run_training.py` / `run_with_fallback.py`가 띄운 Training Job의 이름을 받아
검증합니다.

하드 검증 (실패 시 예외):
  1. TrainingJobStatus == Completed
  2. model.tar.gz (ModelArtifacts) S3 존재

Best-effort (존재 여부만 요약에 기록, 실패로 처리하지 않음):
  - export_s3_uri prefix의 비압축 export 산출물 (노트북 파이프라인 잡은
    models/에 남기지 않을 수 있음)
  - checkpoint_s3_uri prefix의 체크포인트 (lifecycle 기본 30일로 만료됨)
  - MLflow run/loss (GR00T는 HF Trainer 자동 MLflowCallback이라 Job↔run
    확정 매칭 태그가 없음)

사용법:
    python scripts/verify_training.py --job-name groot-finetune-2026-08-30-...
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

import yaml

DOMAIN_ROOT = Path(__file__).resolve().parents[2]      # groot/
CONFIG_PATH = DOMAIN_ROOT / "config.yaml"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def split_s3_uri(uri: str) -> tuple[str, str]:
    """s3://bucket/key... → (bucket, key) (뒤 슬래시 제거)."""
    parsed = urlparse(uri)
    return parsed.netloc, parsed.path.strip("/")


def export_uri_from_job(training: dict) -> str | None:
    """describe_training_job 결과의 하이퍼파라미터에서 export_s3_uri를 읽습니다.

    SageMaker가 값을 따옴표로 감쌀 수 있어 벗겨냅니다.
    """
    value = training.get("HyperParameters", {}).get("export_s3_uri")
    if value is None:
        return None
    return value.strip().strip('"')


def checkpoint_uri_from_job(training: dict) -> str | None:
    """CheckpointConfig.S3Uri를 반환합니다 (없으면 None)."""
    return training.get("CheckpointConfig", {}).get("S3Uri")


def _prefix_has_objects(s3, uri: str) -> bool:
    bucket, prefix = split_s3_uri(uri)
    resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1)
    return bool(resp.get("Contents"))


_NOT_FOUND_CODES = {"404", "NoSuchKey", "NotFound"}


def _object_exists(s3, uri: str) -> bool:
    """객체 존재 여부. 404류만 False로 보고, 403 등 다른 오류는 재발생시킵니다.

    (권한 오류를 '파일 없음'으로 오판하면 배포 문제를 놓치므로.)
    """
    from botocore.exceptions import ClientError

    bucket, key = split_s3_uri(uri)
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in _NOT_FOUND_CODES:
            return False
        raise


def _mlflow_summary(config: dict, region: str, job_name: str) -> dict:
    """MLflow run/loss를 best-effort로 조회합니다 (실패는 무시)."""
    mlflow_cfg = config.get("mlflow", {})
    tracking_arn = mlflow_cfg.get("tracking_server_arn", "")
    if not tracking_arn:
        return {"mlflow": "not_configured"}
    try:
        import mlflow

        mlflow.set_tracking_uri(tracking_arn)
        experiment_name = mlflow_cfg.get("experiment_name", "groot-sm-finetune")
        experiment = mlflow.get_experiment_by_name(experiment_name)
        if experiment is None:
            return {"mlflow": f"experiment_not_found:{experiment_name}"}
        # train.py 가 run 에 sagemaker.training_job_name 태그를 붙이므로 Job 으로 정확히 매칭한다.
        runs = mlflow.search_runs(
            [experiment.experiment_id],
            filter_string=f"tags.`sagemaker.training_job_name` = '{job_name}'",
        )
        matched = runs is not None and not runs.empty
        if not matched:
            runs = mlflow.search_runs([experiment.experiment_id])
        if runs is None or runs.empty:
            return {"mlflow": "no_runs"}
        loss_col = next(
            (c for c in ("metrics.loss", "metrics.train_loss") if c in runs), None
        )
        latest = runs.iloc[0]
        return {
            "mlflow_run_id": latest.get("run_id"),
            "mlflow_latest_loss": (
                latest[loss_col] if loss_col else None
            ),
            "mlflow_note": (
                "job 태그 매칭" if matched
                else "best-effort: job 태그 없는 run → 최신 run (구버전 train.py 실행)"
            ),
        }
    except Exception as exc:  # pragma: no cover - 네트워크/권한 변동성
        return {"mlflow": f"lookup_failed: {exc}"}


def verify(job_name: str, config: dict) -> dict:
    import boto3

    region = config.get("aws", {}).get("region", "us-east-1")
    sm = boto3.client("sagemaker", region_name=region)
    s3 = boto3.client("s3", region_name=region)

    training = sm.describe_training_job(TrainingJobName=job_name)

    status = training["TrainingJobStatus"]
    if status != "Completed":
        raise RuntimeError(f"Training Job이 Completed가 아닙니다: {status}")

    model_artifact = training.get("ModelArtifacts", {}).get("S3ModelArtifacts")
    if not model_artifact or not _object_exists(s3, model_artifact):
        raise RuntimeError(f"model.tar.gz를 찾을 수 없습니다: {model_artifact}")

    # export/checkpoint는 best-effort: 노트북 파이프라인 잡은 models/에 export를
    # 남기지 않을 수 있고, checkpoints/는 lifecycle(기본 30일)로 만료됩니다.
    # 따라서 하드 실패가 아니라 존재 여부만 요약에 기록합니다.
    export_uri = export_uri_from_job(training)
    export_present = bool(export_uri) and _prefix_has_objects(s3, export_uri)

    checkpoint_uri = checkpoint_uri_from_job(training)
    checkpoint_present = bool(checkpoint_uri) and _prefix_has_objects(s3, checkpoint_uri)

    summary = {
        "training_job": job_name,
        "training_status": status,
        "instance_type": training.get("ResourceConfig", {}).get("InstanceType"),
        "model_artifact": model_artifact,
        "export_s3_uri": export_uri,
        "export_present": export_present,
        "checkpoint_s3_uri": checkpoint_uri,
        "checkpoint_present": checkpoint_present,
    }
    summary.update(_mlflow_summary(config, region, job_name))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="GR00T Training Job 산출물 검증")
    parser.add_argument("--job-name", required=True, help="검증할 SageMaker Training Job 이름")
    parser.add_argument("--config", default=str(CONFIG_PATH), help="config.yaml 경로")
    args = parser.parse_args()

    config = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    try:
        summary = verify(args.job_name, config)
    except RuntimeError as exc:
        print(f"검증 실패: {exc}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
