#!/bin/bash

# Claude Code + Codex CLI 설치 스크립트 (Linux / macOS 공용)
# 두 CLI를 설치하고, code-server 확장까지 함께 설치합니다.
# Bedrock 연동 설정은 01-setup-bedrock-env.sh 에서 수행합니다.

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

if [[ "$(uname)" == "Darwin" ]]; then
    OS_TYPE="macOS"
else
    OS_TYPE="Linux"
fi

echo "=== Claude Code + Codex CLI 설치 ==="
echo "  대상 OS: $OS_TYPE"
echo

# ─── Node.js / npm 확인 ───

if ! command -v npm &> /dev/null; then
    echo -e "${YELLOW}npm이 없습니다. Node.js를 설치합니다...${NC}"
    if [[ "$OS_TYPE" == "macOS" ]]; then
        if command -v brew &> /dev/null; then
            brew install node
        else
            echo -e "${RED}Homebrew가 없습니다. https://nodejs.org 에서 Node.js를 설치한 뒤 다시 실행하세요.${NC}"
            exit 1
        fi
    else
        sudo dnf install -y nodejs npm || sudo apt-get update -y && sudo apt-get install -y nodejs npm
    fi
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}npm 설치에 실패했습니다. Node.js를 먼저 설치하세요.${NC}"
    exit 1
fi

echo -e "${BLUE}node: $(node --version 2>/dev/null)  npm: $(npm --version 2>/dev/null)${NC}"
echo

# ─── 공통 설치 함수 ───

# npm 글로벌 bin이 PATH에 없는 경우 /usr/local/bin 으로 심볼릭 링크
link_if_missing() {
    local BIN_NAME="$1"
    local NPM_PREFIX
    NPM_PREFIX="$(npm prefix -g 2>/dev/null)"

    if command -v "$BIN_NAME" &> /dev/null; then
        return 0
    fi

    if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/bin/$BIN_NAME" ]; then
        if ln -sf "$NPM_PREFIX/bin/$BIN_NAME" "/usr/local/bin/$BIN_NAME" 2>/dev/null \
            || sudo ln -sf "$NPM_PREFIX/bin/$BIN_NAME" "/usr/local/bin/$BIN_NAME" 2>/dev/null; then
            echo -e "${GREEN}${BIN_NAME} 링크 생성: $NPM_PREFIX/bin/$BIN_NAME -> /usr/local/bin/$BIN_NAME${NC}"
        else
            echo -e "${YELLOW}${BIN_NAME}이(가) PATH에 없습니다. 다음을 셸 설정에 추가하세요:${NC}"
            echo "  export PATH=\"$NPM_PREFIX/bin:\$PATH\""
        fi
    fi
}

# npm 글로벌 설치 (1회 재시도)
npm_install_global() {
    local PKG="$1"
    npm install -g "$PKG" || {
        echo -e "${YELLOW}${PKG} 설치 실패. 10초 후 재시도합니다...${NC}"
        sleep 10
        npm install -g "$PKG" || return 1
    }
}

# ─── Claude Code CLI 설치 ───

echo "--- Claude Code CLI ---"
if command -v claude &> /dev/null; then
    echo -e "${BLUE}이미 설치됨: $(claude --version 2>/dev/null)${NC}"
    read -p "최신 버전으로 업데이트하시겠습니까? (y/N): " UPDATE_CLAUDE
    if [ "$UPDATE_CLAUDE" = "y" ] || [ "$UPDATE_CLAUDE" = "Y" ]; then
        npm_install_global "@anthropic-ai/claude-code" || echo -e "${RED}Claude Code 업데이트 실패${NC}"
    fi
else
    npm_install_global "@anthropic-ai/claude-code" || echo -e "${RED}Claude Code 설치 실패${NC}"
fi
link_if_missing "claude"
echo

# ─── Codex CLI 설치 ───

echo "--- Codex CLI ---"
if command -v codex &> /dev/null; then
    echo -e "${BLUE}이미 설치됨: $(codex --version 2>/dev/null)${NC}"
    read -p "최신 버전으로 업데이트하시겠습니까? (y/N): " UPDATE_CODEX
    if [ "$UPDATE_CODEX" = "y" ] || [ "$UPDATE_CODEX" = "Y" ]; then
        # 표준 설치(~/.local/bin)라면 codex 자체 업데이터가 더 안전
        if codex update 2>/dev/null; then
            echo -e "${GREEN}codex update 완료${NC}"
        else
            npm_install_global "@openai/codex" || echo -e "${RED}Codex 업데이트 실패${NC}"
        fi
    fi
else
    npm_install_global "@openai/codex" || echo -e "${RED}Codex 설치 실패${NC}"
fi
link_if_missing "codex"
echo

# ─── code-server / VS Code 확장 설치 (선택) ───

CODE_CMD=""
if [ -x /usr/local/bin/code-server ]; then
    CODE_CMD="/usr/local/bin/code-server"
elif command -v code-server &> /dev/null; then
    CODE_CMD="$(command -v code-server)"
elif command -v code &> /dev/null; then
    CODE_CMD="$(command -v code)"
fi

if [ -n "$CODE_CMD" ]; then
    echo "--- VS Code 확장 설치 ($CODE_CMD) ---"
    read -p "Claude Code / Codex 확장을 설치하시겠습니까? (Y/n): " INSTALL_EXT
    if [ "$INSTALL_EXT" != "n" ] && [ "$INSTALL_EXT" != "N" ]; then
        "$CODE_CMD" --install-extension Anthropic.claude-code \
            || echo -e "${YELLOW}[WARN] Claude Code 확장 설치 실패${NC}"
        "$CODE_CMD" --install-extension openai.chatgpt \
            || echo -e "${YELLOW}[WARN] Codex(ChatGPT) 확장 설치 실패${NC}"
    fi
    echo
else
    echo -e "${YELLOW}code-server / code 명령을 찾지 못해 확장 설치를 건너뜁니다.${NC}"
    echo
fi

# ─── 결과 확인 ───

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN} 설치 결과${NC}"
echo -e "${GREEN}==========================================${NC}"

FAILED=0
if command -v claude &> /dev/null; then
    echo -e "  claude : ${GREEN}$(claude --version 2>/dev/null)${NC}"
else
    echo -e "  claude : ${RED}설치되지 않음${NC}"
    FAILED=1
fi

if command -v codex &> /dev/null; then
    echo -e "  codex  : ${GREEN}$(codex --version 2>/dev/null)${NC}"
else
    echo -e "  codex  : ${RED}설치되지 않음${NC}"
    FAILED=1
fi

echo
if [ "$FAILED" -eq 1 ]; then
    echo -e "${YELLOW}일부 CLI가 설치되지 않았습니다. 위 로그를 확인하세요.${NC}"
    exit 1
fi

echo "다음 단계:"
echo "  bash 01-setup-bedrock-env.sh   # Bedrock 환경변수 + Codex/VS Code 설정"
