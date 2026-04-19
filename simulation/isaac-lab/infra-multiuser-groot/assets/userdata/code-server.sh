#!/bin/bash
echo "===== [$(date)] START: code-server.sh ====="

# -----------------------------------------------------------------------------
# 1. Architecture detection
# -----------------------------------------------------------------------------
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  ARCH_LABEL="amd64";  NODE_ARCH="x64" ;;
    aarch64) ARCH_LABEL="arm64";  NODE_ARCH="arm64" ;;
    *)       echo "[WARN] Unsupported architecture: $ARCH, skipping code-server"; return 0 ;;
esac

CODE_SERVER_VERSION="4.110.0"

# -----------------------------------------------------------------------------
# 2. Node.js 20 (required for Claude Code CLI)
# -----------------------------------------------------------------------------
if command -v node &>/dev/null && [ "$(node -v | cut -d. -f1 | tr -d 'v')" -ge 20 ]; then
    echo "[INFO] Node.js already installed: $(node -v)"
else
    echo "[INFO] Installing Node.js 20..."
    NODE_VERSION=20.18.0
    wget -q "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -O /tmp/node.tar.xz
    tar -xf /tmp/node.tar.xz -C /usr/local --strip-components=1
    rm -f /tmp/node.tar.xz
    echo "[OK] Node.js installed: $(node -v)"
fi

# -----------------------------------------------------------------------------
# 3. code-server binary
# -----------------------------------------------------------------------------
if command -v code-server &>/dev/null; then
    echo "[INFO] code-server already installed: $(code-server --version 2>/dev/null | head -1)"
else
    echo "[INFO] Installing code-server v${CODE_SERVER_VERSION}..."
    cd /tmp
    CS_TAR="code-server-${CODE_SERVER_VERSION}-linux-${ARCH_LABEL}.tar.gz"
    CS_DIR="code-server-${CODE_SERVER_VERSION}-linux-${ARCH_LABEL}"
    wget -q "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${CS_TAR}" || { echo "[WARN] code-server download failed"; return 0; }
    tar -xzf "$CS_TAR"
    rm -rf /usr/local/lib/code-server
    mv "$CS_DIR" /usr/local/lib/code-server
    ln -sf /usr/local/lib/code-server/bin/code-server /usr/local/bin/code-server
    rm -f "$CS_TAR"
    echo "[OK] code-server installed"
fi

# -----------------------------------------------------------------------------
# 4. Retrieve password from Secrets Manager (same as DCV)
# -----------------------------------------------------------------------------
PASS=$(aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --output text --query SecretString --region ${REGION} | jq -r .password)

# -----------------------------------------------------------------------------
# 5. code-server configuration
# -----------------------------------------------------------------------------
mkdir -p /home/ubuntu/.config/code-server
cat > /home/ubuntu/.config/code-server/config.yaml <<EOF
bind-addr: 0.0.0.0:8888
auth: password
password: "${PASS}"
cert: false
EOF
chown -R ubuntu:ubuntu /home/ubuntu/.config/code-server

# -----------------------------------------------------------------------------
# 6. systemd service
# -----------------------------------------------------------------------------
cat > /etc/systemd/system/code-server.service <<EOF
[Unit]
Description=code-server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
Environment="PASSWORD=${PASS}"
ExecStart=/usr/local/bin/code-server --config /home/ubuntu/.config/code-server/config.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable code-server
systemctl start code-server || true

# -----------------------------------------------------------------------------
# 7. Claude Code CLI
# -----------------------------------------------------------------------------
if command -v claude &>/dev/null; then
    echo "[INFO] Claude Code already installed"
else
    echo "[INFO] Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code 2>/dev/null || echo "[WARN] Claude Code CLI install failed"
    NPM_PREFIX="$(npm prefix -g 2>/dev/null)"
    if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/bin/claude" ] && ! command -v claude &>/dev/null; then
        ln -sf "$NPM_PREFIX/bin/claude" /usr/local/bin/claude
    fi
fi

# -----------------------------------------------------------------------------
# 8. Claude Code VSCode extension
# -----------------------------------------------------------------------------
echo "[INFO] Installing Claude Code VSCode extension..."
sudo -u ubuntu code-server --install-extension Anthropic.claude-code 2>/dev/null || {
    VSIX_URL=$(curl -s "https://open-vsx.org/api/Anthropic/claude-code/latest" | python3 -c "import sys,json; print(json.load(sys.stdin).get('files',{}).get('download',''))" 2>/dev/null || echo "")
    if [ -n "$VSIX_URL" ]; then
        curl -sL "$VSIX_URL" -o /tmp/claude-code.vsix
        sudo -u ubuntu code-server --install-extension /tmp/claude-code.vsix 2>/dev/null || echo "[WARN] Claude Code extension install failed"
        rm -f /tmp/claude-code.vsix
    else
        echo "[WARN] Claude Code extension install failed"
    fi
}

echo "===== [$(date)] END: code-server.sh ====="
