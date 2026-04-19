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
_state_dims: dict = {}  # state_key → expected dimension (populated at load time)


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

    # 상태 키별 차원 정보를 프로세서에서 추출
    global _state_dims
    _state_dims = _detect_state_dims()
    logger.info(f"상태 차원 정보: {_state_dims}")

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


@app.get("/info")
def info() -> dict:
    """모델의 예상 입력 형식을 반환하는 진단 엔드포인트."""
    if _policy is None:
        raise HTTPException(status_code=503, detail="모델이 아직 로드되지 않았습니다.")

    modality_configs = _policy.get_modality_config()
    video_keys = modality_configs["video"].modality_keys
    state_keys = modality_configs["state"].modality_keys
    action_keys = modality_configs["action"].modality_keys if "action" in modality_configs else []

    return {
        "embodiment_tag": str(_policy.embodiment_tag),
        "video_keys": video_keys,
        "state_keys": state_keys,
        "state_dims": _state_dims,
        "action_keys": action_keys,
        "metadata": _metadata,
    }


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

def _detect_state_dims() -> dict:
    """프로세서의 norm_params에서 각 상태 키의 차원을 추출합니다.

    SAP 구조: sap.norm_params[embodiment_tag_lower] → {joint_group → NormParams}
    NormParams는 mask/min_val 등 차원 정보를 포함합니다.
    """
    try:
        modality_configs = _policy.get_modality_config()
        state_keys = modality_configs["state"].modality_keys
        sap = _policy.processor.state_action_processor
        embodiment_tag = str(_policy.embodiment_tag).lower()

        dims = {}

        # norm_params에서 embodiment_tag에 맞는 키를 탐색
        # (대소문자 또는 형식 차이에 대비해 여러 후보를 시도)
        if hasattr(sap, "norm_params"):
            logger.info(f"norm_params keys: {list(sap.norm_params.keys())}")
            emb_params = None
            for candidate in [embodiment_tag, embodiment_tag.upper(), embodiment_tag.replace("_", "-")]:
                if candidate in sap.norm_params:
                    emb_params = sap.norm_params[candidate]
                    logger.info(f"norm_params['{candidate}'] matched, type={type(emb_params).__name__}")
                    break

            if emb_params is None and sap.norm_params:
                # 정확히 매칭되는 키가 없으면 부분 매칭 시도
                for key in sap.norm_params:
                    if embodiment_tag in key.lower() or key.lower() in embodiment_tag:
                        emb_params = sap.norm_params[key]
                        logger.info(f"norm_params['{key}'] partial match, type={type(emb_params).__name__}")
                        break

            if emb_params is not None and isinstance(emb_params, dict):
                logger.info(f"norm_params top-level keys: {list(emb_params.keys())}")
                # norm_params 구조: {modality: {joint_group: NormParams}} 또는 {joint_group: NormParams}
                # 'state' 키가 있으면 한 단계 더 들어감
                search_targets = [emb_params]
                if "state" in emb_params and isinstance(emb_params["state"], dict):
                    search_targets.insert(0, emb_params["state"])
                    logger.info(f"norm_params['state'] keys: {list(emb_params['state'].keys())}")

                for target in search_targets:
                    for jg_key, params in target.items():
                        if jg_key in dims:
                            continue
                        if isinstance(params, dict):
                            # dict 형태: {'min': [...], 'max': [...], 'dim': int, ...}
                            if "dim" in params:
                                dims[jg_key] = int(params["dim"])
                                logger.info(f"joint_group '{jg_key}' → dim={dims[jg_key]} (via dict['dim'])")
                            else:
                                for attr in ["mask", "min", "max", "mean"]:
                                    if attr in params and hasattr(params[attr], '__len__'):
                                        dims[jg_key] = len(params[attr])
                                        logger.info(f"joint_group '{jg_key}' → dim={dims[jg_key]} (via dict['{attr}'])")
                                        break
                        else:
                            for attr in ["dim", "mask", "min_val", "min", "mean"]:
                                if hasattr(params, attr):
                                    val = getattr(params, attr)
                                    if isinstance(val, int):
                                        dims[jg_key] = val
                                    elif hasattr(val, '__len__'):
                                        dims[jg_key] = len(val)
                                    if jg_key in dims:
                                        logger.info(f"joint_group '{jg_key}' → dim={dims[jg_key]} (via {attr})")
                                        break

        # get_state_dim 메서드 시도
        if not dims and hasattr(sap, "get_state_dim"):
            for sk in state_keys:
                try:
                    dim = sap.get_state_dim(embodiment_tag, sk)
                    dims[sk] = dim
                    logger.info(f"get_state_dim('{embodiment_tag}', '{sk}') → {dim}")
                except Exception:
                    pass

        if dims:
            # state_keys와 매칭되는 차원만 필터링
            matched = {sk: dims[sk] for sk in state_keys if sk in dims}
            if len(matched) == len(state_keys):
                return matched
            # joint_group 키가 state_keys와 다를 경우 전체 반환
            logger.info(f"state_keys={state_keys}, detected dims={dims}, matched={matched}")
            return dims

        # fallback: statistics.json에서 차원 추출
        dims = _detect_state_dims_from_statistics(state_keys, embodiment_tag)
        if dims:
            return dims

        logger.warning(f"상태 차원 자동 감지 실패. state_keys={state_keys}, detected={dims}")
    except Exception as e:
        logger.warning(f"상태 차원 감지 실패: {e}", exc_info=True)

    return {}


