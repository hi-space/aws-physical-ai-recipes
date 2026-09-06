#!/bin/bash

# Claude Code + Codex + Amazon Bedrock 셸 설정 스크립트 (Linux / macOS 공용)
# CLI 설치는 00-install-claude-codex.sh 에서 먼저 수행하세요.

# OS 감지 및 셸 RC 파일 결정
if [[ "$(uname)" == "Darwin" ]]; then
    # macOS: 기본 셸이 zsh (Catalina 이후)
    if [[ "$SHELL" == */zsh ]]; then
        SHELL_RC="$HOME/.zshrc"
    else
        SHELL_RC="$HOME/.bash_profile"
    fi
    OS_TYPE="macOS"
else
    SHELL_RC="$HOME/.bashrc"
    OS_TYPE="Linux"
fi

echo "=== Claude Code + Codex + Amazon Bedrock 셸 설정 ==="
echo "  대상 OS: $OS_TYPE"
echo "  설정 파일: $SHELL_RC"
echo

# Bedrock 인증 방식 선택
#  - Enter(빈 값): AWS 자격 증명(SigV4) 사용 — EC2 인스턴스 역할, AWS_PROFILE, 환경변수 등.
#                 워크숍 DCV 인스턴스(code-server)에서는 이 방식을 사용한다.
#  - 값 입력:     Bedrock API Key(bearer) 사용. 발급한 리전과 AWS_REGION이 같아야 하며,
#                 Workshop Studio 계정에서는 Claude 5 계열 모델이 API Key 경로에서 403이 나므로 비권장.
echo "[인증] Bedrock API Key(AWS_BEARER_TOKEN_BEDROCK)를 쓰려면 값을 입력하고,"
echo "       AWS 자격 증명(인스턴스 역할/프로파일, SigV4)을 쓰려면 그냥 Enter를 누르세요."
read -p "AWS_BEARER_TOKEN_BEDROCK 값 (기본값: 사용 안 함): " AWS_TOKEN

if [ -z "$AWS_TOKEN" ]; then
    AUTH_MODE="AWS 자격 증명 (SigV4)"
else
    AUTH_MODE="Bedrock API Key (bearer)"
fi
echo "선택된 인증 방식: $AUTH_MODE"

# AWS 리전 입력받기 (Bedrock API 호출 리전)
# 기본값 우선순위: AWS_REGION > REGION > EC2 인스턴스 메타데이터(IMDSv2) > us-east-1
detect_ec2_region() {
    local token
    token=$(curl -s -m 1 -X PUT "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null) || return 1
    [ -n "$token" ] || return 1
    curl -s -m 1 -H "X-aws-ec2-metadata-token: $token" \
        "http://169.254.169.254/latest/meta-data/placement/region" 2>/dev/null
}
DEFAULT_REGION="${AWS_REGION:-${REGION:-$(detect_ec2_region)}}"
DEFAULT_REGION="${DEFAULT_REGION:-us-east-1}"
echo
read -p "AWS 리전을 입력하세요 (기본값: ${DEFAULT_REGION}): " AWS_REGION_INPUT
AWS_REGION_VALUE="${AWS_REGION_INPUT:-${DEFAULT_REGION}}"
echo "선택된 리전: $AWS_REGION_VALUE"

# ANTHROPIC_MODEL 선택
echo
echo "[Claude Code] 사용할 모델을 선택하세요:"
echo "  1) opus4.6   (global.anthropic.claude-opus-4-6-v1)   - 워크숍 기본값"
echo "  2) sonnet4.5 (global.anthropic.claude-sonnet-4-5-20250929-v1:0)"
echo "  3) sonnet4.6 (global.anthropic.claude-sonnet-4-6)"
echo
read -p "선택 (1, 2 또는 3, 기본값: 1): " MODEL_CHOICE

case "$MODEL_CHOICE" in
    2)
        SELECTED_MODEL="global.anthropic.claude-sonnet-4-5-20250929-v1:0"
        echo "선택된 모델: sonnet4.5"
        ;;
    3)
        SELECTED_MODEL="global.anthropic.claude-sonnet-4-6"
        echo "선택된 모델: sonnet4.6"
        ;;
    *)
        SELECTED_MODEL="global.anthropic.claude-opus-4-6-v1"
        echo "선택된 모델: opus4.6"
        ;;
