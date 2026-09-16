#!/usr/bin/env python3
"""Configure token verification with explicit, idle-only initial activation."""
import argparse
import configparser
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import tempfile
from activation import activate_idle_console, require_idle_console

parser = argparse.ArgumentParser()
parser.add_argument("--secret", required=True)
parser.add_argument("--region", required=True)
parser.add_argument("--session", default="console")
parser.add_argument("--user", default="ubuntu")
parser.add_argument("--activate-if-idle", action="store_true")
args = parser.parse_args()
if not all(re.fullmatch(r"[a-zA-Z0-9_.-]+", value) for value in [args.session, args.user]):
    raise SystemExit("Invalid registered DCV identity")

config_file = Path("/etc/dcv/dcv.conf")
text = config_file.read_text()
config = configparser.ConfigParser(strict=False)
config.read_string(text)
verifier_url = "http://127.0.0.1:18544"
current = config.get("security", "auth-token-verifier", fallback="").strip("'\" ")
if current and current != verifier_url:
    raise SystemExit("An existing external authenticator is configured; refusing to replace it")
initial_activation = not current
if initial_activation:
    if not args.activate_if_idle:
        raise SystemExit("Initial external authentication requires --activate-if-idle during an idle console window")
    require_idle_console(json.loads(subprocess.check_output(["dcv", "list-sessions", "--json"])),
                         args.session, args.user)

key_directory = Path("/etc/physical-ai-dcv")
key_directory.mkdir(mode=0o700, exist_ok=True)
secret = subprocess.check_output(["aws", "secretsmanager", "get-secret-value", "--region", args.region, "--secret-id", args.secret, "--query", "SecretString", "--output", "text"])
if len(json.loads(secret).get("key", "")) < 32:
    raise SystemExit("Signing key is invalid")
key_path = key_directory / "key.json"
temporary_key = key_directory / "key.json.new"
fd = os.open(temporary_key, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "wb") as key_file:
    key_file.write(secret)
os.replace(temporary_key, key_path)

install = Path("/opt/physical-ai-dcv")
install.mkdir(exist_ok=True)
shutil.copyfile(Path(__file__).with_name("verifier.py"), install / "verifier.py")
unit = f"""[Unit]
Description=Physical AI DCV token verifier
After=network.target
[Service]
ExecStart=/usr/bin/python3 /opt/physical-ai-dcv/verifier.py --key-file /etc/physical-ai-dcv/key.json --session {args.session} --user {args.user}
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
StandardOutput=null
StandardError=journal
[Install]
WantedBy=multi-user.target
"""
Path("/etc/systemd/system/physical-ai-dcv-auth.service").write_text(unit)
subprocess.run(["systemctl", "daemon-reload"], check=True)
subprocess.run(["systemctl", "enable", "--now", "physical-ai-dcv-auth.service"], check=True)
subprocess.run(["systemctl", "is-active", "--quiet", "physical-ai-dcv-auth.service"], check=True)

backup = Path("/etc/dcv/dcv.conf.before-physical-ai")
if not backup.exists():
    shutil.copy2(config_file, backup)
line = f'auth-token-verifier="{verifier_url}"'
section = re.search(r"(?ms)^\[security\]\s*\n(.*?)(?=^\[|\Z)", text)
if section:
    body = section.group(1)
    body = re.sub(r"(?m)^auth-token-verifier\s*=.*$", line, body) if re.search(r"(?m)^auth-token-verifier\s*=", body) else line + "\n" + body
    updated = text[:section.start(1)] + body + text[section.end(1):]
else:
    updated = text.rstrip() + "\n[security]\n" + line + "\n"
with tempfile.NamedTemporaryFile(mode="w", dir=config_file.parent, delete=False) as tmp:
    tmp.write(updated)
    temporary = Path(tmp.name)
shutil.copymode(config_file, temporary)
os.replace(temporary, config_file)

# A running daemon that started with its internal verifier can keep decoding
# internal tokens after the file changes. Initial activation is explicit and
# guarded; updating an already configured endpoint does not restart the service.
if initial_activation:
    activate_idle_console(args.session, args.user)
print(json.dumps({
    "ready": True, "sessionId": args.session, "user": args.user,
    "initialActivation": initial_activation,
    "hostname": socket.gethostname(),
    "certificate": ssl.get_server_certificate(("127.0.0.1", 8443)),
}))
