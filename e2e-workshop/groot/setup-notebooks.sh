#!/usr/bin/env bash
# GR00T 워크숍 노트북 1회성 셋업 (DCV 데스크탑에서 실행).
#   - uv env 동기화 + jupyter 커널 등록
#   - code-server에 Open VSX Python/Jupyter 확장 설치
#   - config.yaml 채움
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # groot/
INFRA_DIR="$(cd "${SCRIPT_DIR}/../infra/groot" && pwd)"
REGION="${1:-us-east-1}"

echo "[1/6] repo 위치 확인: ${SCRIPT_DIR}"
if [ ! -f "${SCRIPT_DIR}/pyproject.toml" ]; then
  echo "오류: groot/pyproject.toml 을 찾을 수 없습니다. repo 안에서 실행하세요." >&2
  exit 1
fi

echo "[2/6] uv 확인/설치"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${HOME}/.local/bin:${PATH}"
fi

echo "[3/6] uv sync (+notebooks)"
( cd "${SCRIPT_DIR}" && uv sync --extra notebooks )

echo "[4/6] Jupyter 커널 등록: groot"
( cd "${SCRIPT_DIR}" && uv run --extra notebooks \
    python -m ipykernel install --user --name groot --display-name "GR00T (uv)" )

echo "[5/6] code-server 확장 설치 (Open VSX)"
if command -v code-server >/dev/null 2>&1; then
  code-server --install-extension ms-python.python || true
  code-server --install-extension ms-toolsai.jupyter || true
else
  echo "  경고: code-server 미발견 — 확장 설치 건너뜀 (jupyter lab fallback 사용 가능)"
fi

echo "[6/6] config.yaml 채우기 (GrootFinetune-<ACCOUNT_ID> 스택 outputs 사용)"
( cd "${SCRIPT_DIR}" && npx --prefix "${INFRA_DIR}" ts-node "${INFRA_DIR}/bin/update-config.ts" \
    --region "${REGION}" )

echo
echo "완료. 다음 순서로 진행하세요:"
echo "  1) code-server를 브라우저로 열기 (배포 출력의 CodeServer URL)"
echo "  2) e2e-workshop/groot/notebooks/ 의 .ipynb 열기"
echo "  3) 커널을 'GR00T (uv)' 로 선택"
echo
echo "code-server에서 .ipynb 실행이 매끄럽지 않으면 jupyter lab 사용:"
echo "  cd ${SCRIPT_DIR} && uv run --extra notebooks jupyter lab --no-browser --port 8889"
echo "  (DCV 브라우저에서 http://localhost:8889 접속)"
