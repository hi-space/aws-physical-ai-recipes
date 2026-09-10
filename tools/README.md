# EC2 Development Environment Setup

Guides and scripts for setting up SSH access to an EC2 instance and wiring Claude Code + Codex to Amazon Bedrock.

> 한국어 문서: [README.ko.md](README.ko.md)

> Infrastructure deployment is out of scope for this directory. If you need a GPU (Isaac Lab / GR00T) instance, use the [e2e-workshop/infra/isaaclab](../e2e-workshop/infra/isaaclab/) CDK project, which includes code-server as an option.

## Layout

```
tools/
├── ssh-client-setup/                # [Local PC] SSH access setup for EC2
│   ├── setup-ssh-client.sh          #   SSH key generation + config setup (macOS/Linux)
│   ├── setup-ssh-client.ps1         #   SSH key generation + config setup (Windows PowerShell)
│   └── README.md                    #   Manual setup + troubleshooting guide
└── claude-code-setup/               # [EC2 instance] Claude Code + Codex + Bedrock integration
    ├── 00-install-claude-codex.sh   #   Install Claude Code + Codex CLI (+ VS Code extensions)
    ├── 01-setup-bedrock-env.sh      #   Bedrock env vars + Codex config.toml + VS Code settings
    ├── 02-setup-plugins-and-mcp.sh  #   Install plugins + MCP servers
    └── README.md                    #   Detailed script guide
```

## 1. SSH Access Setup — [ssh-client-setup/](ssh-client-setup/)

Generates an SSH key on your local PC and configures `~/.ssh/config` automatically.

```bash
# macOS / Linux
bash ssh-client-setup/setup-ssh-client.sh <PUBLIC_IP>
```

```powershell
# Windows PowerShell
.\ssh-client-setup\setup-ssh-client.ps1 <PUBLIC_IP>
```

Run the public-key registration command the script prints in the EC2 Instance Connect browser terminal, and you can connect right away.

```bash
ssh isaaclab
```

For the manual setup procedure and troubleshooting, see [ssh-client-setup/README.md](ssh-client-setup/README.md).

## 2. Claude Code + Codex + Bedrock Setup — [claude-code-setup/](claude-code-setup/)

Run these in order on the EC2 instance (SSM or SSH terminal).

```bash
cd claude-code-setup

# 0. Install the CLIs (claude + codex)
bash 00-install-claude-codex.sh

# 1. Bedrock env vars + Codex/VS Code settings
bash 01-setup-bedrock-env.sh
source ~/.bashrc

# 2. Install plugins + MCP servers
bash 02-setup-plugins-and-mcp.sh

# Verify
claude -p 'say OK'
codex exec 'say OK'
```

For Bedrock API key issuance, model selection, and the full list of environment variables that get set, see [claude-code-setup/README.md](claude-code-setup/README.md).
