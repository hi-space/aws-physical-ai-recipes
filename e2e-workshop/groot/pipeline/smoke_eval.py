#!/usr/bin/env python3
"""GR00T 스모크 eval — export된 체크포인트가 GPU에서 로드되고 유효한 action을 추론하는지 확인.

품질 지표가 아니라 sanity + governance 게이트다. 실패해도 스크립트는 exit 0으로 끝내고
evaluation.json의 smoke.passed=0으로 표시해 ConditionStep이 판정하게 한다.
(인프라 오류 — OOM 등 — 는 잡 자체가 실패하므로 게이트 판정과 구분된다.)

Task 1 스파이크 상태(2026-08-30):
이 머신에는 로컬 GPU가 없고(nvidia-smi 통신 실패), config.yaml의 ecr.training_uri가
비어 있어 training 이미지가 아직 빌드되지 않았으며, /mnt/efs/GR00T-N1.6-3B 베이스 가중치도
없다. 따라서 브리프 Step 2/6의 "컨테이너 안에서 오프라인 로드 + get_action 실행"은
실제로 수행하지 못했다.

대신 training 이미지가 고정하는 Isaac-GR00T 커밋
(training/container/Dockerfile의 STABLE_COMMIT=5dc80c4afd726b34faad1d8f7e007a13b34e4c88)의
소스코드를 GitHub에서 직접 읽어 아래를 "소스 확인"했다(실행 검증은 아님):
  - gr00t/eval/run_gr00t_server.py, scripts/deployment/standalone_inference_script.py
    → 실제 정책 로드 경로는 `from gr00t.policy.gr00t_policy import Gr00tPolicy`
      (브리프의 후보 경로였던 gr00t.eval.robot 이 아니다)
  - gr00t/policy/gr00t_policy.py의 Gr00tPolicy.check_observation()/check_action()
    → observation/action은 브리프의 flat 키("video.front") 가 아니라
      {"video": {...}, "state": {...}, "language": {...}} 형태의 **nested dict**이며
      video는 (B,T,H,W,C) uint8, state는 (B,T,D) float32, language는 list[list[str]].
      get_action()은 (action_dict, info_dict) 튜플을 반환하고 action_dict[key]는 (B,T,D) float32.
  - training/container/configs/so101_modality_config.py (이 리포에 실제로 등록된 config)
    → video 키=["front","wrist"], state/action 키=["single_arm","gripper"], delta_indices:
      video/state=[0](T=1), action=range(0,16)(T=16). single_arm dim=5, gripper dim=1
      (training/container/configs/so101_modality.json 기준 — data/configs 쪽과 동일함, 불일치 없음).

# UNVERIFIED — 첫 파이프라인 GPU 실행에서 반드시 재확인:
#   1) run_policy()의 Gr00tPolicy(...) 생성 및 policy.get_action(obs) 호출이 실제로 성공하는지
#      (이미지 로드/버전 차이, transformers AutoModel/AutoProcessor 등록 여부 등)
#   2) build_dummy_observation()의 video H/W(임의로 224x224 사용 — ModalityConfig에는 해상도
#      정보가 없어 processor가 내부적으로 리사이즈한다고 가정) 및 EmbodimentTag[...] 조회가
#      inference_metadata.json의 실제 embodiment_tag 문자열과 일치하는지
#   3) inference_metadata.json이 담는 단일 video_key/state_key(train.py 기본값
#      "video.webcam"/"state.single_arm")가 so101의 다중 카메라/다중 상태 키(front/wrist,
#      single_arm/gripper)를 표현하지 못한다는 점 — 이 스크립트는 metadata의 단일 키 대신
#      so101_modality_config.py의 실제 다중 키를 정적으로 사용한다.
"""
import argparse
import glob
import json
import os
import sys
import tarfile
from pathlib import Path

INPUT_DIR = "/opt/ml/processing/input"
OUTPUT_DIR = "/opt/ml/processing/output"

