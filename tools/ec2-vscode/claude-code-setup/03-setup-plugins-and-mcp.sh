#!/bin/bash
###############################################################################
# Claude Code - 플러그인 + AWS MCP 서버 통합 설정 스크립트
#
# [플러그인] claude-plugins-official (48개) + agent-plugins-for-aws (1개)
# [MCP 서버] awslabs-terraform-mcp-server
#            awslabs-core-mcp-server
#            bedrock-agentcore-mcp-server
###############################################################################

set -euo pipefail

# ANSI 색상 코드
CYAN='\033[0;36m'    # INFO
GREEN='\033[0;32m'   # OK
YELLOW='\033[1;33m'  # WARN
RED='\033[0;31m'     # FAIL
NC='\033[0m'         # 색상 초기화

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# 플러그인 설치 함수
install_plugin() {
    local name="$1"
    local marketplace="$2"

    if claude plugin install "${name}@${marketplace}" 2>&1; then
        ok "$name"
    else
        warn "$name (이미 설치되어 있거나 설치 실패)"
    fi
}

###############################################################################
# 1. 사전 요구사항 확인
###############################################################################
info "=== 사전 요구사항 확인 ==="

# claude CLI 확인
if command -v claude >/dev/null 2>&1; then
    ok "claude CLI: $(claude --version 2>&1 | head -1)"
else
    fail "claude CLI가 설치되어 있지 않습니다. 설치: https://docs.anthropic.com/en/docs/claude-code"
fi

# uvx 확인
if command -v uvx >/dev/null 2>&1; then
    ok "uvx: $(uvx --version 2>&1 | head -1)"
else
    fail "uvx가 설치되어 있지 않습니다. 설치: curl -LsSf https://astral.sh/uv/install.sh | sh"
fi

# AWS 자격 증명 확인
if aws sts get-caller-identity >/dev/null 2>&1; then
    ok "AWS 자격 증명: 정상"
else
    warn "AWS 자격 증명이 설정되지 않았습니다. 일부 MCP 서버가 정상 동작하지 않을 수 있습니다."
fi

echo ""

###############################################################################
# 2. 마켓플레이스 등록
###############################################################################
info "=== 마켓플레이스 등록 ==="

# claude-plugins-official
if [ -d "$HOME/.claude/plugins/marketplaces/claude-plugins-official" ]; then
    ok "claude-plugins-official 이미 존재"
else
    info "anthropics/claude-plugins-official 추가 중..."
    claude plugin marketplace add anthropics/claude-plugins-official 2>&1 && ok "claude-plugins-official 추가 완료" || warn "추가 실패"
fi

# agent-plugins-for-aws
if [ -d "$HOME/.claude/plugins/marketplaces/agent-plugins-for-aws" ]; then
    ok "agent-plugins-for-aws 이미 존재"
else
    info "awslabs/agent-plugins 추가 중..."
    claude plugin marketplace add awslabs/agent-plugins 2>&1 && ok "agent-plugins-for-aws 추가 완료" || warn "추가 실패"
fi

echo ""

###############################################################################
# 3. claude-plugins-official 플러그인 설치 (48개)
###############################################################################
info "=== claude-plugins-official 플러그인 설치 (48개) ==="

OFFICIAL_PLUGINS=(
    # 개발 워크플로우 (12)
    "commit-commands"
    "code-review"
    "code-simplifier"
    "feature-dev"
    "pr-review-toolkit"
    "claude-md-management"
    "plugin-dev"
    "agent-sdk-dev"
    "claude-code-setup"
    "hookify"
    "mcp-server-dev"
    "skill-creator"

    # 프론트엔드 / 디자인 (1)
    "frontend-design"

    # LSP 언어 서버 (12)
    "pyright-lsp"
    "typescript-lsp"
    "gopls-lsp"
    "jdtls-lsp"
    "clangd-lsp"
    "csharp-lsp"
    "kotlin-lsp"
    "lua-lsp"
    "php-lsp"
    "ruby-lsp"
    "rust-analyzer-lsp"
    "swift-lsp"

    # 외부 서비스 연동 - external_plugins (14)
    "context7"
    "playwright"
    "slack"
    "stripe"
    "linear"
    "supabase"
    "serena"
    "github"
    "gitlab"
    "asana"
    "discord"
    "firebase"
    "greptile"
    "telegram"

    # 유틸리티 / 스타일 (9)
    "ralph-loop"
    "superpowers"
    "qodo-skills"
    "explanatory-output-style"
    "learning-output-style"
    "security-guidance"
    "playground"
    "math-olympiad"
    "laravel-boost"
)

