#!/usr/bin/env python3
"""GPU 용량 부족 시 인스턴스 타입을 바꿔가며 재시도하는 학습 실행기.

`run_training.py`가 띄우는 단일 SageMaker Training Job을 대상으로,
후보 인스턴스 타입을 순차 시도합니다. 어떤 타입이 `Pending`(용량 대기)에
`capacity_timeout_seconds`를 초과하면 그 Job을 중단하고 다음 후보로 넘어갑니다.
폴백은 항상 on-demand로 실행합니다 (spot 용량 변동을 폴백 판단에서 배제).

사용법:
    python scripts/run_with_fallback.py \\
        --dataset-s3-uri s3://my-bucket/datasets/leisaac-pick-orange \\
        --instance-types ml.g5.12xlarge ml.g6e.12xlarge \\
        --capacity-timeout-seconds 900

    # config.yaml의 training.instance_type + instance_fallbacks 사용:
    python scripts/run_with_fallback.py --dataset-s3-uri s3://.../ds
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

TRAINING_ROOT = Path(__file__).resolve().parents[1]    # groot/training/
DOMAIN_ROOT = Path(__file__).resolve().parents[2]      # groot/
CONFIG_PATH = DOMAIN_ROOT / "config.yaml"

sys.path.insert(0, str(TRAINING_ROOT / "scripts"))
import run_training  # noqa: E402

TERMINAL_TRAINING_STATUSES = {"Completed", "Failed", "Stopped"}
DEFAULT_CAPACITY_TIMEOUT = 900


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def pending_since(training: dict) -> datetime | None:
    """가장 나중의 `Pending` 전이 시각을 반환합니다 (없으면 None)."""
    for transition in reversed(training.get("SecondaryStatusTransitions", [])):
        if transition["Status"] == "Pending":
            return transition["StartTime"]
    return None


def resolve_candidates(config: dict, cli_instance_types: list[str] | None) -> list[str]:
    """시도할 인스턴스 타입 목록을 결정합니다.

    CLI 지정이 있으면 그대로, 없으면 primary instance_type + instance_fallbacks.
    """
    if cli_instance_types:
        return list(cli_instance_types)
    training = config.get("training", {})
    primary = training["instance_type"]
    return [primary, *training.get("instance_fallbacks", [])]


def resolve_capacity_timeout(config: dict, cli_value: int | None) -> int:
    """용량 타임아웃(초)을 결정합니다: CLI > config > 기본값 900."""
    if cli_value is not None:
        return cli_value
    return config.get("training", {}).get(
        "capacity_timeout_seconds", DEFAULT_CAPACITY_TIMEOUT
    )


def is_capacity_failure(status: str, reason: str, training_started: bool) -> bool:
    """터미널 실패가 '용량 부족'으로 폴백해야 할 케이스인지 판단합니다.

    학습이 이미 시작된 뒤의 실패는 실제 오류이므로 폴백하지 않습니다.
    """
    if status not in {"Failed", "Stopped"} or training_started:
        return False
    return "capacity" in (reason or "").lower()


def run_candidate(
    *,
    args: argparse.Namespace,
    config: dict,
    client,
    instance_type: str,
    capacity_timeout_seconds: int,
    poll_seconds: int,
) -> str | None:
    """한 인스턴스 타입으로 Training Job을 띄우고 감시합니다.

    Returns:
        성공 시 job_name, 용량 부족으로 폴백해야 하면 None.
    Raises:
        RuntimeError: 용량과 무관한 실제 실패.
    """
    estimator, inputs, job_name, _region = run_training.build_training_job(
        args, config, instance_type=instance_type, use_spot=False
    )
    estimator.fit(inputs=inputs, job_name=job_name, wait=False)
    print(json.dumps({"instance_type": instance_type, "job_name": job_name}), flush=True)

    training_started = False
    while True:
        training = client.describe_training_job(TrainingJobName=job_name)
        status = training["TrainingJobStatus"]
        if training.get("TrainingStartTime"):
            training_started = True

        pending_start = pending_since(training)
        # 지금도 용량 대기(Pending) 중일 때만 폴백을 판단한다. Downloading/Training
        # 등으로 진행 중이면 과거 Pending 시각이 오래됐어도 중단하지 않는다.
        if (
            not training_started
            and training.get("SecondaryStatus") == "Pending"
            and pending_start is not None
        ):
            elapsed = (datetime.now(timezone.utc) - pending_start).total_seconds()
            if elapsed >= capacity_timeout_seconds:
                print(
                    f"{instance_type} 용량 대기 {int(elapsed)}s 초과 → Job 중단",
                    flush=True,
                )
                client.stop_training_job(TrainingJobName=job_name)
                _wait_until_terminal(client, job_name, poll_seconds)
                return None

        if status == "Completed":
            return job_name
        if status in {"Failed", "Stopped"}:
            reason = training.get("FailureReason", "unknown failure")
            if is_capacity_failure(status, reason, training_started):
                print(f"{instance_type} 용량 부족: {reason}", flush=True)
                return None
            raise RuntimeError(f"Training Job {status}: {reason}")
        time.sleep(poll_seconds)


def _wait_until_terminal(client, job_name: str, poll_seconds: int) -> None:
    while True:
        status = client.describe_training_job(TrainingJobName=job_name)["TrainingJobStatus"]
        if status in TERMINAL_TRAINING_STATUSES:
            return
        time.sleep(poll_seconds)


def build_arg_parser(config: dict) -> argparse.ArgumentParser:
    """run_training의 공통 파서에 폴백 전용 인자를 추가합니다."""
    parser = run_training.build_arg_parser(config)
    parser.add_argument(
        "--instance-types", nargs="+",
        help="시도할 인스턴스 타입 목록 (미지정 시 config의 instance_type + instance_fallbacks)",
    )
    parser.add_argument(
        "--capacity-timeout-seconds", type=int,
        help="Pending(용량 대기) 허용 시간(초). 초과 시 다음 후보로 폴백 (기본 900)",
    )
    parser.add_argument(
        "--poll-seconds", type=int, default=30,
        help="Training Job 상태 폴링 간격(초)",
    )
    return parser


def main() -> None:
    import boto3

    config = load_config()
    args = build_arg_parser(config).parse_args()

    candidates = resolve_candidates(config, args.instance_types)
    capacity_timeout = resolve_capacity_timeout(config, args.capacity_timeout_seconds)
    region = args.region or config.get("aws", {}).get("region", "us-east-1")
    client = boto3.client("sagemaker", region_name=region)

    print(f"후보 인스턴스 타입: {', '.join(candidates)} (용량 타임아웃 {capacity_timeout}s)")

    for instance_type in candidates:
        job_name = run_candidate(
            args=args,
            config=config,
            client=client,
            instance_type=instance_type,
            capacity_timeout_seconds=capacity_timeout,
            poll_seconds=args.poll_seconds,
        )
        if job_name:
            print(
                json.dumps({"job_name": job_name, "instance_type": instance_type}),
                flush=True,
            )
            return
    raise RuntimeError(f"용량을 확보하지 못했습니다: {', '.join(candidates)}")


if __name__ == "__main__":
    main()
