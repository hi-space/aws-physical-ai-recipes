"""smoke_eval.py의 GPU-불필요 순수 로직 단위 테스트."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]  # groot/
sys.path.insert(0, str(ROOT / "pipeline"))


def test_check_action_pass():
    import smoke_eval
    r = smoke_eval.check_action([[0.0] * 7 for _ in range(16)], 7)
    assert r["passed"] == 1 and r["all_finite"] == 1 and r["action_shape"] == [16, 7]


def test_check_action_wrong_dim():
    import smoke_eval
    r = smoke_eval.check_action([[0.0] * 5 for _ in range(16)], 7)
    assert r["passed"] == 0


def test_check_action_nonfinite():
    import smoke_eval
    r = smoke_eval.check_action([[float("nan")] * 7], 7)
    assert r["passed"] == 0 and r["all_finite"] == 0


def test_write_report(tmp_path):
    import smoke_eval
    smoke_eval.write_report(str(tmp_path), {"passed": 1, "action_shape": [16, 7],
                                            "all_finite": 1, "error": ""})
    data = json.loads((tmp_path / "evaluation.json").read_text())
    assert data["smoke"]["passed"] == 1


def test_expected_action_dim_is_so101_single_arm_plus_gripper():
    """so101 실제 action_dim은 single_arm(5)+gripper(1)=6이어야 한다.

    inference_metadata.json의 train.py 기본값(action_dim=7)을 그대로 썼다면 건강한 so101
    체크포인트도 항상 게이트 fail이 됐을 회귀를 막는 테스트.
    """
    import smoke_eval
    assert smoke_eval.expected_action_dim() == 6


def test_check_action_passes_healthy_so101_action_with_derived_dim():
    """meta의 action_dim(7, train.py 기본값)이 아니라 expected_action_dim()(6)을 쓰면
    healthy한 so101 concatenated action([16, 6])이 게이트를 통과해야 한다."""
    import smoke_eval
    healthy_action = [[0.0] * 6 for _ in range(16)]
    r = smoke_eval.check_action(healthy_action, smoke_eval.expected_action_dim())
    assert r["passed"] == 1 and r["action_shape"] == [16, 6]


def test_main_tags_policy_load_or_infer_failure_with_clear_prefix(tmp_path, monkeypatch):
    """run_policy()(정책 로드/추론)가 실패하면 evaluation.json의 error에 "LOAD_OR_INFER_FAILURE:"
    접두사가 붙어야 한다 — check_action()의 shape 불일치(error="")와 구분되는지 확인하는 회귀 테스트.
    """
    import smoke_eval

    input_dir = tmp_path / "in"
    output_dir = tmp_path / "out"
    input_dir.mkdir()

    def boom(ckpt_dir, meta):
        raise RuntimeError("Gr00tPolicy ctor failed — UNVERIFIED spike assumption")

    monkeypatch.setattr(smoke_eval, "run_policy", boom)
    monkeypatch.setattr(
        sys, "argv",
        ["smoke_eval.py", "--input-dir", str(input_dir), "--output-dir", str(output_dir)])

    with pytest.raises(SystemExit) as exc_info:
        smoke_eval.main()
    assert exc_info.value.code == 0

    data = json.loads((output_dir / "evaluation.json").read_text())
    assert data["smoke"]["passed"] == 0
    assert data["smoke"]["error"].startswith("LOAD_OR_INFER_FAILURE:")