def _detect_state_dims_from_statistics(state_keys: list, embodiment_tag: str) -> dict:
    """statistics.json 파일에서 상태 차원을 추출합니다 (fallback)."""
    model_dir = os.environ.get("SM_MODEL_DIR", "/opt/ml/model")
    for candidate_path in [
        os.path.join(model_dir, "statistics.json"),
        os.path.join(model_dir, "processor", "statistics.json"),
    ]:
        if not os.path.isfile(candidate_path):
            continue
        try:
            with open(candidate_path, "r", encoding="utf-8") as f:
                stats = json.load(f)
            # statistics.json: {embodiment_tag: {modality: {joint_group: {min: [...], ...}}}}
            for emb_candidate in [embodiment_tag, embodiment_tag.upper(), embodiment_tag.lower()]:
                if emb_candidate not in stats:
                    continue
                emb_stats = stats[emb_candidate]
                # 'state' 모달리티 하위에서 찾기
                state_stats = emb_stats.get("state", emb_stats)
                dims = {}
                for sk in state_keys:
                    if sk in state_stats and isinstance(state_stats[sk], dict):
                        for attr in ["min", "max", "mean"]:
                            if attr in state_stats[sk] and isinstance(state_stats[sk][attr], list):
                                dims[sk] = len(state_stats[sk][attr])
                                break
                if len(dims) == len(state_keys):
                    logger.info(f"statistics.json에서 차원 감지 성공: {dims}")
                    return dims
        except Exception as e:
            logger.warning(f"statistics.json 파싱 실패 ({candidate_path}): {e}")
    return {}