esac

# Codex 모델 선택
# Codex는 Bedrock의 Responses API(bedrock-mantle)만 사용하며, Claude 모델은
# /openai/v1/responses 를 지원하지 않으므로 GPT-5.x 계열만 선택 가능합니다.
echo
echo "[Codex] 사용할 모델을 선택하세요:"
echo "  1) openai.gpt-5.6-terra (일상 작업, 비용 효율)"
echo "  2) openai.gpt-5.5       (범용)"
echo "  3) openai.gpt-5.4       (프론티어 추론/코딩)"
echo
read -p "선택 (1, 2 또는 3, 기본값: 1): " CODEX_MODEL_CHOICE

case "$CODEX_MODEL_CHOICE" in
    2)
        CODEX_MODEL="openai.gpt-5.5"
        ;;
    3)
        CODEX_MODEL="openai.gpt-5.4"
        ;;
    *)
        CODEX_MODEL="openai.gpt-5.6-terra"
        ;;
esac
echo "선택된 Codex 모델: $CODEX_MODEL"

# CLAUDE_CODE_MAX_OUTPUT_TOKENS 선택
echo
echo "[Claude Code] Max Output Tokens를 선택하세요:"
echo "  1) 4096  (간단한 질의응답)"
echo "  2) 16384 (일반적인 개발 작업)"
echo "  3) 32768 (큰 파일 생성 및 리팩토링)"
echo
read -p "선택 (1, 2 또는 3, 기본값: 2): " TOKEN_CHOICE

case "$TOKEN_CHOICE" in
    1)
        SELECTED_TOKENS=4096
        echo "선택된 Max Output Tokens: 4096"
        ;;
    3)
        SELECTED_TOKENS=32768
        echo "선택된 Max Output Tokens: 32768"
        ;;
    *)
        SELECTED_TOKENS=16384
        echo "선택된 Max Output Tokens: 16384"
        ;;
esac

# 기존 설정 확인 (BEGIN/END 마커 기준 + 구버전 마커 호환)
BEGIN_MARKER="# BEGIN Claude Code + Codex + Amazon Bedrock 설정"
END_MARKER="# END Claude Code + Codex + Amazon Bedrock 설정"

if grep -q "Claude Code + Amazon Bedrock 설정\|$BEGIN_MARKER" "$SHELL_RC" 2>/dev/null; then
    echo
    echo "기존 Bedrock 설정이 발견되었습니다."
    read -p "기존 설정을 덮어쓰시겠습니까? (y/n): " OVERWRITE
    if [ "$OVERWRITE" = "y" ] || [ "$OVERWRITE" = "Y" ]; then
        # macOS BSD sed와 GNU sed 호환
        if [[ "$(uname)" == "Darwin" ]]; then
            SED_INPLACE=(-i '')
        else
            SED_INPLACE=(-i)
        fi
        # 신규 마커 블록 제거
        sed "${SED_INPLACE[@]}" "/$BEGIN_MARKER/,/$END_MARKER/d" "$SHELL_RC"
        # 구버전 블록 제거 (마커 ~ 첫 빈 줄)
        sed "${SED_INPLACE[@]}" '/# Claude Code + Amazon Bedrock 설정/,/^$/d' "$SHELL_RC"
        echo "기존 설정을 제거했습니다."
    else
        echo "설정을 취소합니다."
        exit 0
    fi
fi

# 셸 RC 파일에 설정 추가
if [ -n "$AWS_TOKEN" ]; then
    BEARER_EXPORT="export AWS_BEARER_TOKEN_BEDROCK='${AWS_TOKEN}'"
else
    BEARER_EXPORT="# AWS_BEARER_TOKEN_BEDROCK 미설정 → AWS 자격 증명(인스턴스 역할/프로파일, SigV4)으로 호출"
fi

cat >> "$SHELL_RC" << EOF

$BEGIN_MARKER
# --- 공통 (Bedrock 인증: ${AUTH_MODE}) ---
${BEARER_EXPORT}
export AWS_REGION='${AWS_REGION_VALUE}'

