#!/usr/bin/env python3
"""Loopback-only Amazon DCV external token verifier; never logs credentials."""
import argparse
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import time
from urllib.parse import parse_qs
from xml.etree.ElementTree import Element, SubElement, tostring


def verify(token, key, session_id, user, now=None):
    now = int(time.time()) if now is None else now
    try:
        version, body, signature = token.split(".")
        if version != "v1" or len(token) > 8192:
            return False
        expected = base64.urlsafe_b64encode(hmac.new(key.encode(), f"v1.{body}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(expected, signature):
            return False
        claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        return (claims.get("aud") == "pai-dcv"
                and claims.get("sessionId") == session_id
                and claims.get("user") == user
                and type(claims.get("iat")) is int
                and type(claims.get("exp")) is int
                and claims["iat"] <= now + 30
                and now < claims["exp"] <= claims["iat"] + 300)
    except (ValueError, TypeError, KeyError, UnicodeError):
        return False


def handler(key_file, allowed_session, allowed_user):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            accepted = False
            try:
                length = int(self.headers.get("content-length", "0"))
                if not 0 < length <= 16384:
                    raise ValueError("length")
                form = parse_qs(self.rfile.read(length).decode(), strict_parsing=True)
                key = json.loads(Path(key_file).read_text())["key"]
                session = form.get("sessionId", [""])[0]
                accepted = session == allowed_session and verify(form.get("authenticationToken", [""])[0], key, session, allowed_user)
            except Exception:
                pass
            root = Element("auth", result="yes" if accepted else "no")
            SubElement(root, "username" if accepted else "message").text = allowed_user if accepted else "Authentication denied"
            payload = tostring(root)
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass
    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--user", required=True)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", 18544), handler(args.key_file, args.session, args.user)).serve_forever()
