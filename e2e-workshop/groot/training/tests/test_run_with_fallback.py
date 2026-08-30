"""Unit tests for run_with_fallback.py pure helpers and orchestration."""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def _stub_build_training_job(job_name="job-xyz"):
    """run_candidate가 부르는 build_training_job을 대체하는 컨텍스트 패치."""
    estimator = MagicMock()
    return patch(
        "run_with_fallback.run_training.build_training_job",
        return_value=(estimator, {"dataset": object()}, job_name, "us-east-1"),
    ), estimator


def test_pending_since_returns_latest_pending_transition():
    """SecondaryStatusTransitions 중 가장 나중의 Pending StartTime을 반환한다."""
    import run_with_fallback

    t0 = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    t1 = datetime(2026, 1, 1, 0, 5, 0, tzinfo=timezone.utc)
    t2 = datetime(2026, 1, 1, 0, 10, 0, tzinfo=timezone.utc)
    training = {
        "SecondaryStatusTransitions": [
            {"Status": "Starting", "StartTime": t0},
            {"Status": "Pending", "StartTime": t1},
            {"Status": "Pending", "StartTime": t2},
        ]
    }
    assert run_with_fallback.pending_since(training) == t2


def test_pending_since_returns_none_when_never_pending():
    """Pending 전이가 없으면 None."""
    import run_with_fallback

    training = {
        "SecondaryStatusTransitions": [
            {"Status": "Starting", "StartTime": datetime.now(timezone.utc)},
            {"Status": "Downloading", "StartTime": datetime.now(timezone.utc)},
        ]
    }
    assert run_with_fallback.pending_since(training) is None


def test_resolve_candidates_uses_cli_override_verbatim():
    """--instance-types가 주어지면 그대로 사용한다."""
    import run_with_fallback

    config = {"training": {"instance_type": "ml.g6e.12xlarge", "instance_fallbacks": ["ml.g5.12xlarge"]}}
    assert run_with_fallback.resolve_candidates(config, ["ml.p4d.24xlarge"]) == ["ml.p4d.24xlarge"]


def test_resolve_candidates_prepends_primary_to_fallbacks():
    """CLI 미지정 시 primary instance_type + instance_fallbacks 순서."""
    import run_with_fallback

    config = {"training": {"instance_type": "ml.g6e.12xlarge", "instance_fallbacks": ["ml.g5.12xlarge", "ml.g6.12xlarge"]}}
    assert run_with_fallback.resolve_candidates(config, None) == [
        "ml.g6e.12xlarge",
        "ml.g5.12xlarge",
        "ml.g6.12xlarge",
    ]


def test_resolve_candidates_without_fallbacks_returns_primary_only():
    """instance_fallbacks가 없으면 primary 하나만."""
    import run_with_fallback

    config = {"training": {"instance_type": "ml.g6e.12xlarge"}}
    assert run_with_fallback.resolve_candidates(config, None) == ["ml.g6e.12xlarge"]


def test_resolve_capacity_timeout_precedence():
    """CLI > config > 기본값 900 순서."""
    import run_with_fallback

    assert run_with_fallback.resolve_capacity_timeout({"training": {}}, 120) == 120
    assert run_with_fallback.resolve_capacity_timeout({"training": {"capacity_timeout_seconds": 600}}, None) == 600
    assert run_with_fallback.resolve_capacity_timeout({"training": {}}, None) == 900


def test_is_capacity_failure_true_when_not_started_and_capacity_reason():
    """학습 미시작 + 사유에 capacity 포함 → 폴백 대상."""
    import run_with_fallback

    assert run_with_fallback.is_capacity_failure(
        "Failed", "InsufficientInstanceCapacity: ...", training_started=False
    ) is True


def test_is_capacity_failure_false_when_training_already_started():
    """이미 학습이 시작됐다면 capacity 사유여도 폴백하지 않는다(실제 실패)."""
    import run_with_fallback

    assert run_with_fallback.is_capacity_failure(
        "Failed", "some capacity blip", training_started=True
    ) is False


def test_is_capacity_failure_false_for_non_capacity_reason():
    """capacity와 무관한 실패는 폴백 대상이 아니다."""
    import run_with_fallback

    assert run_with_fallback.is_capacity_failure(
        "Failed", "AlgorithmError: user script exited", training_started=False
    ) is False


# --- 오케스트레이션 상태 머신 (mock boto3) --------------------------------

def _run_candidate(client, job_name="job-xyz", timeout=900):
    import run_with_fallback

    build_patch, _est = _stub_build_training_job(job_name)
    with build_patch, patch("run_with_fallback.time.sleep"):
        return run_with_fallback.run_candidate(
            args=SimpleNamespace(),
            config={},
            client=client,
            instance_type="ml.g6e.12xlarge",
            capacity_timeout_seconds=timeout,
            poll_seconds=0,
        )