# --- Claude Code ---
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_MODEL='${SELECTED_MODEL}'
export ANTHROPIC_DEFAULT_OPUS_MODEL='global.anthropic.claude-opus-4-6-v1'
export ANTHROPIC_DEFAULT_SONNET_MODEL='global.anthropic.claude-sonnet-4-5-20250929-v1:0'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='global.anthropic.claude-haiku-4-5-20251001-v1:0'
export ANTHROPIC_SMALL_FAST_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${SELECTED_TOKENS}
$END_MARKER

EOF

echo
echo "셸 환경변수 설정이 추가되었습니다."

# 색상 정의
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# ─── Codex config.toml 설정 ───

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_HOME/config.toml"

echo ""
echo "=== Codex config.toml 설정 ==="
echo -e "${BLUE}설정 경로: ${CODEX_CONFIG}${NC}"

mkdir -p "$CODEX_HOME"

CODEX_BEGIN="# BEGIN Amazon Bedrock 설정"
CODEX_END="# END Amazon Bedrock 설정"

# 기존 파일 백업 후 마커 블록 제거
if [ -f "$CODEX_CONFIG" ]; then
    CODEX_BACKUP="$CODEX_CONFIG.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$CODEX_CONFIG" "$CODEX_BACKUP"
    echo -e "${YELLOW}기존 설정 파일 백업됨: ${CODEX_BACKUP}${NC}"

    if grep -q "$CODEX_BEGIN" "$CODEX_CONFIG" 2>/dev/null; then
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' "/$CODEX_BEGIN/,/$CODEX_END/d" "$CODEX_CONFIG"
        else
            sed -i "/$CODEX_BEGIN/,/$CODEX_END/d" "$CODEX_CONFIG"
        fi
        echo -e "${BLUE}기존 Bedrock 블록을 제거했습니다.${NC}"
    fi
fi

# Bedrock 설정 블록을 파일 맨 앞에 삽입 (top-level 키는 테이블 헤더보다 앞에 와야 함)
CODEX_TMP=$(mktemp)
cat > "$CODEX_TMP" << EOF
$CODEX_BEGIN
# Codex는 Bedrock의 Responses API(bedrock-mantle 엔드포인트)를 사용합니다.
# 인증: AWS_BEARER_TOKEN_BEDROCK 이 있으면 bearer, 없으면 AWS 자격 증명(SigV4)을 사용합니다.
model_provider = "amazon-bedrock"
model = "${CODEX_MODEL}"
model_reasoning_effort = "medium"
model_providers.amazon-bedrock.aws.region = "${AWS_REGION_VALUE}"
$CODEX_END
EOF

if [ -f "$CODEX_CONFIG" ]; then
    cat "$CODEX_CONFIG" >> "$CODEX_TMP"
fi
cp "$CODEX_TMP" "$CODEX_CONFIG"
rm -f "$CODEX_TMP"

echo -e "${GREEN}Codex 설정 완료 (provider: amazon-bedrock, model: ${CODEX_MODEL})${NC}"

# ─── VS Code settings.json 설정 ───

# jq 설치 확인
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}jq가 설치되어 있지 않습니다. 설치 중...${NC}"
    if [[ "$(uname)" == "Darwin" ]]; then
        brew install jq
    else
        sudo yum install -y jq || sudo apt-get install -y jq
    fi
fi

# VS Code 설정 경로 결정
if [[ "$OS_TYPE" == "macOS" ]]; then
    SETTINGS_DIR="$HOME/Library/Application Support/Code/User"
    RESTART_CMD="VS Code를 재시작하세요."
else
    SETTINGS_DIR="$HOME/.local/share/code-server/User"
    RESTART_CMD="sudo systemctl restart code-server"
fi

SETTINGS_FILE="$SETTINGS_DIR/settings.json"

echo ""
echo "=== VS Code settings.json 설정 ==="
echo -e "${BLUE}설정 경로: ${SETTINGS_FILE}${NC}"

# 디렉토리 생성 (없는 경우)
mkdir -p "$SETTINGS_DIR"

# 기존 settings.json 백업
if [ -f "$SETTINGS_FILE" ]; then
    BACKUP_FILE="$SETTINGS_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$SETTINGS_FILE" "$BACKUP_FILE"
    echo -e "${YELLOW}기존 설정 파일 백업됨: ${BACKUP_FILE}${NC}"
