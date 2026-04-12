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
| jq | `jq --version` | `sudo dnf install -y jq` (02번에서 자동 설치) |

## 실행 순서

```
01-setup-bedrock-env.sh          Bedrock 환경변수 설정 (.bashrc)
        |
        v
   source ~/.bashrc               환경변수 적용
        |
        v
02-setup-vscode-settings.sh      VS Code 확장 설정 (code-server)
        |
        v
03-setup-plugins-and-mcp.sh      플러그인 48개 + MCP 서버 3개 설치
        |
        v
04-update-claude.sh              Claude Code 업데이트 (선택)
        |
        v
05-switch-mode.sh                C4E/구독형/Bedrock 모드 전환 (선택)
        |
        v
06-setup-aws-skills.sh           AWS Skills 36개 설치 (선택)
```

## 빠른 시작

```bash
# SSM 또는 브라우저 터미널에서 실행
cd claude-code-setup

# 1. Bedrock 환경변수 설정
bash 01-setup-bedrock-env.sh
source ~/.bashrc

# 2. VS Code 확장 설정
bash 02-setup-vscode-settings.sh

# 3. 플러그인 + MCP 서버 설치
bash 03-setup-plugins-and-mcp.sh
```

## 스크립트 상세

### 01-setup-bedrock-env.sh

Bedrock 연동에 필요한 환경변수를 `~/.bashrc`에 추가합니다.

**입력 항목:**
- `ANTHROPIC_API_KEY`
- `AWS_BEARER_TOKEN_BEDROCK`
- 모델 선택 (Opus 4.6 1M / Sonnet 4.6 1M)
- Max Output Tokens (4096 / 16384 / 32768)

**설정되는 환경변수:**
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

### 02-setup-vscode-settings.sh

code-server의 `settings.json`에 Claude Code 확장 설정을 추가합니다.

**입력 항목:**
- `AWS_BEARER_TOKEN_BEDROCK`

**설정 경로:**
```
Linux (code-server):  ~/.local/share/code-server/User/settings.json
macOS (VS Code):      ~/Library/Application Support/Code/User/settings.json
```

설정 후 `sudo systemctl restart code-server`로 재시작합니다.

### 03-setup-plugins-and-mcp.sh

Claude Code 플러그인과 AWS MCP 서버를 일괄 설치합니다.

**설치 내용:**

| 구분 | 개수 | 주요 항목 |
|------|------|----------|
| 플러그인 (official) | 48개 | commit-commands, code-review, frontend-design, pyright-lsp, typescript-lsp, context7, playwright, github, slack 등 |
| 플러그인 (AWS) | 1개 | deploy-on-aws (awsiac, awsknowledge, awspricing) |
| MCP 서버 | 3개 | terraform, core, bedrock-agentcore |

### 04-update-claude.sh

Claude Code CLI를 최신 버전으로 업데이트합니다.

```bash
bash 04-update-claude.sh
```

### 05-switch-mode.sh

C4E (Enterprise) / 구독형 / Bedrock API 모드를 전환합니다.

```bash
bash 05-switch-mode.sh              # 대화형 메뉴
bash 05-switch-mode.sh status       # 현재 모드 확인
bash 05-switch-mode.sh c4e          # C4E로 전환
bash 05-switch-mode.sh subscription # 구독형으로 전환
bash 05-switch-mode.sh bedrock      # Bedrock으로 전환
```

**모드 비교:**

| 항목 | C4E | 구독형 | Bedrock |
|------|-----|--------|---------|
| 인증 | OAuth/SSO | API Key | API Key + Bearer Token |
| 모델 ID | `claude-opus-4-6` | `claude-opus-4-6` | `global.anthropic.claude-opus-4-6-v1[1m]` |

### 06-setup-aws-skills.sh

[aws-skills-for-claude-code](https://github.com/whchoi98/aws-skills-for-claude-code) 리포지토리에서 36개 AWS 스킬을 설치합니다.

```bash
bash 06-setup-aws-skills.sh
```

**설치되는 스킬 (36개):**

| 카테고리 | 스킬 |
|----------|------|
| AWS 서비스 (16) | aws-agentcore, aws-amplify, aws-cloudwatch, aws-cost, aws-iac, aws-iam, aws-infra, aws-security 등 |
| 마이그레이션 (5) | aws-graviton-migration, aws-mcp, gcp-aws-migrate 등 |
| 외부 서비스 (9) | datadog, dynatrace, figma, neon, stripe, terraform 등 |
| 개발 워크플로우 (6) | code-review, refactor, release, sync-docs 등 |
