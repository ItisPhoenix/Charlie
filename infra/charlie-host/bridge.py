#!/usr/bin/env python3
"""Root-only Unix socket bridge; command execution disabled."""
import hashlib
import hmac
import json
import os
import re
import socketserver
import sqlite3
import time
from pathlib import Path

SOCKET = "/run/charlie-host/bridge.sock"
KEY = "/etc/charlie-host/bridge.key"
MAX_REQUEST = 16384

def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":")
    ).encode()

NONCE_DB = "/var/lib/charlie-host/bridge_nonces.sqlite3"

def claim_nonce(nonce, issued):
    with sqlite3.connect(NONCE_DB, timeout=5) as db:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("BEGIN IMMEDIATE")
        db.execute("""
            CREATE TABLE IF NOT EXISTS nonces (
                nonce TEXT PRIMARY KEY,
                issued_at INTEGER NOT NULL
            )
        """)
        db.execute(
            "DELETE FROM nonces WHERE issued_at < ?",
            (int(time.time()) - 120,)
        )
        try:
            db.execute(
                "INSERT INTO nonces VALUES (?, ?)",
                (nonce, issued)
            )
        except sqlite3.IntegrityError:
            return False
        return True

class Handler(socketserver.StreamRequestHandler):
    def send(self, result):
        self.wfile.write(canonical(result) + b"\n")

    def handle(self):
        self.request.settimeout(5)
        try:
            raw = self.rfile.readline(MAX_REQUEST + 2)
            if not raw.endswith(b"\n") or len(raw) > MAX_REQUEST:
                self.send({"ok": False, "error": "invalid_size"})
                return

            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError("Invalid request")

            signature = request.pop("mac", None)
            if not isinstance(signature, str) or not re.fullmatch(
                r"[0-9a-f]{64}", signature
            ):
                self.send({"ok": False, "error": "unauthorized"})
                return

            expected = hmac.new(
                Path(KEY).read_bytes(),
                canonical(request),
                hashlib.sha256
            ).hexdigest()

            if not hmac.compare_digest(expected, signature):
                self.send({"ok": False, "error": "unauthorized"})
                return

            issued = request.get("issued_at")
            nonce = request.get("nonce")
            if (type(issued) is not int
                or abs(int(time.time()) - issued) > 30
                or not isinstance(nonce, str)
                or not re.fullmatch(r"[0-9a-f]{32}", nonce)):
                self.send({"ok": False, "error": "expired_or_invalid"})
                return

            if not claim_nonce(nonce, issued):
                self.send({"ok": False, "error": "replay_detected"})
                return

            if request.get("action") != "ping":
                self.send({"ok": False, "error": "execution_disabled"})
                return

            self.send({
                "ok": True,
                "host_uid": os.geteuid(),
                "transport": "unix_socket",
                "authenticated": True,
                "execution_enabled": False
            })
        except Exception:
            self.send({"ok": False, "error": "invalid_request"})

def main():
    if os.geteuid() != 0:
        raise SystemExit("Root required")
    os.umask(0o077)
    path = Path(SOCKET)
    if path.is_symlink():
        raise SystemExit("Unexpected socket symlink")
    if path.exists():
        path.unlink()

    with socketserver.UnixStreamServer(SOCKET, Handler) as server:
        os.chmod(SOCKET, 0o600)
        server.serve_forever()

if __name__ == "__main__":
    main()
