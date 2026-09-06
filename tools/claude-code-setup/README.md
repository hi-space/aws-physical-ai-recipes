# Claude Code + Codex + Amazon Bedrock 설정

EC2에 배포된 VSCode Server에서 Claude Code와 Codex CLI를 Amazon Bedrock과 연동하는 스크립트 모음입니다.
Linux (EC2/Amazon Linux) 및 macOS 환경 모두 지원합니다.

## 사전 조건

| 항목 | 확인 | 설치 (Linux) |
|------|------|-------------|
| Node.js / npm | `node --version` | `sudo dnf install -y nodejs` (00번에서 자동 설치) |
| Claude Code CLI | `claude --version` | 00번에서 자동 설치 |
| Codex CLI | `codex --version` | 00번에서 자동 설치 (0.144.0 이상 필요) |
| uv / uvx | `uvx --version` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| AWS CLI | `aws --version` | 대부분의 EC2 AMI에 기본 포함 (없으면 [설치 가이드](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)) |
| jq | `jq --version` | `sudo dnf install -y jq` (01번에서 자동 설치) |

Bedrock API 키는 [Amazon Bedrock 콘솔 > API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)에서 발급합니다.

## 실행 순서

```
00-install-claude-codex.sh       Claude Code + Codex CLI 설치 (+ VS Code 확장)
        |
        v
01-setup-bedrock-env.sh          Bedrock 환경변수 + Codex config.toml + VS Code 설정
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

# 0. CLI 설치 (claude + codex)
bash 00-install-claude-codex.sh

# 1. Bedrock 환경변수 + Codex/VS Code 설정
bash 01-setup-bedrock-env.sh
source ~/.bashrc

# 2. 플러그인 + MCP 서버 설치
bash 02-setup-plugins-and-mcp.sh

# 동작 확인
claude -p 'say OK'
codex exec 'say OK'
```

## 스크립트 상세

### 00-install-claude-codex.sh

Claude Code CLI와 Codex CLI를 함께 설치합니다.

- npm이 없으면 Node.js를 먼저 설치
- `npm install -g @anthropic-ai/claude-code`, `npm install -g @openai/codex` (실패 시 1회 재시도)
- npm 글로벌 bin이 PATH 밖에 있으면 `/usr/local/bin`에 심볼릭 링크 생성 (fnm/nvm 환경 대응)
- 이미 설치된 경우 업데이트 여부를 물어봄 (Codex는 `codex update` 우선 사용)
- `code-server`/`code`가 있으면 `Anthropic.claude-code`, `openai.chatgpt` 확장도 설치

### 01-setup-bedrock-env.sh

Bedrock 연동 설정을 세 곳에 적용합니다: 셸 RC 파일, Codex `config.toml`, VS Code `settings.json`.

**입력 항목:**
- `AWS_BEARER_TOKEN_BEDROCK` (Claude Code와 Codex가 공유)
- AWS 리전 (기본값: `us-east-1`)
- Claude Code 모델 (Sonnet 5 1M / Opus 5 1M, 기본값: Sonnet 5)
- Codex 모델 (gpt-5.6-terra / gpt-5.5 / gpt-5.4)
- Max Output Tokens (4096 / 16384 / 32768)

**설정되는 환경변수 (~/.bashrc):**
```bash
AWS_BEARER_TOKEN_BEDROCK           # 공통 (Claude Code + Codex). 선택 — 비우면 AWS 자격 증명(SigV4)으로 호출
AWS_REGION                         # 공통, 입력한 리전
CLAUDE_CODE_USE_BEDROCK=1
ANTHROPIC_MODEL                    # 선택한 모델
ANTHROPIC_DEFAULT_OPUS_MODEL       # global.anthropic.claude-opus-4-6-v1
ANTHROPIC_DEFAULT_SONNET_MODEL     # global.anthropic.claude-sonnet-4-5-20250929-v1:0
ANTHROPIC_DEFAULT_HAIKU_MODEL      # global.anthropic.claude-haiku-4-5-20251001-v1:0
ANTHROPIC_SMALL_FAST_MODEL         # us.anthropic.claude-haiku-4-5-20251001-v1:0
CLAUDE_CODE_MAX_OUTPUT_TOKENS      # 선택한 값
```

`# BEGIN ... # END` 마커로 감싸 추가하므로, 재실행 시 해당 블록만 교체하고 나머지 RC 내용은 보존합니다.

**Codex 설정 (~/.codex/config.toml):**
```toml
# BEGIN Amazon Bedrock 설정
model_provider = "amazon-bedrock"
model = "openai.gpt-5.6-terra"
model_reasoning_effort = "medium"
model_providers.amazon-bedrock.aws.region = "us-east-1"
# END Amazon Bedrock 설정
```

Codex 0.144부터 `amazon-bedrock` 프로바이더가 내장되어 있어, `AWS_BEARER_TOKEN_BEDROCK`만 있으면
별도 로그인 없이 Bedrock으로 호출됩니다. 기존 `config.toml`의 MCP 서버·hooks 설정은 그대로 유지하고
Bedrock 블록만 파일 앞부분에 삽입/교체합니다 (백업 파일도 함께 생성).

> **Codex의 모델 제약**
> Codex는 Bedrock의 **Responses API** (`bedrock-mantle` 엔드포인트)만 사용합니다.
> Bedrock에서 Claude 모델은 이 API를 지원하지 않아 (`does not support the '/openai/v1/responses' API`)
> Codex에는 `openai.gpt-5.x` 계열만 지정할 수 있습니다. Claude 모델은 Claude Code 쪽에서 사용하세요.
> 사용 가능한 모델 목록은 아래로 조회할 수 있습니다.
> ```bash
> curl -s "https://bedrock-mantle.$AWS_REGION.api.aws/v1/models" \
>   -H "Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK" | jq -r '.data[].id' | sort
> ```

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
