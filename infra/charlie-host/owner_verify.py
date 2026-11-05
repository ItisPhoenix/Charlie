"""Verify a short-lived, command-bound Charlie owner authorization."""
import base64
import json
import re
import subprocess
import tempfile
import time
from pathlib import Path

PUBLIC = "/etc/charlie-host/owner-verifier.pem"
POLICY = "/etc/charlie-host/owner-policy.json"

FIELDS = {
    "version", "issuer", "owner_user_id", "space_id",
    "chief_bot_id", "gordon_bot_id", "gordon_run_id",
    "origin_run_id", "effect_id", "command_sha256",
    "issued_at", "expires_at",
}

def decode(value, max_length):
    if not isinstance(value, str) or len(value) > max_length:
        raise ValueError("invalid encoding")
    return base64.b64decode(value, validate=True)

def verify(envelope):
    if not isinstance(envelope, dict) or set(envelope) != {
        "grant_b64", "signature_b64"
    }:
        raise ValueError("invalid envelope")

    raw = decode(envelope["grant_b64"], 8192)
    signature = decode(envelope["signature_b64"], 128)
    if len(signature) != 64 or len(raw) > 4096:
        raise ValueError("invalid signature format")

    with tempfile.TemporaryDirectory(
        prefix=".verify-", dir="/var/lib/charlie-host"
    ) as folder:
        message = Path(folder) / "grant"
        sigfile = Path(folder) / "signature"
        message.write_bytes(raw)
        sigfile.write_bytes(signature)

        result = subprocess.run(
            [
                "/usr/bin/openssl", "pkeyutl",
                "-verify", "-rawin", "-pubin",
                "-inkey", PUBLIC,
                "-in", str(message),
                "-sigfile", str(sigfile),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            raise ValueError("invalid signature")

    grant = json.loads(raw)
    policy = json.loads(Path(POLICY).read_text())

    if not isinstance(grant, dict) or set(grant) != FIELDS:
        raise ValueError("invalid grant structure")

    if type(grant["version"]) is not int or grant["version"] != 1:
        raise ValueError("unsupported version")
    if grant["issuer"] != "charlie-api":
        raise ValueError("invalid issuer")

    for grant_field, policy_field in (
        ("owner_user_id", "owner_user_id"),
        ("space_id", "space_id"),
        ("chief_bot_id", "chief_bot_id"),
        ("gordon_bot_id", "gordon_bot_id"),
    ):
        if grant[grant_field] != policy[policy_field]:
            raise ValueError("owner policy mismatch")

    for name in ("origin_run_id", "gordon_run_id", "effect_id"):
        value = grant[name]
        if not isinstance(value, str) or not re.fullmatch(
            r"[A-Za-z0-9._:-]{16,128}", value
        ):
            raise ValueError("invalid execution identity")

    digest = grant["command_sha256"]
    if not isinstance(digest, str) or not re.fullmatch(
        r"[0-9a-f]{64}", digest
    ):
        raise ValueError("invalid command digest")

    issued = grant["issued_at"]
    expires = grant["expires_at"]
    now = int(time.time())
    if (
        type(issued) is not int
        or type(expires) is not int
        or issued > now + 15
        or expires <= now
        or expires <= issued
        or expires - issued > 60
    ):
        raise ValueError("expired or invalid grant")

    return grant
