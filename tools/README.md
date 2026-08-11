# EC2 개발 환경 설정

EC2 인스턴스에 SSH 접속과 Claude Code + Bedrock 연동을 설정하는 가이드 및 스크립트입니다.

> 이 디렉토리의 `deploy.sh`는 code-server(VSCode)가 설치된 CPU 개발용 EC2를 CloudFormation으로 직접 배포합니다.
> GPU(Isaac Lab / GR00T) 환경이 필요하면 [e2e-workshop/infra/isaaclab](../e2e-workshop/infra/isaaclab/) CDK 프로젝트를 사용하세요. code-server를 옵션으로 포함합니다.

## 구성

```
tools/
├── 01-setup-ssh-client.sh       # SSH 키 생성 + config 설정 자동화 (macOS/Linux)
├── 01-setup-ssh-client.ps1      # SSH 키 생성 + config 설정 자동화 (Windows PowerShell)
├── 02-setup-bedrock-env.sh      # Node.js/Claude/Kiro 설치 + Bedrock 환경변수 + VS Code 설정
├── 03-setup-plugins-and-mcp.sh  # 플러그인 + MCP 서버 설치
├── cloudformation.yaml          # CloudFront + EC2 인프라
└── deploy.sh                    # 대화형 배포 스크립트
```

---

## 0. EC2 배포

`deploy.sh`는 CloudFront + EC2(code-server) 스택을 대화형으로 배포합니다.

```bash
bash deploy.sh
```

입력 항목: Stack Name, VSCode 비밀번호(8자 이상), 인스턴스 타입(m7i / t3 / m7g / t4g, 기본 `m7i.2xlarge`), EBS 크기(기본 100GB), VPC.
Public Subnet은 CloudFormation이 Lambda로 자동 탐색합니다.

배포가 끝나면 VSCode URL과 SSM 접속 명령이 출력됩니다. UserData 설치 완료까지 5~10분 걸립니다.

```bash
bash deploy.sh --delete <stack-name>
```

---

## 1. SSH 접속 설정

로컬 PC에서 SSH 키 생성과 `~/.ssh/config` 설정을 자동으로 수행합니다.

```bash
# macOS / Linux
bash 01-setup-ssh-client.sh <PUBLIC_IP>
```

```powershell
# Windows PowerShell
.\01-setup-ssh-client.ps1 <PUBLIC_IP>
```

스크립트 실행 후 출력되는 공개키 등록 명령어를 EC2 Instance Connect 브라우저 터미널에서 실행하면 바로 접속할 수 있습니다.

```bash
ssh isaaclab
```

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
- 모델 선택 (아래 5종)
- Max Output Tokens (4096 / 16384 / 32768)

**선택 가능한 모델:**

| 번호 | 모델 | Bedrock Global inference ID | Context |
|------|------|------------------------------|---------|
| 1 (기본) | Opus 5 | `global.anthropic.claude-opus-5` | 1M |
| 2 | Sonnet 5 | `global.anthropic.claude-sonnet-5` | 1M |
| 3 | Opus 4.8 | `global.anthropic.claude-opus-4-8` | 1M |
| 4 | Opus 4.6 | `global.anthropic.claude-opus-4-6-v1` | 1M |
| 5 | Sonnet 4.6 | `global.anthropic.claude-sonnet-4-6` | 1M |

**설정되는 환경변수 (~/.bashrc):**
```bash
ANTHROPIC_API_KEY
AWS_BEARER_TOKEN_BEDROCK
CLAUDE_CODE_USE_BEDROCK=1
ANTHROPIC_MODEL                    # 선택한 모델
ANTHROPIC_DEFAULT_OPUS_MODEL       # global.anthropic.claude-opus-5
ANTHROPIC_DEFAULT_SONNET_MODEL     # global.anthropic.claude-sonnet-5
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