def test_run_candidate_stops_and_falls_back_on_pending_timeout():
    """Pending이 타임아웃을 넘으면 Job을 stop하고 None(폴백)을 반환한다."""
    old_pending = datetime.now(timezone.utc) - timedelta(seconds=2000)
    client = MagicMock()
    client.describe_training_job.side_effect = [
        {  # 아직 시작 안 됨 + 오래된 Pending → 타임아웃
            "TrainingJobStatus": "InProgress",
            "SecondaryStatus": "Pending",
            "SecondaryStatusTransitions": [{"Status": "Pending", "StartTime": old_pending}],
        },
        {"TrainingJobStatus": "Stopped"},  # _wait_until_terminal 폴링
    ]

    result = _run_candidate(client, timeout=900)

    assert result is None
    client.stop_training_job.assert_called_once_with(TrainingJobName="job-xyz")


def test_run_candidate_does_not_stop_job_that_left_pending():
    """Pending을 벗어나 Downloading 중이면(진행 중) 과거 Pending 시각이 오래됐어도 stop하지 않는다."""
    old_pending = datetime.now(timezone.utc) - timedelta(seconds=2000)
    client = MagicMock()
    client.describe_training_job.side_effect = [
        {  # 용량 확보 후 이미지 다운로드 중 — capacity 대기가 아님
            "TrainingJobStatus": "InProgress",
            "SecondaryStatus": "Downloading",
            "SecondaryStatusTransitions": [{"Status": "Pending", "StartTime": old_pending}],
        },
        {"TrainingJobStatus": "Completed", "TrainingStartTime": datetime.now(timezone.utc)},
    ]

    assert _run_candidate(client, timeout=900) == "job-xyz"
    client.stop_training_job.assert_not_called()


def test_run_candidate_returns_job_name_on_completion():
    """학습이 시작되고 Completed되면 job_name을 반환한다."""
    started = datetime.now(timezone.utc)
    client = MagicMock()
    client.describe_training_job.side_effect = [
        {"TrainingJobStatus": "InProgress", "TrainingStartTime": started,
         "SecondaryStatusTransitions": [{"Status": "Training", "StartTime": started}]},
        {"TrainingJobStatus": "Completed", "TrainingStartTime": started},
    ]

    assert _run_candidate(client) == "job-xyz"
    client.stop_training_job.assert_not_called()


def test_run_candidate_falls_back_on_capacity_failure_before_start():
    """시작 전 capacity 사유로 Failed면 폴백(None)."""
    client = MagicMock()
    client.describe_training_job.side_effect = [
        {"TrainingJobStatus": "Failed",
         "FailureReason": "InsufficientInstanceCapacity: no g6e",
         "SecondaryStatusTransitions": []},
    ]

    assert _run_candidate(client) is None


def test_run_candidate_raises_on_real_failure():
    """capacity와 무관한 실패는 예외를 던진다(폴백하지 않음)."""
    import pytest

    client = MagicMock()
    client.describe_training_job.side_effect = [
        {"TrainingJobStatus": "Failed",
         "FailureReason": "AlgorithmError: user script exited with code 1",
         "SecondaryStatusTransitions": []},
    ]

    with pytest.raises(RuntimeError, match="AlgorithmError"):
        _run_candidate(client)


def test_main_tries_next_candidate_until_success():
    """첫 후보가 용량 부족(None)이면 다음 후보로 넘어가 성공 시 종료한다."""
    import run_with_fallback

    config = {
        "aws": {"region": "us-east-1"},
        "training": {"instance_type": "ml.g6e.12xlarge",
                     "instance_fallbacks": ["ml.g5.12xlarge"]},
    }
    with patch("run_with_fallback.load_config", return_value=config), \
         patch("boto3.client", MagicMock()), \
         patch.object(sys, "argv", ["run_with_fallback.py", "--dataset-s3-uri", "s3://b/ds"]), \
         patch("run_with_fallback.run_candidate", side_effect=[None, "job-2"]) as rc:
        run_with_fallback.main()

    assert rc.call_count == 2
    assert [c.kwargs["instance_type"] for c in rc.call_args_list] == [
        "ml.g6e.12xlarge", "ml.g5.12xlarge",
    ]


def test_main_raises_when_all_candidates_exhausted():
    """모든 후보가 용량 부족이면 RuntimeError."""
    import pytest

    import run_with_fallback

    config = {
        "aws": {"region": "us-east-1"},
        "training": {"instance_type": "ml.g6e.12xlarge",
                     "instance_fallbacks": ["ml.g5.12xlarge"]},
    }
    with patch("run_with_fallback.load_config", return_value=config), \
         patch("boto3.client", MagicMock()), \
         patch.object(sys, "argv", ["run_with_fallback.py", "--dataset-s3-uri", "s3://b/ds"]), \
         patch("run_with_fallback.run_candidate", return_value=None), \
         pytest.raises(RuntimeError, match="용량을 확보하지 못"):
        run_with_fallback.main()
