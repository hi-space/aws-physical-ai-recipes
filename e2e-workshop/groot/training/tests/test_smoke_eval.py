"""smoke_eval.py의 GPU-불필요 순수 로직 단위 테스트."""
import json
import sys
from pathlib import Path

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
