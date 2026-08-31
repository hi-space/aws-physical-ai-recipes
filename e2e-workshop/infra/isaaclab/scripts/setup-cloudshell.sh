#!/usr/bin/env bash
# =============================================================================
# setup-cloudshell.sh — CloudShell 환경에서 Isaac Lab CDK 배포를 위한 사전 설정
#
# CloudShell에는 AWS CLI, git, python3이 사전 설치되어 있지만
# Node.js 버전이 낮거나 CDK CLI가 없을 수 있다.
# 이 스크립트는 필요한 도구를 확인하고 설치한다.
#
# 사용법:
#   source ./scripts/setup-cloudshell.sh
# =============================================================================
_SAVED_OPTS=$(set +o 2>/dev/null)
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

REPO_URL="https://github.com/hi-space/aws-physical-ai-recipes.git"
PROJECT_DIR="$HOME/aws-physical-ai-recipes/e2e-workshop/infra/isaaclab"

echo "============================================"
echo " Isaac Lab — CloudShell 환경 설정"
echo "============================================"
echo ""

# ── 0. 리포지토리 클론 ──
echo -e "${CYAN}[1/5] 리포지토리 확인...${NC}"
if [ -d "$PROJECT_DIR" ]; then
  echo -e "  ${GREEN}[OK]${NC} 이미 존재 — git pull"
  git -C "$HOME/aws-physical-ai-recipes" pull --quiet 2>/dev/null || true
else
  echo -e "  ${YELLOW}[CLONE]${NC} $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$HOME/aws-physical-ai-recipes"
fi
cd "$PROJECT_DIR"
echo -e "  ${GREEN}[OK]${NC} $(pwd)"

# ── 1. Node.js 버전 확인 (18+ 필요) ──
echo -e "${CYAN}[2/5] Node.js 확인...${NC}"
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | tr -d 'v' | cut -d. -f1)
  if (( NODE_VER >= 18 )); then
    echo -e "  ${GREEN}[OK]${NC} Node.js $(node -v)"
  else
    echo -e "  ${YELLOW}[UPGRADE]${NC} Node.js $(node -v) → 18+ 필요, nvm으로 설치 중..."
    # CloudShell에 nvm이 있으면 사용, 없으면 직접 설치
    if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
      [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
      nvm install 18 && nvm use 18
    else
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
      nvm install 18 && nvm use 18
    fi
    echo -e "  ${GREEN}[OK]${NC} Node.js $(node -v)"
  fi
else
  echo -e "  ${RED}[MISSING]${NC} Node.js 미설치, nvm으로 설치 중..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  nvm install 18 && nvm use 18
  echo -e "  ${GREEN}[OK]${NC} Node.js $(node -v)"
fi

# ── 2. npm 프로젝트 의존성 설치 ──
echo ""
echo -e "${CYAN}[3/5] npm 의존성 설치...${NC}"
if [ -d "node_modules" ] && [ -d "node_modules/aws-cdk-lib" ]; then
  echo -e "  ${GREEN}[OK]${NC} node_modules 이미 존재"
else
  npm install --no-fund --no-audit 2>&1 | tail -1
  echo -e "  ${GREEN}[OK]${NC} npm install 완료"
fi

# ── 3. CDK CLI 확인 ──
echo ""
echo -e "${CYAN}[4/5] CDK CLI 확인...${NC}"
# npx cdk를 사용하므로 글로벌 설치 불필요하지만, 편의를 위해 확인
if npx cdk --version &>/dev/null; then
  echo -e "  ${GREEN}[OK]${NC} CDK $(npx cdk --version 2>/dev/null | head -1)"
else
  echo -e "  ${RED}[FAIL]${NC} CDK CLI 사용 불가 — npm install 확인 필요"
  exit 1
fi

# ── 4. CDK Bootstrap (계정+리전당 1회) ──
# 부트스트랩되지 않은 계정에서는 cdk deploy가 "this stack uses assets, so the
# toolkit stack must be deployed" 로 실패한다. CDKToolkit 스택 존재 여부로 판단해
# 이미 있으면 건너뛴다 — 한 계정을 여러 명이 쓸 때 동시 실행 충돌을 피하기 위함.
echo ""
echo -e "${CYAN}[5/5] CDK Bootstrap 확인...${NC}"
BOOTSTRAP_REGION="${CDK_BOOTSTRAP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}}"
if ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
  if aws cloudformation describe-stacks --stack-name CDKToolkit \
       --region "$BOOTSTRAP_REGION" &>/dev/null; then
    echo -e "  ${GREEN}[OK]${NC} 이미 bootstrap됨 — ${ACCOUNT_ID} / ${BOOTSTRAP_REGION}"
  else
    echo -e "  ${YELLOW}[BOOTSTRAP]${NC} ${ACCOUNT_ID} / ${BOOTSTRAP_REGION} (수 분 소요)"
    npx cdk bootstrap "aws://${ACCOUNT_ID}/${BOOTSTRAP_REGION}"
    echo -e "  ${GREEN}[OK]${NC} bootstrap 완료"
  fi
  echo -e "  ${CYAN}[i]${NC} 다른 리전에 배포하려면(-c region=xxx) 그 리전도 부트스트랩이 필요합니다:"
  echo -e "      CDK_BOOTSTRAP_REGION=<리전> source ./scripts/setup-cloudshell.sh"
else
  echo -e "  ${RED}[FAIL]${NC} AWS 자격증명 확인 실패 — aws sts get-caller-identity 를 먼저 점검하세요"
  exit 1
fi

# ── 완료 ──
echo ""
echo "============================================"
echo -e " ${GREEN}✅ 환경 설정 완료${NC}"
echo ""
echo " 배포 명령어:"
echo "   npx cdk deploy -c userId=<이름> -c vpcCidr=10.<번호>.0.0/16 -c versionProfile=latest -c region=us-east-1 --require-approval never"
echo ""
echo " CloudShell 세션 끊김 방지 (권장):"
echo "   nohup npx cdk deploy -c userId=<이름> -c vpcCidr=10.<번호>.0.0/16 -c versionProfile=latest -c region=us-east-1 --require-approval never > deploy.log 2>&1 &"
echo "   tail -f deploy.log"
echo "============================================"
eval "$_SAVED_OPTS" 2>/dev/null || true
unset _SAVED_OPTS
