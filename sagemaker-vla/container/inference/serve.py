"""GR00T-N1.6 SageMaker 추론 서버 (FastAPI).

SageMaker Real-time Endpoint 규약:
  GET  /ping         → 헬스체크 (HTTP 200 반환)
  POST /invocations  → 추론 요청 처리

요청 형식 (application/json):
    {
        "image": "<base64 인코딩된 RGB 이미지>",
        "proprioception": [0.1, 0.2, 0.3, ...],
        "instruction": "pick up the red block"
    }

응답 형식 (application/json):
    {
        "actions": [[0.05, -0.12, 0.33, ...]],
        "timestamp": "2024-01-15T10:30:00.000000+00:00"
    }
"""

import base64
import io
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 전역 모델 (startup 이벤트에서 로드)
# ---------------------------------------------------------------------------
_policy = None
_metadata: dict = {}


# ---------------------------------------------------------------------------
# 모델 로드
# ---------------------------------------------------------------------------

def load_model() -> None:
    """GR00T 정책 모델을 SM_MODEL_DIR에서 로드합니다."""
    global _policy, _metadata

    model_dir = os.environ.get("SM_MODEL_DIR", "/opt/ml/model")
    metadata_path = os.path.join(model_dir, "inference_metadata.json")

    # 추론 메타데이터 로드 (train.py에서 저장한 파일)
    if os.path.isfile(metadata_path):
        with open(metadata_path, "r", encoding="utf-8") as f:
            _metadata = json.load(f)
        logger.info(f"추론 메타데이터 로드 완료: {_metadata}")
    else:
        logger.warning(
            f"inference_metadata.json 없음: {metadata_path}. 기본값 사용."
        )
        _metadata = {
            "embodiment_tag": os.environ.get("GROOT_EMBODIMENT_TAG", "new_embodiment"),
            "video_key": "video.webcam",
            "state_key": "state.single_arm",
            "action_dim": 7,
        }

    logger.info(f"모델 로드 중: {model_dir}")

    # SageMaker는 /opt/ml/model을 읽기 전용으로 마운트합니다.
    # 프로세서 파일이 서브디렉토리에만 있을 경우 임시 디렉토리로 병합 복사합니다.
    import shutil
    import tempfile

    effective_model_dir = model_dir
    processor_root = os.path.join(model_dir, "processor_config.json")
    if not os.path.isfile(processor_root):
        for subdir in ["processor", "checkpoint-1", "checkpoint"]:
            src_dir = os.path.join(model_dir, subdir, "processor_config.json")
            if os.path.isfile(src_dir):
                logger.info(f"프로세서 파일이 {subdir}/에만 있음 → 임시 디렉토리로 병합 복사합니다.")
                effective_model_dir = tempfile.mkdtemp(prefix="groot_model_")
                # 루트 파일 복사 (심볼릭 링크로 빠르게)
                for item in os.listdir(model_dir):
                    s = os.path.join(model_dir, item)
                    d = os.path.join(effective_model_dir, item)
                    if os.path.isfile(s):
                        os.symlink(s, d)
                    elif os.path.isdir(s):
                        os.symlink(s, d)
                # 프로세서 파일을 루트로 복사 (기존 심볼릭 링크 덮어쓰지 않음)
                proc_dir = os.path.join(model_dir, subdir)
                for f in os.listdir(proc_dir):
                    src_f = os.path.join(proc_dir, f)
                    dst_f = os.path.join(effective_model_dir, f)
                    if os.path.isfile(src_f) and not os.path.exists(dst_f):
                        os.symlink(src_f, dst_f)
                logger.info(f"병합된 모델 경로: {effective_model_dir}")
                break

    from gr00t.policy.gr00t_policy import Gr00tPolicy
    from gr00t.data.embodiment_tags import EmbodimentTag

    embodiment_tag = EmbodimentTag[_metadata["embodiment_tag"]]

    _policy = Gr00tPolicy(
        embodiment_tag=embodiment_tag,
        model_path=effective_model_dir,
        device="cuda:0",
        strict=False,
    )

    logger.info("GR00T 모델 로드 완료.")


# ---------------------------------------------------------------------------
# FastAPI 앱 (lifespan으로 startup/shutdown 관리)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield
    # shutdown 정리 작업 (필요 시 추가)


app = FastAPI(lifespan=lifespan)


# ---------------------------------------------------------------------------
# 헬스체크
# ---------------------------------------------------------------------------

@app.get("/ping")
def ping() -> dict:
    """SageMaker 헬스체크 엔드포인트.

    모델이 로드되어 있으면 200 OK, 아니면 503 반환.
    """
    if _policy is None:
        raise HTTPException(status_code=503, detail="모델이 아직 로드되지 않았습니다.")
    return {"status": "healthy"}


# ---------------------------------------------------------------------------
# 추론
# ---------------------------------------------------------------------------

