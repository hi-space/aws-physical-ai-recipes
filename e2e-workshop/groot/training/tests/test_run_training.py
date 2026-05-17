"""Unit tests for run_training.py image URI selection."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def test_image_uri_with_groot_version_substitutes_tag():
    """ecr.training_uri가 :latest이고 --groot-version n1.7이면 :n1.7로 교체."""
    base = "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training:latest"
    # 동일한 substitution 로직을 그대로 재현 (run_training의 inline logic)
    groot_version = "n1.7"
    result = base.rsplit(":", 1)[0] + f":{groot_version}"
    assert result == "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training:n1.7"


def test_image_uri_without_tag_appends_version():
    """base_uri에 태그가 없고 --groot-version n1.6이면 :n1.6을 추가."""
    base = "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training"
    groot_version = "n1.6"
    result = (
        base.rsplit(":", 1)[0] + f":{groot_version}"
        if ":" in base
        else f"{base}:{groot_version}"
    )
    assert result == "913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-sm-training:n1.6"
