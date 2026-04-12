# Claude Code + Amazon Bedrock 설정

EC2에 배포된 VSCode Server에서 Claude Code를 Amazon Bedrock과 연동하는 스크립트 모음입니다.
Linux (EC2/Amazon Linux) 및 macOS 환경 모두 지원합니다.

## 사전 조건

| 항목 | 확인 | 설치 (Linux) |
|------|------|-------------|
| Claude Code CLI | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| Node.js / npm | `node --version` | `sudo dnf install -y nodejs` |
| uv / uvx | `uvx --version` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| AWS CLI | `aws --version` | EC2 UserData에서 자동 설치됨 |
| jq | `jq --version` | `sudo dnf install -y jq` (01번에서 자동 설치) |

## 실행 순서

```
01-setup-bedrock-env.sh          Bedrock 환경변수 + VS Code 설정
        |
        v
   source ~/.bashrc               환경변수 적용
        |
        v
02-setup-plugins-and-mcp.sh      플러그인 + MCP 서버 설치
```

## 빠른 시작

```bash
# SSM 또는 브라우저 터미널에서 실행
cd claude-code-setup

# 1. Bedrock 환경변수 + VS Code 설정
bash 01-setup-bedrock-env.sh
source ~/.bashrc

# 2. 플러그인 + MCP 서버 설치
bash 02-setup-plugins-and-mcp.sh
```

## 스크립트 상세

### 01-setup-bedrock-env.sh

Bedrock 연동에 필요한 환경변수를 `~/.bashrc`에 추가하고, VS Code `settings.json`도 함께 설정합니다.

**입력 항목:**
- `AWS_BEARER_TOKEN_BEDROCK`
- 모델 선택 (Opus 4.6 1M / Sonnet 4.6 1M)
- Max Output Tokens (4096 / 16384 / 32768)

**설정되는 환경변수 (~/.bashrc):**
```bash
ANTHROPIC_API_KEY
AWS_BEARER_TOKEN_BEDROCK
CLAUDE_CODE_USE_BEDROCK=1
ANTHROPIC_MODEL                    # 선택한 모델
ANTHROPIC_DEFAULT_OPUS_MODEL       # global.anthropic.claude-opus-4-6-v1[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL     # global.anthropic.claude-sonnet-4-6[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL      # global.anthropic.claude-haiku-4-5-20251001-v1:0
ANTHROPIC_SMALL_FAST_MODEL         # us.anthropic.claude-haiku-4-5-20251001-v1:0
CLAUDE_CODE_MAX_OUTPUT_TOKENS      # 선택한 값
```

**VS Code 설정 (settings.json):**
```
Linux (code-server):  ~/.local/share/code-server/User/settings.json
macOS (VS Code):      ~/Library/Application Support/Code/User/settings.json
```

입력한 값으로 `claudeCode.environmentVariables`, `claudeCode.selectedModel` 등을 자동 설정합니다.
기존 `settings.json`이 있으면 병합하고, 없으면 새로 생성합니다.

### 02-setup-plugins-and-mcp.sh

Claude Code 플러그인과 AWS MCP 서버를 일괄 설치합니다.

**설치 내용:**

| 구분 | 개수 | 주요 항목 |
|------|------|----------|
| 플러그인 (official) | 48개 | commit-commands, code-review, frontend-design, pyright-lsp, typescript-lsp, context7, playwright, github, slack 등 |
| 플러그인 (AWS) | 1개 | deploy-on-aws (awsiac, awsknowledge, awspricing) |
| MCP 서버 | 3개 | terraform, core, bedrock-agentcore |