@app.post("/invocations")
async def invocations(request: Request) -> Response:
    """추론 요청을 처리하고 로봇 액션 벡터를 반환합니다.

    Args:
        request: JSON 본문을 포함한 HTTP 요청.
            - image (str): base64 인코딩된 RGB 이미지
            - proprioception (list[float]): 로봇 관절 상태 벡터
            - instruction (str): 자연어 작업 지시

    Returns:
        JSON 응답:
            - actions (list[list[float]]): 예측된 액션 시퀀스
            - timestamp (str): ISO 8601 형식 타임스탬프
    """
    if _policy is None:
        raise HTTPException(status_code=503, detail="모델이 로드되지 않았습니다.")

    # 요청 파싱
    content_type = request.headers.get("content-type", "")
    if "application/json" not in content_type:
        raise HTTPException(
            status_code=415,
            detail=f"지원하지 않는 Content-Type: {content_type}. application/json 필요.",
        )

    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"JSON 파싱 오류: {e}")

    # 입력 검증
    validated = _validate_input(body)

    # 추론 실행
    try:
        result = _run_inference(validated)
    except Exception as e:
        logger.error(f"추론 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"추론 실패: {e}")

    return Response(
        content=json.dumps(result, ensure_ascii=False),
        media_type="application/json",
    )


# ---------------------------------------------------------------------------
# 내부 함수
# ---------------------------------------------------------------------------

def _validate_input(body: dict) -> dict:
    """요청 본문을 검증하고 정규화된 딕셔너리를 반환합니다."""
    required = ["image", "proprioception", "instruction"]
    missing = [k for k in required if k not in body]
    if missing:
        raise HTTPException(status_code=400, detail=f"필수 필드 누락: {missing}")

    # image: base64 문자열 검증
    image_b64 = body["image"]
    if not isinstance(image_b64, str) or not image_b64.strip():
        raise HTTPException(status_code=400, detail="'image'는 비어있지 않은 base64 문자열이어야 합니다.")
    try:
        base64.b64decode(image_b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="'image' 필드에 유효하지 않은 base64 데이터가 포함되어 있습니다.")

    # proprioception: 숫자 리스트 검증
    prop = body["proprioception"]
    if not isinstance(prop, list) or len(prop) == 0:
        raise HTTPException(status_code=400, detail="'proprioception'은 비어있지 않은 숫자 배열이어야 합니다.")
    for i, v in enumerate(prop):
        if not isinstance(v, (int, float)):
            raise HTTPException(
                status_code=400,
                detail=f"'proprioception[{i}]'은 숫자여야 합니다. 받은 타입: {type(v).__name__}",
            )

    # instruction: 비어있지 않은 문자열
    instruction = body["instruction"]
    if not isinstance(instruction, str) or not instruction.strip():
        raise HTTPException(status_code=400, detail="'instruction'은 비어있지 않은 문자열이어야 합니다.")

    return {
        "image": image_b64,
        "proprioception": [float(v) for v in prop],
        "instruction": instruction.strip(),
    }


def _run_inference(validated: dict) -> dict:
    """GR00T 모델로 추론을 실행하고 결과를 반환합니다."""
    # 이미지 디코딩: base64 → PIL → numpy (H, W, C) uint8
    image_bytes = base64.b64decode(validated["image"])
    image = np.array(
        Image.open(io.BytesIO(image_bytes)).convert("RGB"),
        dtype=np.uint8,
    )

    # 관측 딕셔너리 구성 (GR00T Policy API 중첩 딕셔너리 형식)
    # video_key 예: "video.webcam" → {"video": {"webcam": array}}
    # state_key 예: "state.single_arm" → {"state": {"single_arm": array}}
    video_key = _metadata.get("video_key", "video.webcam")
    state_key = _metadata.get("state_key", "state.single_arm")

    video_parts = video_key.split(".", 1)
    state_parts = state_key.split(".", 1)

    obs = {
        "video": {
            video_parts[1] if len(video_parts) > 1 else video_parts[0]:
                image[np.newaxis, np.newaxis],  # (B=1, T=1, H, W, C)
        },
        "state": {
            state_parts[1] if len(state_parts) > 1 else state_parts[0]:
                np.array(validated["proprioception"], dtype=np.float32)[np.newaxis, np.newaxis],  # (B=1, T=1, D)
        },
        "language": {
            _policy.language_key: [[validated["instruction"]]],  # (B=1, 1)
        },
    }

    # GR00T 추론 — returns (action_dict, info)
    action_dict, _info = _policy.get_action(obs)

    # 액션 배열 직렬화 (numpy → Python list)
    action_key = next(iter(action_dict))
    actions = action_dict[action_key]

    if isinstance(actions, np.ndarray):
        actions_list = actions.tolist()
    else:
        actions_list = list(actions)

    # (N, D) 형태 보장
    if actions_list and not isinstance(actions_list[0], list):
        actions_list = [actions_list]

    return {
        "actions": actions_list,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
