# EC2 개발 환경 설정

EC2 인스턴스에 SSH 접속과 Claude Code + Codex + Bedrock 연동을 설정하는 가이드 및 스크립트입니다.

> 인프라 배포는 이 디렉토리에서 다루지 않습니다. GPU(Isaac Lab / GR00T) 인스턴스가 필요하면 [e2e-workshop/infra/isaaclab](../e2e-workshop/infra/isaaclab/) CDK 프로젝트를 사용하세요. code-server를 옵션으로 포함합니다.

## 구성

```
tools/
├── ssh-client-setup/                # [로컬 PC] EC2 SSH 접속 설정
│   ├── setup-ssh-client.sh          #   SSH 키 생성 + config 설정 자동화 (macOS/Linux)
│   ├── setup-ssh-client.ps1         #   SSH 키 생성 + config 설정 자동화 (Windows PowerShell)
│   └── README.md                    #   수동 설정 + 트러블슈팅 가이드
└── claude-code-setup/               # [EC2 인스턴스] Claude Code + Codex + Bedrock 연동
    ├── 00-install-claude-codex.sh   #   Claude Code + Codex CLI 설치 (+ VS Code 확장)
    ├── 01-setup-bedrock-env.sh      #   Bedrock 환경변수 + Codex config.toml + VS Code 설정
    ├── 02-setup-plugins-and-mcp.sh  #   플러그인 + MCP 서버 설치
    └── README.md                    #   스크립트 상세 가이드
```

## 1. SSH 접속 설정 — [ssh-client-setup/](ssh-client-setup/)

로컬 PC에서 SSH 키 생성과 `~/.ssh/config` 설정을 자동으로 수행합니다.

```bash
# macOS / Linux
bash ssh-client-setup/setup-ssh-client.sh <PUBLIC_IP>
```

```powershell
# Windows PowerShell
.\ssh-client-setup\setup-ssh-client.ps1 <PUBLIC_IP>
```

스크립트 실행 후 출력되는 공개키 등록 명령어를 EC2 Instance Connect 브라우저 터미널에서 실행하면 바로 접속할 수 있습니다.

```bash
ssh isaaclab
```

수동 설정 절차와 트러블슈팅은 [ssh-client-setup/README.md](ssh-client-setup/README.md)를 참고하세요.

## 2. Claude Code + Codex + Bedrock 설정 — [claude-code-setup/](claude-code-setup/)

EC2 인스턴스(SSM 또는 SSH 터미널)에서 순서대로 실행합니다.

```bash
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

Bedrock API 키 발급, 모델 선택, 설정되는 환경변수 등 상세 내용은 [claude-code-setup/README.md](claude-code-setup/README.md)를 참고하세요.
