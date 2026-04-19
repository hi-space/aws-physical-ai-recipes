# EC2 개발 환경 설정

EC2 인스턴스에 SSH 접속과 Claude Code + Bedrock 연동을 설정하는 가이드 및 스크립트입니다.

> EC2 배포는 [simulation/isaac-lab/infra-multiuser-groot](../../simulation/isaac-lab/infra-multiuser-groot/) CDK 프로젝트에서 code-server(VSCode)를 포함하여 수행합니다.

## 구성

```
ec2-vscode/
├── 01-setup-ssh-client.sh       # SSH 키 생성 + config 설정 자동화
├── 02-setup-bedrock-env.sh      # Bedrock 환경변수 + VS Code 설정
└── 03-setup-plugins-and-mcp.sh  # 플러그인 + MCP 서버 설치
```

---

## 1. SSH 접속 설정

로컬 PC에서 SSH 키 생성과 `~/.ssh/config` 설정을 자동으로 수행합니다.

```bash
bash 01-setup-ssh-client.sh <PUBLIC_IP>
```

스크립트 실행 후 출력되는 공개키 등록 명령어를 EC2 Instance Connect 브라우저 터미널에서 실행하면 바로 접속할 수 있습니다.

```bash
ssh isaaclab
```

### 인스턴스 정보

관리자에게 아래 정보를 전달받으세요.

| 항목 | 값 |
|------|-----|
| Instance ID | `<INSTANCE_ID>` |
| Region | `<REGION>` |
| Public IP | `<PUBLIC_IP>` |
| OS | Ubuntu 22.04 |
| Instance Type | g6.12xlarge |
| 접속 유저 | `ubuntu` |

### 수동 설정 (스크립트 대신)

#### SSH 키 생성 (키가 없는 경우)

```bash
# [로컬]
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
```

#### SSH Config 설정

로컬 PC의 `~/.ssh/config` 파일에 아래 내용을 추가합니다. `<PUBLIC_IP>`를 전달받은 IP로 교체하세요.

```
# [로컬] ~/.ssh/config 에 추가
Host isaaclab
    HostName <PUBLIC_IP>
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
```

#### 최초 접속 (공개키 등록)

1. 로컬 공개키 확인:
   ```bash
   # [로컬]
   cat ~/.ssh/id_ed25519.pub
   ```

2. AWS 콘솔 > EC2 > 인스턴스 선택 > **연결** > **EC2 Instance Connect** 탭 > **연결**

3. 브라우저 터미널에서 실행:
   ```bash
   # [EC2 인스턴스]
   echo "전달받은_공개키_내용" >> /home/ubuntu/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   ```

### 트러블슈팅

| 증상 | 원인 및 해결 |
|------|-------------|
| `Permission denied (publickey)` | 인스턴스에 공개키가 등록되지 않음. 위 "최초 접속" 섹션을 따라 키 등록 필요 |
| `Connection timed out` | 보안 그룹에서 22번 포트가 열려 있는지 확인. 인스턴스가 실행 중인지 확인 |
| `send-ssh-public-key` 실패 | IAM 권한에 `ec2-instance-connect:SendSSHPublicKey` 액션이 허용되어 있는지 확인 |
| ProxyCommand 관련 오류 (SSM 방식) | Session Manager Plugin 설치 여부 확인: `session-manager-plugin --version` |

---

## 2. Claude Code + Bedrock 설정

EC2 인스턴스에서 Claude Code를 Amazon Bedrock과 연동합니다.

### 사전 조건

| 항목 | 확인 | 설치 (Linux) |
|------|------|-------------|
| Claude Code CLI | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| Node.js / npm | `node --version` | `sudo dnf install -y nodejs` |
| uv / uvx | `uvx --version` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| AWS CLI | `aws --version` | EC2 UserData에서 자동 설치됨 |
| jq | `jq --version` | `sudo dnf install -y jq` (02번에서 자동 설치) |

### 실행

```bash
# SSM 또는 SSH 터미널에서 실행

# 2. Bedrock 환경변수 + VS Code 설정
bash 02-setup-bedrock-env.sh
source ~/.bashrc

# 3. 플러그인 + MCP 서버 설치
bash 03-setup-plugins-and-mcp.sh
```

### 02-setup-bedrock-env.sh

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

### 03-setup-plugins-and-mcp.sh

Claude Code 플러그인과 AWS MCP 서버를 일괄 설치합니다.

| 구분 | 개수 | 주요 항목 |
|------|------|----------|
| 플러그인 (official) | 48개 | commit-commands, code-review, frontend-design, pyright-lsp, typescript-lsp, context7, playwright, github, slack 등 |
| 플러그인 (AWS) | 1개 | deploy-on-aws (awsiac, awsknowledge, awspricing) |
| MCP 서버 | 3개 | terraform, core, bedrock-agentcore |
