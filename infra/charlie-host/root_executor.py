#!/usr/bin/env python3
"""Local root-only executor foundation; no network listener."""
import datetime
import hashlib
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile

DB = "/var/lib/charlie-host/audit.sqlite3"

def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise SystemExit("Root required")

    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        raise SystemExit("Request too large")

    request = json.loads(raw)
    effect = request.get("effect_id")
    command = request.get("command")

    if not isinstance(effect, str) or not re.fullmatch(
        r"[A-Za-z0-9._:-]{16,128}", effect
    ):
        raise SystemExit("Invalid effect ID")

    if not isinstance(command, str) or not 0 < len(command) <= 8192:
        raise SystemExit("Invalid command")

    os.makedirs("/var/lib/charlie-host", mode=0o700, exist_ok=True)
    db = sqlite3.connect(DB, timeout=10)
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""
        CREATE TABLE IF NOT EXISTS effects (
            id TEXT PRIMARY KEY,
            command_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            created_utc TEXT NOT NULL,
            exit_code INTEGER
        )
    """)

    try:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute(
            "SELECT status FROM effects WHERE id=?", (effect,)
        ).fetchone()

        if previous:
            db.rollback()
            print(json.dumps({
                "ok": False,
                "error": "effect_already_seen",
                "previous_status": previous[0]
            }))
            return

        now = datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat()

        db.execute(
            "INSERT INTO effects VALUES (?, ?, ?, ?, NULL)",
            (effect, hashlib.sha256(command.encode()).hexdigest(),
             "started", now)
        )
        db.commit()

        with tempfile.TemporaryFile() as out, \
             tempfile.TemporaryFile() as err:

            process = subprocess.Popen(
                ["/bin/bash", "-lc", command],
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                cwd="/",
                start_new_session=True,
                env={
                    "PATH": "/usr/local/sbin:/usr/local/bin:"
                            "/usr/sbin:/usr/bin:/sbin:/bin",
                    "HOME": "/root",
                    "LANG": "C"
                }
            )

            try:
                code = process.wait(timeout=60)
                status = "completed" if code == 0 else "failed"
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                code = None
                status = "timed_out"

            out.seek(0)
            err.seek(0)
            stdout = out.read(8192).decode(errors="replace")
            stderr = err.read(8192).decode(errors="replace")

        db.execute(
            "UPDATE effects SET status=?, exit_code=? WHERE id=?",
            (status, code, effect)
        )
        db.commit()

        print(json.dumps({
            "ok": status == "completed",
            "effect_id": effect,
            "status": status,
            "exit_code": code,
            "stdout": stdout,
            "stderr": stderr
        }))
    finally:
        db.close()

if __name__ == "__main__":
    main()
