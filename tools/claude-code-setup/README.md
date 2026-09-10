# Claude Code + Codex + Amazon Bedrock Setup

Scripts that connect Claude Code and the Codex CLI to Amazon Bedrock from the VSCode Server deployed on EC2.
Both Linux (EC2/Amazon Linux) and macOS environments are supported.

> 한국어 문서: [README.ko.md](README.ko.md)

## Prerequisites

| Item | Check | Install (Linux) |
|------|------|-------------|
| Node.js / npm | `node --version` | `sudo dnf install -y nodejs` (installed automatically by script 00) |
| Claude Code CLI | `claude --version` | installed automatically by script 00 |
| Codex CLI | `codex --version` | installed automatically by script 00 (requires 0.144.0 or later) |
| uv / uvx | `uvx --version` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| AWS CLI | `aws --version` | included in most EC2 AMIs by default (otherwise see the [install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)) |
| jq | `jq --version` | `sudo dnf install -y jq` (installed automatically by script 01) |

Issue a Bedrock API key from the [Amazon Bedrock console > API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).

## Execution Order

```
00-install-claude-codex.sh       Install Claude Code + Codex CLI (+ VS Code extensions)
        |
        v
01-setup-bedrock-env.sh          Bedrock env vars + Codex config.toml + VS Code settings
        |
        v
   source ~/.bashrc               Apply the environment variables
        |
        v
02-setup-plugins-and-mcp.sh      Install plugins + MCP servers
```

## Quick Start

```bash
# Run from SSM or the browser terminal
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

## Script Details

### 00-install-claude-codex.sh

Installs the Claude Code CLI and the Codex CLI together.

- Installs Node.js first if npm is missing
- `npm install -g @anthropic-ai/claude-code`, `npm install -g @openai/codex` (retries once on failure)
- Creates a symlink in `/usr/local/bin` if the npm global bin is outside PATH (handles fnm/nvm setups)
- Asks whether to update if already installed (for Codex, prefers `codex update`)
- If `code-server`/`code` is present, also installs the `Anthropic.claude-code` and `openai.chatgpt` extensions

### 01-setup-bedrock-env.sh

Applies the Bedrock integration settings in three places: the shell RC file, Codex `config.toml`, and VS Code `settings.json`.

**Inputs:**
- `AWS_BEARER_TOKEN_BEDROCK` (shared by Claude Code and Codex)
- AWS region (default: `us-east-1`)
- Claude Code model (Sonnet 5 1M / Opus 5 1M, default: Sonnet 5)
- Codex model (gpt-5.6-terra / gpt-5.5 / gpt-5.4)
- Max Output Tokens (4096 / 16384 / 32768)

**Environment variables that get set (~/.bashrc):**
```bash
AWS_BEARER_TOKEN_BEDROCK           # shared (Claude Code + Codex). Optional — leave empty to call with AWS credentials (SigV4)
AWS_REGION                         # shared, the region you entered
CLAUDE_CODE_USE_BEDROCK=1
ANTHROPIC_MODEL                    # the model you selected
ANTHROPIC_DEFAULT_OPUS_MODEL       # global.anthropic.claude-opus-4-6-v1
ANTHROPIC_DEFAULT_SONNET_MODEL     # global.anthropic.claude-sonnet-4-5-20250929-v1:0
ANTHROPIC_DEFAULT_HAIKU_MODEL      # global.anthropic.claude-haiku-4-5-20251001-v1:0
ANTHROPIC_SMALL_FAST_MODEL         # us.anthropic.claude-haiku-4-5-20251001-v1:0
CLAUDE_CODE_MAX_OUTPUT_TOKENS      # the value you selected
```

The block is wrapped in `# BEGIN ... # END` markers, so rerunning the script replaces only that block and preserves the rest of your RC file.

**Codex settings (~/.codex/config.toml):**
```toml
# BEGIN Amazon Bedrock settings
model_provider = "amazon-bedrock"
model = "openai.gpt-5.6-terra"
model_reasoning_effort = "medium"
model_providers.amazon-bedrock.aws.region = "us-east-1"
# END Amazon Bedrock settings
```

Since Codex 0.144 the `amazon-bedrock` provider is built in, so with `AWS_BEARER_TOKEN_BEDROCK` alone
calls go to Bedrock without a separate login. Existing MCP server and hooks settings in `config.toml` are left as they are;
only the Bedrock block is inserted/replaced at the top of the file (a backup file is created as well).

> **Codex model constraint**
> Codex only uses Bedrock's **Responses API** (the `bedrock-mantle` endpoint).
> Claude models on Bedrock do not support this API (`does not support the '/openai/v1/responses' API`),
> so only the `openai.gpt-5.x` family can be set for Codex. Use Claude models on the Claude Code side.
> You can list the available models with:
> ```bash
> curl -s "https://bedrock-mantle.$AWS_REGION.api.aws/v1/models" \
>   -H "Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK" | jq -r '.data[].id' | sort
> ```

**VS Code settings (settings.json):**
```
Linux (code-server):  ~/.local/share/code-server/User/settings.json
macOS (VS Code):      ~/Library/Application Support/Code/User/settings.json
```

`claudeCode.environmentVariables`, `claudeCode.selectedModel` and friends are set automatically from the values you entered.
An existing `settings.json` is merged into; otherwise a new one is created.

### 02-setup-plugins-and-mcp.sh

Installs the Claude Code plugins and AWS MCP servers in one go.

**What gets installed:**

| Category | Count | Notable items |
|------|------|----------|
| Plugins (official) | 48 | commit-commands, code-review, frontend-design, pyright-lsp, typescript-lsp, context7, playwright, github, slack, and more |
| Plugins (AWS) | 1 | deploy-on-aws (awsiac, awsknowledge, awspricing) |
| MCP servers | 3 | terraform, core, bedrock-agentcore |
