#!/bin/bash

echo "=== Claude Code 업데이트 시작 ==="
echo ""

# 현재 버전 확인
echo "현재 버전:"
claude --version
echo ""

# 업데이트 실행 (npm latest 채널 사용 — brew cask는 stable 채널이라 버전이 느림)
echo "업데이트 중..."
if [[ "$(uname)" == "Darwin" ]]; then
    # macOS: brew cask가 설치되어 있으면 제거 안내 후 npm으로 통일
    if brew list --cask claude-code &>/dev/null; then
        echo "⚠️  brew cask (stable 채널)로 설치되어 있습니다."
        echo "   npm (latest 채널)이 더 빠르게 최신 버전을 제공합니다."
        echo ""
        read -p "brew cask를 제거하고 npm으로 전환하시겠습니까? (y/n, 기본값: y): " SWITCH
        if [ "$SWITCH" != "n" ] && [ "$SWITCH" != "N" ]; then
            echo "brew cask 제거 중..."
            brew uninstall --cask claude-code
            echo "npm으로 설치 중..."
            npm install -g @anthropic-ai/claude-code
        else
            echo "brew cask로 업데이트합니다 (stable 채널)..."
            brew upgrade claude-code
        fi
    else
        npm update -g @anthropic-ai/claude-code
    fi
else
    # Linux: 글로벌 설치는 sudo 필요
    sudo npm update -g @anthropic-ai/claude-code
fi

# 업데이트 후 버전 확인
echo ""
echo "업데이트 완료! 새 버전:"
claude --version
echo ""
echo "=== 업데이트 완료 ==="
