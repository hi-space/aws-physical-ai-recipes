#!/usr/bin/env bash
set -euo pipefail

#
# IsaacLab EC2 SSH 클라이언트 설정 스크립트
# - SSH 키 생성 (없으면)
# - ~/.ssh/config 에 isaaclab 호스트 추가
# - 공개키 출력 (EC2 인스턴스에 등록용)
#

SSH_DIR="$HOME/.ssh"
KEY_FILE="$SSH_DIR/id_ed25519"
CONFIG_FILE="$SSH_DIR/config"
HOST_ALIAS="isaaclab"

# --- 1. PUBLIC_IP 입력 받기 ---
if [[ -n "${1:-}" ]]; then
    PUBLIC_IP="$1"
else
    read -rp "EC2 인스턴스 Public IP를 입력하세요: " PUBLIC_IP
fi

if [[ -z "$PUBLIC_IP" ]]; then
    echo "ERROR: Public IP가 필요합니다."
    exit 1
fi

# --- 2. ~/.ssh 디렉토리 확인 ---
if [[ ! -d "$SSH_DIR" ]]; then
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    echo "[OK] $SSH_DIR 디렉토리 생성"
fi

# --- 3. SSH 키 생성 (없는 경우만) ---
if [[ -f "$KEY_FILE" ]]; then
    echo "[SKIP] SSH 키가 이미 존재합니다: $KEY_FILE"
else
    ssh-keygen -t ed25519 -f "$KEY_FILE" -N ""
    echo "[OK] SSH 키 생성 완료: $KEY_FILE"
fi

# --- 4. ~/.ssh/config 에 호스트 추가 ---
if [[ -f "$CONFIG_FILE" ]] && grep -q "^Host ${HOST_ALIAS}$" "$CONFIG_FILE" 2>/dev/null; then
    # 기존 항목의 HostName을 업데이트
    sed -i.bak "/^Host ${HOST_ALIAS}$/,/^Host /{s/HostName .*/HostName ${PUBLIC_IP}/}" "$CONFIG_FILE"
    rm -f "${CONFIG_FILE}.bak"
    echo "[UPDATE] ~/.ssh/config 의 ${HOST_ALIAS} HostName을 ${PUBLIC_IP}로 업데이트"
else
    # 새 항목 추가
    {
        echo ""
        echo "Host ${HOST_ALIAS}"
        echo "    HostName ${PUBLIC_IP}"
        echo "    User ubuntu"
        echo "    IdentityFile ${KEY_FILE}"
    } >> "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "[OK] ~/.ssh/config 에 ${HOST_ALIAS} 호스트 추가 완료"
fi

# --- 5. 공개키 출력 ---
echo ""
echo "============================================"
echo "  설정 완료! 아래 공개키를 EC2에 등록하세요"
echo "============================================"
echo ""
cat "${KEY_FILE}.pub"
echo ""
echo "--------------------------------------------"
echo "EC2 Instance Connect 브라우저 터미널에서 실행:"
echo ""
echo "  echo \"$(cat "${KEY_FILE}.pub")\" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
echo ""
echo "등록 후 접속:"
echo "  ssh ${HOST_ALIAS}"
echo "--------------------------------------------"
