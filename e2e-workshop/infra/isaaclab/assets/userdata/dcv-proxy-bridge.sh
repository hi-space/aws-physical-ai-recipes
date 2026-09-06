#!/bin/bash
# =============================================================================
# dcv-proxy-bridge.sh
#
# code-server 프록시(/proxy/<port>/)를 통해 "다른 호스트의 DCV"를 노트북
# 브라우저에서 열 수 있게 하는 loopback TLS 브리지를 설치한다.
#
# 왜 필요한가:
#   모듈 10에서 HyperPod debug 노드의 DCV(8443)를 SSM 포트포워딩으로 이 인스턴스의
#   127.0.0.1:8444 로 가져온다. 그런데 code-server 의 /proxy/<port>/ 는 평문 HTTP로
#   업스트림에 붙고, DCV 서버는 TLS 전용이라 /proxy/8444/ 는 "socket hang up" 으로 끊긴다.
#   이 브리지가 127.0.0.1:8445 에서 평문으로 받아 127.0.0.1:8444 로 TLS 로 중계하므로
#   /proxy/8445/ 가 정상 동작한다. (자체 서명 인증서이므로 검증은 끄고, 구간은 loopback 뿐이다.)
#
# 포워딩 세션이 없어도 리스너는 그대로 떠 있고 연결 시도만 실패하므로 항상 켜 두어도 안전하다.
# =============================================================================
echo "===== [$(date)] START: dcv-proxy-bridge.sh ====="

BRIDGE_BIN="/usr/local/bin/dcv-tls-bridge.py"
BRIDGE_UNIT="/etc/systemd/system/dcv-tls-bridge.service"

cat > "${BRIDGE_BIN}" <<'PYEOF'
#!/usr/bin/env python3
"""Loopback TLS bridge: plaintext HTTP in, TLS out.

code-server's /proxy/<port>/ speaks plaintext HTTP to the upstream, while a DCV
server only accepts TLS. Listening in plaintext on BRIDGE_LISTEN_PORT and
relaying to a TLS upstream makes the DCV web client reachable through the proxy.

Both ends are on loopback, and DCV uses a self-signed certificate, so
certificate verification is disabled on purpose.
"""
import os
import socket
import ssl
import sys
import threading

LISTEN_HOST = os.environ.get("BRIDGE_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("BRIDGE_LISTEN_PORT", "8445"))
TARGET_HOST = os.environ.get("BRIDGE_TARGET_HOST", "127.0.0.1")
TARGET_PORT = int(os.environ.get("BRIDGE_TARGET_PORT", "8444"))
BUFSIZE = 65536

TLS = ssl.create_default_context()
TLS.check_hostname = False
TLS.verify_mode = ssl.CERT_NONE


def log(message):
    print("[dcv-tls-bridge] %s" % message, flush=True)


def close_quietly(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def pump(src, dst):
    """Copy src -> dst until either side closes, then tear both down."""
    try:
        while True:
            data = src.recv(BUFSIZE)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        close_quietly(src)
        close_quietly(dst)


def handle(client):
    try:
        upstream = socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=10)
    except OSError as exc:
        # Expected whenever no SSM port-forwarding session is running.
        log("upstream %s:%d unreachable (%s)" % (TARGET_HOST, TARGET_PORT, exc))
        close_quietly(client)
        return
    try:
        upstream = TLS.wrap_socket(upstream, server_hostname="localhost")
    except (ssl.SSLError, OSError) as exc:
        log("TLS handshake with %s:%d failed (%s)" % (TARGET_HOST, TARGET_PORT, exc))
        close_quietly(upstream)
        close_quietly(client)
        return
    upstream.settimeout(None)
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    pump(upstream, client)


def main():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind((LISTEN_HOST, LISTEN_PORT))
    except OSError as exc:
        log("cannot bind %s:%d (%s)" % (LISTEN_HOST, LISTEN_PORT, exc))
        return 1
    listener.listen(64)
    log("listening on %s:%d -> https://%s:%d"
        % (LISTEN_HOST, LISTEN_PORT, TARGET_HOST, TARGET_PORT))
    while True:
        try:
            client, _ = listener.accept()
        except OSError as exc:
            log("accept failed (%s)" % exc)
            continue
        client.settimeout(None)
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
PYEOF
chmod +x "${BRIDGE_BIN}"

cat > "${BRIDGE_UNIT}" <<'UNITEOF'
[Unit]
Description=Loopback TLS bridge exposing a forwarded DCV port through the code-server proxy
# 모듈 10 방법 C: code-server 프록시(/proxy/8445/)로 HyperPod 노드의 DCV를 연다.
After=network.target

[Service]
Type=simple
User=ubuntu
Environment=BRIDGE_LISTEN_HOST=127.0.0.1
Environment=BRIDGE_LISTEN_PORT=8445
Environment=BRIDGE_TARGET_HOST=127.0.0.1
Environment=BRIDGE_TARGET_PORT=8444
ExecStart=/usr/bin/python3 /usr/local/bin/dcv-tls-bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable dcv-tls-bridge.service
systemctl restart dcv-tls-bridge.service || echo "[WARN] dcv-tls-bridge.service failed to start"

sleep 2
if systemctl is-active --quiet dcv-tls-bridge.service; then
  echo "[OK] dcv-tls-bridge active on 127.0.0.1:8445 -> 127.0.0.1:8444 (TLS)"
else
  echo "[WARN] dcv-tls-bridge not active; check 'journalctl -u dcv-tls-bridge'"
fi

echo "===== [$(date)] END: dcv-proxy-bridge.sh ====="
