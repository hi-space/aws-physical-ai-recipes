#!/bin/bash

# Claude Code + Amazon Bedrock 셸 설정 스크립트 (Linux / macOS 공용)

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

echo "=== Claude Code + Amazon Bedrock 셸 설정 ==="
echo "  대상 OS: $OS_TYPE"
echo "  설정 파일: $SHELL_RC"
echo

# AWS_BEARER_TOKEN_BEDROCK 값 입력받기
read -p "AWS_BEARER_TOKEN_BEDROCK 값을 입력하세요: " AWS_TOKEN

if [ -z "$AWS_TOKEN" ]; then
    echo "오류: AWS_BEARER_TOKEN_BEDROCK 값이 비어있습니다."
    exit 1
fi

# ANTHROPIC_MODEL 선택
echo
echo "사용할 모델을 선택하세요:"
echo "  1) opus4.6 1M   (global.anthropic.claude-opus-4-6-v1[1m])"
echo "  2) sonnet4.6 1M (global.anthropic.claude-sonnet-4-6[1m])"
echo
read -p "선택 (1 또는 2, 기본값: 1): " MODEL_CHOICE

case "$MODEL_CHOICE" in
    2)
        SELECTED_MODEL="global.anthropic.claude-sonnet-4-6[1m]"
        echo "선택된 모델: sonnet4.6 1M"
        ;;
    *)
        SELECTED_MODEL="global.anthropic.claude-opus-4-6-v1[1m]"
        echo "선택된 모델: opus4.6 1M"
        ;;
esac

# CLAUDE_CODE_MAX_OUTPUT_TOKENS 선택
echo
echo "Max Output Tokens를 선택하세요:"
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

# 기존 설정 확인
if grep -q "# Claude Code + Amazon Bedrock 설정" "$SHELL_RC" 2>/dev/null; then
    echo "기존 Claude Code + Bedrock 설정이 발견되었습니다."
    read -p "기존 설정을 덮어쓰시겠습니까? (y/n): " OVERWRITE
    if [ "$OVERWRITE" = "y" ] || [ "$OVERWRITE" = "Y" ]; then
        # 기존 설정 제거 (macOS BSD sed와 GNU sed 호환)
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' '/# Claude Code + Amazon Bedrock 설정/,/^$/d' "$SHELL_RC"
        else
            sed -i '/# Claude Code + Amazon Bedrock 설정/,/^$/d' "$SHELL_RC"
        fi
        echo "기존 설정을 제거했습니다."
    else
        echo "설정을 취소합니다."
        exit 0
    fi
fi

# bashrc에 설정 추가
cat >> "$SHELL_RC" << EOF

# Claude Code + Amazon Bedrock 설정
export ANTHROPIC_API_KEY="${ANTHROPIC_KEY}"
export AWS_BEARER_TOKEN_BEDROCK='${AWS_TOKEN}'
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_MODEL='${SELECTED_MODEL}'
export ANTHROPIC_DEFAULT_OPUS_MODEL='global.anthropic.claude-opus-4-6-v1[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='global.anthropic.claude-sonnet-4-6[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='global.anthropic.claude-haiku-4-5-20251001-v1:0'
export ANTHROPIC_SMALL_FAST_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${SELECTED_TOKENS}

EOF

echo
echo "셸 환경변수 설정이 추가되었습니다."

# ─── VS Code settings.json 설정 ───

# 색상 정의
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

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
    {
        "name": "AWS_BEARER_TOKEN_BEDROCK",
        "value": "${AWS_TOKEN}"
    },
    {
      "name": "AWS_REGION",
      "value": "us-east-1"
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
echo "설정을 적용하려면 다음을 실행하세요:"
echo "  source $SHELL_RC"
echo "  $RESTART_CMD"
