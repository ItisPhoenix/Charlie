#!/usr/bin/env python3
"""Deploy only Charlie Phase 1 isolated API and Worker; preserve and audit rollback."""
import copy
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

if len(sys.argv) != 4:
    raise SystemExit("usage: deploy-isolated.py IMAGE REVISION BACKUP_DIRECTORY")
IMAGE, SHA, BACKUP = sys.argv[1:]
os.umask(0o077)
NAMES = {"api": "charlie-p1-live-api", "worker": "charlie-p1-live-worker"}
NETWORKS = {"charlie-p1-acceptance-net", "charlie-p1-egress-net"}

class Docker(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect("/var/run/docker.sock")

def request(method, path, body=None):
    conn = Docker("localhost", timeout=180)
    try:
        payload = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, payload, {"Content-Type": "application/json"})
        response = conn.getresponse()
        data = response.read()
        if response.status // 100 != 2:
            raise RuntimeError("Docker HTTP %d: %s %s" % (response.status, method, path))
        return json.loads(data) if data else {}
    finally:
        conn.close()

BASE = "/v" + request("GET", "/version")["ApiVersion"]

def api(method, path, body=None):
    return request(method, BASE + path, body)

def info(ref):
    return api("GET", "/containers/" + quote(ref, safe="") + "/json")

def action(ref, operation, suffix=""):
    return api("POST", "/containers/" + quote(ref, safe="") + "/" + operation + suffix)

def running(ref):
    return info(ref)["State"]["Running"]

def stop(ref):
    if running(ref):
        action(ref, "stop", "?t=120")

def start(ref):
    if not running(ref):
        action(ref, "start")

def primary(container):
    mode = container["HostConfig"]["NetworkMode"]
    return next(name for name, value in container["NetworkSettings"]["Networks"].items()
                if mode in (name, value.get("NetworkID")))

def endpoint(container, name):
    return {"Aliases": container["NetworkSettings"]["Networks"][name].get("Aliases") or []}

def mounts(container):
    return sorted(
        (m["Type"], m["Destination"],
         m.get("Name") if m["Type"] == "volume" else m["Source"], m["RW"])
        for m in container["Mounts"]
    )

def candidate_config(container, image_id):
    cfg = copy.deepcopy(container["Config"])
    cfg["Image"] = image_id
    cfg["Env"] = [
        "GIT_SHA=" + SHA if value.startswith("GIT_SHA=")
        else "RAKAZO_GIT_SHA=" + SHA if value.startswith("RAKAZO_GIT_SHA=")
        else value
        for value in cfg.get("Env", [])
    ]
    host = copy.deepcopy(container["HostConfig"])
    host["NetworkMode"] = primary(container)
    host["Binds"] = None
    host["Mounts"] = []
    for m in container["Mounts"]:
        if m["Type"] not in ("volume", "bind"):
            raise RuntimeError("Unsupported mount type")
        host["Mounts"].append({
            "Type": m["Type"],
            "Source": m["Name"] if m["Type"] == "volume" else m["Source"],
            "Target": m["Destination"],
            "ReadOnly": not m["RW"]
        })
    return {**cfg, "HostConfig": host, "NetworkingConfig": {
        "EndpointsConfig": {primary(container): endpoint(container, primary(container))}
    }}

def interrupted(sig, frame):
    raise RuntimeError("Deployment interrupted")

for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(signum, interrupted)

print("=== PHASE1 ISOLATED PREFLIGHT ===", flush=True)
image = api("GET", "/images/" + quote(IMAGE, safe="") + "/json")
labels = image["Config"]["Labels"] or {}
assert labels.get("org.opencontainers.image.revision") == SHA
assert labels.get("charlie.local-overlay.sha256")
old = {key: info(name) for key, name in NAMES.items()}
old_ids = {item["Id"] for item in old.values()}
for key, container in old.items():
    assert container["State"]["Running"], key + " is not running"
    assert set(container["NetworkSettings"]["Networks"]) == NETWORKS
    assert container["HostConfig"]["RestartPolicy"]["Name"] == "no"
    assert not container["HostConfig"].get("VolumesFrom")
    assert not any(v.get("IPAMConfig") for v in container["NetworkSettings"]["Networks"].values())
assert "WEB_ORIGIN=http://100.115.253.116:5174" in old["api"]["Config"]["Env"]
assert running("charlie-p1-live-web")

