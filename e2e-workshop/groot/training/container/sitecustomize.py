"""Python startup hook — GR00T가 TrainingArguments(report_to=...)에 mlflow를
끼울 자리를 만들지 않으므로, transformers TrainingArguments.__post_init__에서
후처리합니다 (MLFLOW_TRACKING_URI가 설정된 경우에만):

- report_to 에 'mlflow' 추가 → HF MLflowCallback 활성화
- run_name 이 HF 기본값(output_dir, 즉 /opt/ml/checkpoints)이면 MLFLOW_RUN_NAME
  (train.py 가 SageMaker Training Job 이름으로 설정)으로 교체 → MLflow UI 의 run 이름이 Job 이름

PYTHONPATH=/opt/ml/code 위에 위치하므로 train.py가 실행하는 모든 자식 Python
프로세스(torchrun, launch_finetune.py, DDP rank들)가 자동으로 import합니다.
"""

import os


def _enable_mlflow_in_transformers() -> None:
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        return  # MLflow 미설정 — 아무것도 하지 않음
    try:
        from transformers import TrainingArguments
    except Exception:
        return  # transformers 미설치 (다른 컨텍스트) — skip

    original_post_init = TrainingArguments.__post_init__

    def patched_post_init(self):
        original_post_init(self)
        # report_to 정규화: 'none' / [] / None / 'wandb' 등을 받아서 mlflow를 추가
        rt = getattr(self, "report_to", None)
        if isinstance(rt, str):
            rt = [] if rt.lower() in ("none", "all") and rt.lower() == "none" else [rt]
        elif rt is None:
            rt = []
        # 중복 제거하면서 mlflow 추가
        rt = [x for x in rt if x and x.lower() != "none"]
        if "mlflow" not in [x.lower() for x in rt]:
            rt.append("mlflow")
        self.report_to = rt
        # HF 는 run_name 미지정 시 output_dir 을 run 이름으로 쓴다 → Job 이름으로 교체
        run_name = os.environ.get("MLFLOW_RUN_NAME")
        if run_name and getattr(self, "run_name", None) in (None, self.output_dir):
            self.run_name = run_name

    TrainingArguments.__post_init__ = patched_post_init
    # 한 번만 패치 — sitecustomize는 import당 1회 실행되지만 안전하게 표식
    TrainingArguments._mlflow_report_patched = True


_enable_mlflow_in_transformers()