# so101/NEW_EMBODIMENT modality config (training/container/configs/so101_modality_config.py,
# so101_modality.json과 동일) 에서 확인한 실제 키·차원. 다른 embodiment_tag로 학습된 체크포인트라면
# 맞지 않을 수 있음 — 이 경우가 Task 1 스파이크가 커버하지 못하는 부분이다.
SO101_VIDEO_KEYS = ["front", "wrist"]
SO101_STATE_DIMS = {"single_arm": 5, "gripper": 1}
# action의 키/차원은 so101_modality_config.py에서 state와 동일한 구성(single_arm=5, gripper=1).
SO101_ACTION_DIMS = {"single_arm": 5, "gripper": 1}
SO101_ACTION_KEYS = list(SO101_ACTION_DIMS.keys())
SO101_LANGUAGE_KEY = "annotation.human.task_description"
DUMMY_IMAGE_HW = 224  # UNVERIFIED — processor가 내부적으로 리사이즈한다고 가정한 임의 값


def expected_action_dim() -> int:
    """so101/NEW_EMBODIMENT의 실제 concatenated action 마지막 축 크기(=6).

    inference_metadata.json의 action_dim은 train.py의 하드코딩된 기본값 "7"이며(오버라이드
    경로 없음 — training/scripts/run_training.py, training/container/train.py 확인), so101의
    실제 action_dim(single_arm 5 + gripper 1 = 6)과 다르다. meta["action_dim"]을 그대로 쓰면
    건강한 체크포인트도 항상 게이트에 걸리므로, video_key/state_key와 동일하게 이 스크립트의
    정적 so101 설정에서 기대값을 파생시킨다(meta는 신뢰하지 않음).
    """
    return sum(SO101_ACTION_DIMS.values())


def extract_checkpoint(input_dir: str) -> str:
    """input_dir의 model.tar.gz를 풀어 체크포인트 디렉토리 경로를 반환. tar가 없으면 input_dir 그대로."""
    tars = glob.glob(os.path.join(input_dir, "*.tar.gz"))
    if not tars:
        return input_dir
    dest = os.path.join(input_dir, "_extracted")
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(tars[0]) as tf:
        tf.extractall(dest)
    return dest


def load_metadata(ckpt_dir: str) -> dict:
    """inference_metadata.json을 읽는다. 실제로 소비하는 필드는 embodiment_tag뿐이다.

    video_key/state_key/action_dim은 train.py가 담아 두지만 이 스크립트는 신뢰하지 않는다 —
    so101은 다중 카메라/다중 상태 키를 쓰므로 단일 flat 키로 표현이 안 되고(위 SO101_* 상수
    참고), action_dim의 train.py 기본값("7")도 so101의 실제 값(6)과 다르다
    (expected_action_dim() 참고). 아래 기본값의 action_dim/video_key/state_key는 참고용으로만
    남겨 두고 실제 게이트 판정에는 쓰지 않는다.
    """
    meta_path = Path(ckpt_dir) / "inference_metadata.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text())
    return {"embodiment_tag": "NEW_EMBODIMENT", "action_dim": 7,
            "video_key": "front", "state_key": "single_arm"}


def check_action(action, action_dim: int) -> dict:
    """반환 action 텐서의 shape/finite를 검사한다. 순수함수(GPU 불필요)."""
    try:
        import numpy as np
        arr = np.asarray(action, dtype=float)
        shape = list(arr.shape)
        finite = bool(np.isfinite(arr).all())
        # 마지막 축이 action_dim 이고 2D([horizon, action_dim]) 이상이면 통과
        ok = arr.ndim >= 1 and shape[-1] == action_dim and finite and arr.size > 0
        return {"passed": 1 if ok else 0, "action_shape": shape,
                "all_finite": 1 if finite else 0, "error": ""}
    except Exception as e:  # noqa: BLE001
        return {"passed": 0, "action_shape": [], "all_finite": 0, "error": repr(e)}