inventory = api("GET", "/containers/json?all=1")
untouched = {}
for container in inventory:
    cid = container["Id"]
    if cid in old_ids:
        continue
    details = info(cid)
    untouched[cid] = (details["State"]["Running"], details["State"]["StartedAt"])

directory = Path(BACKUP)
directory.mkdir(parents=True, exist_ok=True)
suffix = str(os.getpid())
record = directory / ("github-source-rollout-" + suffix + ".json")
created = {}
rollback_names = {key: name + "-rollback-" + suffix for key, name in NAMES.items()}

def save_record(status):
    record.write_text(json.dumps({
        "status": status, "revision": SHA, "image": image["Id"],
        "overlay_sha256": labels["charlie.local-overlay.sha256"],
        "old": {key: {"id": old[key]["Id"], "image": old[key]["Image"],
                      "rollback_name": rollback_names[key]} for key in NAMES},
        "new": created
    }, indent=2))
    os.chmod(record, 0o600)

def rollback():
    errors = []
    for key in ("worker", "api"):
        if key in created:
            try:
                stop(created[key])
                api("DELETE", "/containers/" + created[key] + "?force=true")
            except Exception as exc:
                errors.append(str(exc))
    for key in ("api", "worker"):
        try:
            cid = old[key]["Id"]
            if info(cid)["Name"] != "/" + NAMES[key]:
                action(cid, "rename", "?name=" + quote(NAMES[key]))
            start(cid)
        except Exception as exc:
            errors.append(str(exc))
    return errors

save_record("prepared")
try:
    for key in ("api", "worker"):
        cid = api(
            "POST", "/containers/create?name=" +
            quote(NAMES[key] + "-candidate-" + suffix),
            candidate_config(old[key], image["Id"])
        )["Id"]
        created[key] = cid
        fresh = info(cid)
        assert fresh["Image"] == image["Id"]
        assert mounts(fresh) == mounts(old[key])
        assert fresh["HostConfig"]["PortBindings"] == old[key]["HostConfig"]["PortBindings"]
    save_record("candidates_created")

    stop(old["worker"]["Id"])
    stop(old["api"]["Id"])
    for key in ("api", "worker"):
        action(old[key]["Id"], "rename", "?name=" + quote(rollback_names[key]))
    for key in ("api", "worker"):
        action(created[key], "rename", "?name=" + quote(NAMES[key]))

    for key in ("api", "worker"):
        start(created[key])
        secondary = next(name for name in NETWORKS if name != primary(old[key]))
        api("POST", "/networks/" + quote(secondary) + "/connect", {
            "Container": created[key], "EndpointConfig": endpoint(old[key], secondary)
        })
        deadline = time.monotonic() + 160
        while time.monotonic() < deadline:
            state = info(created[key])["State"]
            assert state["Running"], key + " exited"
            health = (state.get("Health") or {}).get("Status")
            if health == "unhealthy":
                raise RuntimeError(key + " unhealthy")
            if health in ("healthy", None):
                if health is None:
                    time.sleep(5)
                    assert running(created[key])
                break
            time.sleep(3)
        else:
            raise RuntimeError(key + " readiness timeout")
        assert set(info(created[key])["NetworkSettings"]["Networks"]) == NETWORKS
        print(key.upper() + "_READY", flush=True)

    connected = False
    for _ in range(12):
        check = subprocess.run([
            "docker", "exec", "charlie-p1-live-web", "node", "-e",
            "fetch('http://charlie-p1-live-api:3100/health')"
            ".then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ], timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if check.returncode == 0:
            connected = True
            break
        time.sleep(2)
    assert connected, "Web-to-API health failed"

    for cid, before in untouched.items():
        current = info(cid)
        after = (current["State"]["Running"], current["State"]["StartedAt"])
        if before != after:
            raise RuntimeError("Unrelated container changed: " + current["Name"])

    save_record("deployed")
    print("GITHUB_SOURCE_FIX_DEPLOYED", flush=True)
    print("OTHER_CONTAINERS_UNCHANGED=" + str(len(untouched)), flush=True)
    print("ROLLBACK_RECORD=" + str(record), flush=True)
except BaseException as exc:
    print("DEPLOYMENT_FAILED: " + str(exc), file=sys.stderr, flush=True)
    errors = rollback()
    save_record("rollback_restored" if not errors else "rollback_incomplete")
    print("ROLLBACK_RESTORED" if not errors else
          "ROLLBACK_INCOMPLETE: " + "; ".join(errors), file=sys.stderr, flush=True)
    sys.exit(1)