fi

# 환경변수에서 값 읽기 (없으면 기본값)
SMALL_FAST_MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0"

# 임시 파일 생성
TEMP_FILE=$(mktemp)
TEMP_EXISTING=$(mktemp)

# bearer 토큰이 있을 때만 settings.json 에 포함
if [ -n "$AWS_TOKEN" ]; then
    BEARER_JSON_ENTRY="    {
        \"name\": \"AWS_BEARER_TOKEN_BEDROCK\",
        \"value\": \"${AWS_TOKEN}\"
    },"
else
    BEARER_JSON_ENTRY=""
fi

cat > "$TEMP_FILE" << EOF
{
    "claudeCode.environmentVariables": [
    {
        "name": "CLAUDE_CODE_USE_BEDROCK",
        "value": "1"
    },
    {
      "name": "CLAUDE_CODE_SKIP_AUTH_LOGIN",
      "value": "true"
    },
${BEARER_JSON_ENTRY}
    {
      "name": "AWS_REGION",
      "value": "${AWS_REGION_VALUE}"
    },
    {
        "name": "ANTHROPIC_MODEL",
        "value": "${SELECTED_MODEL}"
    },
    {
      "name": "ANTHROPIC_SMALL_FAST_MODEL",
      "value": "${SMALL_FAST_MODEL}"
    },
    {
      "name": "CLAUDE_CODE_SUBAGENT_MODEL",
      "value": "${SELECTED_MODEL}"
    },
    {
      "name": "MAX_THINKING_TOKENS",
      "value": "10240"
    },
    {
      "name": "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      "value": "${SELECTED_TOKENS}"
    }
    ],
    "claudeCode.disableLoginPrompt": true,
    "claudeCode.preferredLocation": "panel",
    "claudeCode.selectedModel": "${SELECTED_MODEL}"
}
EOF

# trailing comma 제거 함수
fix_json_trailing_comma() {
    cat "$1" | tr '\n' '\r' | sed 's/,\r\s*}/\r}/g; s/,\r\s*]/\r]/g' | tr '\r' '\n'
}

# 기존 파일이 있으면 병합, 없으면 새로 생성
if [ -f "$SETTINGS_FILE" ] && [ -s "$SETTINGS_FILE" ]; then
    echo -e "${BLUE}기존 설정 파일에 Claude Code 설정을 추가합니다...${NC}"
    fix_json_trailing_comma "$SETTINGS_FILE" > "$TEMP_EXISTING"
    MERGED_FILE=$(mktemp)
    if jq -s '.[0] * .[1]' "$TEMP_EXISTING" "$TEMP_FILE" > "$MERGED_FILE" 2>/dev/null; then
        cp "$MERGED_FILE" "$SETTINGS_FILE"
        echo -e "${GREEN}기존 설정과 병합 완료${NC}"
    else
        echo -e "${RED}JSON 병합 실패. 기존 파일 형식을 확인하세요.${NC}"
        echo -e "${YELLOW}백업 파일에서 복원 가능: ${BACKUP_FILE}${NC}"
        rm -f "$TEMP_FILE" "$TEMP_EXISTING" "$MERGED_FILE"
        exit 1
    fi
    rm -f "$MERGED_FILE"
else
    echo -e "${BLUE}새 설정 파일을 생성합니다...${NC}"
    cp "$TEMP_FILE" "$SETTINGS_FILE"
fi

rm -f "$TEMP_FILE" "$TEMP_EXISTING"

echo ""
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN} 설정이 완료되었습니다!${NC}"
echo -e "${GREEN}==========================================${NC}"
echo ""
echo "  인증         : ${AUTH_MODE}"
echo "  Claude Code : ${SELECTED_MODEL}"
echo "  Codex       : ${CODEX_MODEL}  (bedrock-mantle / Responses API)"
echo "  리전         : ${AWS_REGION_VALUE}"
echo ""
echo "설정을 적용하려면 다음을 실행하세요:"
echo "  source $SHELL_RC"
echo "  $RESTART_CMD"
echo ""
echo "동작 확인:"
echo "  claude -p 'say OK'"
echo "  codex exec 'say OK'"