def write_report(out_dir: str, report: dict) -> None:
    os.makedirs(out_dir, exist_ok=True)
    Path(out_dir, "evaluation.json").write_text(json.dumps({"smoke": report}))


def build_dummy_observation(meta: dict):
    """so101/NEW_EMBODIMENT 형태의 합성 관측 1개.

    Gr00tPolicy.check_observation()이 요구하는 nested dict 형태로 구성한다
    (Task 1 Step 2 스파이크 — 소스코드 확인. 실제 GPU 실행으로는 미확인, 상단 UNVERIFIED 참고).
    video: {key: (B,T,H,W,C) uint8}, state: {key: (B,T,D) float32},
    language: {key: [[str]] (B,T=1)}.
    """
    import numpy as np

    video = {
        key: np.zeros((1, 1, DUMMY_IMAGE_HW, DUMMY_IMAGE_HW, 3), dtype=np.uint8)
        for key in SO101_VIDEO_KEYS
    }
    state = {
        key: np.zeros((1, 1, dim), dtype=np.float32)
        for key, dim in SO101_STATE_DIMS.items()
    }
    language = {SO101_LANGUAGE_KEY: [["pick the orange"]]}
    return {"video": video, "state": state, "language": language}


def run_policy(ckpt_dir: str, meta: dict):
    """Step 2 스파이크(소스코드 확인)에서 확정한 오프라인 로드 경로로 policy를 만들고
    get_action을 호출해 [horizon, action_dim] 형태의 concatenated action을 반환한다.
    """
    # <<< 스파이크 확정: gr00t.eval.robot 이 아니라 gr00t.policy.gr00t_policy >>>
    from gr00t.data.embodiment_tags import EmbodimentTag
    from gr00t.policy.gr00t_policy import Gr00tPolicy

    embodiment_tag = EmbodimentTag[meta.get("embodiment_tag", "NEW_EMBODIMENT")]
    policy = Gr00tPolicy(
        embodiment_tag=embodiment_tag,
        model_path=ckpt_dir,
        device="cuda",
        strict=True,
    )
    obs = build_dummy_observation(meta)
    action, _info = policy.get_action(obs)  # -> (dict[str, (B,T,D)], info)

    import numpy as np
    parts = [np.asarray(action[key], dtype=float)[0] for key in SO101_ACTION_KEYS]  # (T, D_k)
    return np.concatenate(parts, axis=-1)  # (T, action_dim)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", default=INPUT_DIR)
    parser.add_argument("--output-dir", default=OUTPUT_DIR)
    args = parser.parse_args()

    try:
        ckpt = extract_checkpoint(args.input_dir)
        meta = load_metadata(ckpt)
        action = run_policy(ckpt, meta)
        # meta["action_dim"]이 아니라 so101 정적 설정에서 파생한 기대값을 쓴다 — 위
        # expected_action_dim() 문서 참고 (meta 값은 train.py 기본값 7로 항상 틀림).
        report = check_action(action, expected_action_dim())
    except Exception as e:  # noqa: BLE001
        # 이 except는 extract_checkpoint/load_metadata/run_policy(정책 로드·get_action 호출)
        # 실패를 잡는다 — "LOAD_OR_INFER_FAILURE:" 접두사로 표시해 check_action()이 잡는
        # shape/finite 불일치(action_shape가 채워지고 error=""인 경우)와 구분한다. 첫 실행에서
        # 이 접두사가 보이면 모델 품질 문제가 아니라 위 UNVERIFIED 스파이크 가정이 틀렸다는 뜻이다.
        report = {"passed": 0, "action_shape": [], "all_finite": 0,
                  "error": f"LOAD_OR_INFER_FAILURE: {e!r}"}
    write_report(args.output_dir, report)
    print("SMOKE EVAL REPORT:", json.dumps(report))
    sys.exit(0)  # 항상 0 — 게이트가 판정


if __name__ == "__main__":
    main()