TOTAL=${#OFFICIAL_PLUGINS[@]}
COUNT=0

for plugin in "${OFFICIAL_PLUGINS[@]}"; do
    COUNT=$((COUNT + 1))
    info "($COUNT/$TOTAL) $plugin 설치 중..."
    install_plugin "$plugin" "claude-plugins-official"
done

echo ""

###############################################################################
# 4. agent-plugins-for-aws 플러그인 설치 (1개)
###############################################################################
info "=== agent-plugins-for-aws 플러그인 설치 (1개) ==="

info "(1/1) deploy-on-aws 설치 중..."
install_plugin "deploy-on-aws" "agent-plugins-for-aws"

echo ""

###############################################################################
# 5. AWS MCP 서버 등록 (3개)
###############################################################################
info "=== AWS MCP 서버 등록 (3개) ==="

# awslabs-terraform-mcp-server
info "(1/3) awslabs-terraform-mcp-server 등록 중..."
if claude mcp add \
    -s user \
    "awslabs-terraform-mcp-server" \
    -e FASTMCP_LOG_LEVEL=ERROR \
    -- uvx "awslabs.terraform-mcp-server@latest" 2>&1; then
    ok "awslabs-terraform-mcp-server"
else
    warn "awslabs-terraform-mcp-server (이미 등록되어 있을 수 있습니다)"
fi

# awslabs-core-mcp-server
info "(2/3) awslabs-core-mcp-server 등록 중..."
if claude mcp add \
    -s user \
    "awslabs-core-mcp-server" \
    -e FASTMCP_LOG_LEVEL=ERROR \
    -e "aws-foundation=true" \
    -e "solutions-architect=true" \
    -- uvx "awslabs.core-mcp-server@latest" 2>&1; then
    ok "awslabs-core-mcp-server"
else
    warn "awslabs-core-mcp-server (이미 등록되어 있을 수 있습니다)"
fi

# bedrock-agentcore-mcp-server
info "(3/3) bedrock-agentcore-mcp-server 등록 중..."
if claude mcp add \
    -s user \
    "bedrock-agentcore-mcp-server" \
    -e FASTMCP_LOG_LEVEL=ERROR \
    -- uvx "awslabs.amazon-bedrock-agentcore-mcp-server@latest" 2>&1; then
    ok "bedrock-agentcore-mcp-server"
else
    warn "bedrock-agentcore-mcp-server (이미 등록되어 있을 수 있습니다)"
fi

echo ""

###############################################################################
# 6. 설정 결과 요약
###############################################################################
info "=== 설정 결과 요약 ==="

echo ""
info "등록된 플러그인:"
claude plugin list 2>&1

echo ""
info "등록된 MCP 서버:"
claude mcp list 2>&1

echo ""
ok "모든 설정이 완료되었습니다! Claude Code를 재시작하면 적용됩니다."
echo ""
echo "  [플러그인 - claude-plugins-official] 48개"
echo "    개발 워크플로우 (12) : commit-commands, code-review, code-simplifier,"
echo "                           feature-dev, pr-review-toolkit, claude-md-management,"
echo "                           plugin-dev, agent-sdk-dev, claude-code-setup,"
echo "                           hookify, mcp-server-dev, skill-creator"
echo "    프론트엔드 (1)       : frontend-design"
echo "    LSP (12)             : pyright, typescript, gopls, jdtls, clangd,"
echo "                           csharp, kotlin, lua, php, ruby, rust-analyzer, swift"
echo "    외부 서비스 (14)     : context7, playwright, slack, stripe, linear,"
echo "                           supabase, serena, github, gitlab, asana,"
echo "                           discord, firebase, greptile, telegram"
echo "    유틸리티 (9)         : ralph-loop, superpowers, qodo-skills,"
echo "                           explanatory-output-style, learning-output-style,"
echo "                           security-guidance, playground, math-olympiad,"
echo "                           laravel-boost"
echo ""
echo "  [플러그인 - agent-plugins-for-aws] 1개"
echo "    deploy-on-aws        : awsiac, awsknowledge, awspricing"
echo ""
echo "  [MCP 서버] 3개"
echo "    awslabs-terraform-mcp-server      : Terraform/Terragrunt AWS 인프라 개발"
echo "    awslabs-core-mcp-server           : AWS API, Cost Explorer, 다이어그램, 가격 분석"
echo "    bedrock-agentcore-mcp-server      : Bedrock AgentCore Gateway, Memory, Runtime"