def _validate_input(body: dict) -> dict:
    """요청 본문을 검증하고 정규화된 딕셔너리를 반환합니다.

    상태 입력은 두 가지 형식을 지원합니다:
      1. "state": {"dual_arm": [12 values], "gripper": [2 values]}  (권장)
      2. "proprioception": [flat array]  (단일 상태 키 모델용)
    """
    # image 필수
    if "image" not in body:
        raise HTTPException(status_code=400, detail="필수 필드 누락: ['image']")

    # image: base64 문자열 검증
    image_b64 = body["image"]
    if not isinstance(image_b64, str) or not image_b64.strip():
        raise HTTPException(status_code=400, detail="'image'는 비어있지 않은 base64 문자열이어야 합니다.")
    try:
        base64.b64decode(image_b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="'image' 필드에 유효하지 않은 base64 데이터가 포함되어 있습니다.")

    # state 또는 proprioception 필수
    if "state" not in body and "proprioception" not in body:
        raise HTTPException(
            status_code=400,
            detail="'state' (dict) 또는 'proprioception' (list) 중 하나가 필요합니다.",
        )

    state_dict = None
    if "state" in body:
        state_input = body["state"]
        if not isinstance(state_input, dict) or not state_input:
            raise HTTPException(status_code=400, detail="'state'는 비어있지 않은 딕셔너리여야 합니다.")
        state_dict = {}
        for key, values in state_input.items():
            if not isinstance(values, list) or not values:
                raise HTTPException(status_code=400, detail=f"'state.{key}'는 비어있지 않은 숫자 배열이어야 합니다.")
            state_dict[key] = [float(v) for v in values]

    proprioception = None
    if "proprioception" in body and state_dict is None:
        prop = body["proprioception"]
        if not isinstance(prop, list) or len(prop) == 0:
            raise HTTPException(status_code=400, detail="'proprioception'은 비어있지 않은 숫자 배열이어야 합니다.")
        proprioception = [float(v) for v in prop]

    # instruction 필수
    if "instruction" not in body:
        raise HTTPException(status_code=400, detail="필수 필드 누락: ['instruction']")
    instruction = body["instruction"]
    if not isinstance(instruction, str) or not instruction.strip():
        raise HTTPException(status_code=400, detail="'instruction'은 비어있지 않은 문자열이어야 합니다.")

    result = {
        "image": image_b64,
        "instruction": instruction.strip(),
    }
    if state_dict is not None:
        result["state"] = state_dict
    else:
        result["proprioception"] = proprioception
    return result


def _run_inference(validated: dict) -> dict:
    """GR00T 모델로 추론을 실행하고 결과를 반환합니다."""
    # 이미지 디코딩: base64 → PIL → numpy (H, W, C) uint8
    image_bytes = base64.b64decode(validated["image"])
    image = np.array(
        Image.open(io.BytesIO(image_bytes)).convert("RGB"),
        dtype=np.uint8,
    )

    # modality config에서 키를 동적으로 가져옴
    modality_configs = _policy.get_modality_config()
    video_key = modality_configs["video"].modality_keys[0]
    state_keys = modality_configs["state"].modality_keys

    # 상태 딕셔너리 구성
    if "state" in validated:
        # 클라이언트가 키별로 분할된 state dict를 전송한 경우
        state_dict = {
            sk: np.array(validated["state"][sk], dtype=np.float32)[np.newaxis, np.newaxis]
            for sk in state_keys
            if sk in validated["state"]
        }
        # 누락된 state 키 확인
        missing = [sk for sk in state_keys if sk not in validated["state"]]
        if missing:
            raise ValueError(
                f"state dict에 필수 키 누락: {missing}. "
                f"필요한 키: {state_keys}, state_dims: {_state_dims}"
            )
    else:
        # flat proprioception → 단일 키면 전체 전달, 다중 키면 차원 정보로 분할
        state = np.array(validated["proprioception"], dtype=np.float32)
        if _state_dims and all(sk in _state_dims for sk in state_keys):
            expected_total = sum(_state_dims[sk] for sk in state_keys)
            if len(state) != expected_total:
                raise ValueError(
                    f"proprioception 길이 불일치: 입력={len(state)}, "
                    f"모델 기대값={expected_total} "
                    f"(state_keys={state_keys}, dims={_state_dims}). "
                    f"'--proprioception' 대신 keyed 형식을 사용하세요: "
                    f"예) --proprioception \"{';'.join(k + ':' + ','.join(['0.0'] * d) for k, d in _state_dims.items())}\""
                )
            state_dict = {}
            offset = 0
            for sk in state_keys:
                dim = _state_dims[sk]
                state_dict[sk] = state[offset:offset + dim][np.newaxis, np.newaxis]
                offset += dim
        elif len(state_keys) == 1:
            state_dict = {state_keys[0]: state[np.newaxis, np.newaxis]}
        else:
            raise ValueError(
                f"다중 state 키({state_keys})에 대한 차원 정보를 자동 감지하지 못했습니다. "
                f"flat proprioception 대신 keyed 형식으로 전송하세요: "
                f"예) --proprioception \"{';'.join(k + ':0.0,...' for k in state_keys)}\""
            )

    obs = {
        "video": {
            video_key: image[np.newaxis, np.newaxis],  # (B=1, T=1, H, W, C)
        },
        "state": state_dict,
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
