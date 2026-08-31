#!/bin/bash -e
# =============================================================================
# models-download.sh - 사전 학습 모델·가중치 로컬 디스크 다운로드 스크립트
# =============================================================================
# 사전 학습된 RL 체크포인트(agent_72000.pt)와 GR00T-N1.6-3B 가중치를
# 인스턴스 루트 볼륨(MODELS_DIR)에 내려받는다.
#
# 계정당 1명이 자기 DCV 인스턴스만 쓰는 구조여서 인스턴스 간 공유 스토리지가
# 필요하지 않다. 학습 결과 공유는 /fsx(공유 FSx for Lustre)가 담당한다.
#
# 입력 환경 변수:
#   MODELS_DIR        - 모델·가중치를 받을 로컬 경로.
#                       CDK가 UserData로 주입한다(-c modelsDir=...).
#   GROOT_WEIGHTS_URL - GR00T 가중치 사본 위치. 비어 있으면 HuggingFace에서 받는다.
#                       s3://bucket/prefix/ 또는 https://.../GR00T-N1.6-3B.tar.gz
# =============================================================================

echo "===== [$(date)] START: models-download.sh ====="

MODELS_DIR="${MODELS_DIR:-/home/ubuntu/environment/models}"
echo "모델 디렉터리: ${MODELS_DIR}"
mkdir -p "${MODELS_DIR}"
chown -R ubuntu:ubuntu "${MODELS_DIR}"

# -----------------------------------------------------------------------------
# 1. 사전 학습된 RL 체크포인트 다운로드
# -----------------------------------------------------------------------------
echo "----- [$(date)] START: models-download (agent_72000.pt) -----"
wget -P "${MODELS_DIR}" https://ws-assets-prod-iad-r-pdx-f3b3f9f1a7d6a3d0.s3.us-west-2.amazonaws.com/075ce3fe-6888-4ea9-986e-5bdd1b767ef7/agent_72000.pt || echo "[WARN] 사전 학습 모델 다운로드 실패 — 수동 다운로드 필요"
echo "----- [$(date)] END: models-download (agent_72000.pt) -----"

# -----------------------------------------------------------------------------
# 2. GR00T-N1.6-3B 모델 가중치 다운로드 (약 6.1GiB)
#    워크숍에서 GR00T 추론 컨테이너가 곧바로 사용할 수 있도록 미리 받아둔다.
#
#    GROOT_WEIGHTS_URL이 지정되면 같은 리전의 S3 사본에서 받는다. HuggingFace
#    경유보다 빠르고, 가용성·rate limit·gated 전환에 영향받지 않는다.
#    미지정 시 기존 HuggingFace 경로로 폴백한다.
#
#    가중치는 NVIDIA OneWay Noncommercial License를 따르며, §3.1에 따라 사본을
#    배포할 때는 LICENSE 파일과 고지를 함께 보존해야 한다 (사본 생성 시 포함할 것).
# -----------------------------------------------------------------------------
GROOT_DIR="${MODELS_DIR}/GR00T-N1.6-3B"

echo "----- [$(date)] START: models-download (GR00T weights) -----"
if [ -d "${GROOT_DIR}" ]; then
  echo "GR00T-N1.6-3B가 이미 존재함. 다운로드를 건너뜁니다."
elif [ -n "${GROOT_WEIGHTS_URL}" ]; then
  echo "GR00T-N1.6-3B를 ${GROOT_WEIGHTS_URL} 에서 받습니다."
  # 부분 다운로드가 "이미 존재"로 오인되지 않도록 임시 경로에 받고 성공 시에만 옮긴다.
  rm -rf "${GROOT_DIR}.partial"
  mkdir -p "${GROOT_DIR}.partial"
  GROOT_OK=0
  case "${GROOT_WEIGHTS_URL}" in
    s3://*)
      aws s3 sync "${GROOT_WEIGHTS_URL}" "${GROOT_DIR}.partial" --only-show-errors && GROOT_OK=1
      ;;
    *.tar.gz|*.tgz)
      wget -qO- "${GROOT_WEIGHTS_URL}" | tar -xz -C "${GROOT_DIR}.partial" --strip-components=1 && GROOT_OK=1
      ;;
    *)
      echo "[WARN] GROOT_WEIGHTS_URL 형식을 알 수 없음: ${GROOT_WEIGHTS_URL}"
      ;;
  esac
  # 전송이 성공해도 내용이 온전한지는 별개다. 인덱스 파일 유무로 확인한다.
  if [ "${GROOT_OK}" = "1" ] && [ ! -f "${GROOT_DIR}.partial/model.safetensors.index.json" ]; then
    GROOT_OK=0
    echo "[WARN] 받은 내용에 model.safetensors.index.json이 없음 — 경로/구조 확인 필요"
  fi
  if [ "${GROOT_OK}" = "1" ]; then
    mv "${GROOT_DIR}.partial" "${GROOT_DIR}"
    chown -R ubuntu:ubuntu "${GROOT_DIR}"
  else
    rm -rf "${GROOT_DIR}.partial"
    echo "[WARN] GR00T-N1.6-3B 다운로드 실패 — 수동 다운로드 필요"
  fi
else
  echo "GROOT_WEIGHTS_URL 미지정. HuggingFace에서 받습니다."
  if ! which pip3 > /dev/null 2>&1; then
    apt-get install -y python3-pip
  fi
  pip3 install --break-system-packages -q huggingface_hub
  python3 -c "from huggingface_hub import snapshot_download; snapshot_download('nvidia/GR00T-N1.6-3B', local_dir='${GROOT_DIR}')" \
    || echo "[WARN] GR00T-N1.6-3B 모델 다운로드 실패 — 수동 다운로드 필요"
fi
chown -R ubuntu:ubuntu "${MODELS_DIR}"
echo "----- [$(date)] END: models-download (GR00T weights) -----"

echo "===== [$(date)] END: models-download.sh ====="
