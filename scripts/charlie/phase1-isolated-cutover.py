#!/usr/bin/env python3
"""Fail-closed isolated Charlie API/Worker cutover with automatic rollback.

Requires the root-private Docker inspect snapshot saved before this rollout.
Clones credentials and runtime configuration without printing secrets.
Does not touch any containers other than charlie-p1-live-api/worker and
their newly created replacement/rollback counterparts.
"""
import copy
import http.client
import json
import os
import re
import signal
import socket
import sys
import time
from urllib.parse import quote

os.umask(0o077)
SNAPSHOT = "/home/phoenix/charlie-workflow-backups/phase1-chief.gqfH3z/predeploy-containers.json"
CANDIDATE = "rakazo/app:charlie-p1-chief-e63507ad7-20261104"
REVISION = "e63507ad7ba07a49d488476a57a97e52d2a96a60"
PRIMARY = "charlie-p1-acceptance-net"
SECONDARY = "charlie-p1-egress-net"
ORDER = ("api", "worker")
NAMES = {kind: "charlie-p1-live-" + kind for kind in ORDER}


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect("/var/run/docker.sock")


def request(method, path, body=None):
    conn = UnixHTTP("localhost", timeout=190)
    payload = json.dumps(body).encode() if body is not None else None
    try:
        conn.request(method, path, payload,
                     {"Content-Type": "application/json"} if payload else {})
        response = conn.getresponse()
        data = response.read()
        if not 200 <= response.status < 300:
            raise RuntimeError("%s %s: HTTP %s %s" %
                               (method, path, response.status, data.decode(errors="replace")[:300]))
        return json.loads(data) if data else {}
    finally:
        conn.close()


BASE = "/v" + request("GET", "/version")["ApiVersion"]


def call(method, path, body=None):
    return request(method, BASE + path, body)


def inspect(ref):
    return call("GET", "/containers/" + quote(ref, safe="") + "/json")


def invoke(method, ref, action, args=""):
    return call(method, "/containers/" + quote(ref, safe="") + "/" + action + args)


with open(SNAPSHOT, encoding="utf-8") as source:
    previous = {item["Name"].lstrip("/"): item for item in json.load(source)}
assert set(previous) == set(NAMES.values()), "Unexpected isolated-container snapshot"

image = call("GET", "/images/" + quote(CANDIDATE, safe="") + "/json")
assert image["Config"]["Labels"]["org.opencontainers.image.revision"] == REVISION, "Candidate revision mismatch"
image_id = image["Id"]

# Every check below executes before either original service is stopped.
for name in NAMES.values():
    actual = inspect(name)
    saved = previous[name]
    assert actual["Id"] == saved["Id"] and actual["Image"] == saved["Image"], "Runtime changed: " + name
    assert actual["State"]["Running"], "Original is not running: " + name
    assert set(actual["NetworkSettings"]["Networks"]) == {PRIMARY, SECONDARY}, "Network mismatch: " + name
    assert actual["HostConfig"]["RestartPolicy"]["Name"] == "no", "Unexpected restart policy: " + name
    assert not actual["HostConfig"].get("VolumesFrom"), "Inherited volume configuration unsupported"
    for settings in actual["NetworkSettings"]["Networks"].values():
        assert not settings.get("IPAMConfig"), "Static network allocation requires manual review"

suffix = str(os.getpid())
created = {}
archive = {kind: NAMES[kind] + "-rollback-" + suffix for kind in ORDER}


def endpoint(original, network):
    settings = original["NetworkSettings"]["Networks"][network]
    aliases = []
    for value in (settings.get("Aliases") or []) + [original["Name"].lstrip("/")]:
        if value and not re.fullmatch("[0-9a-f]{12,64}", value) and value not in aliases:
            aliases.append(value)
    return {"Aliases": aliases}


def clone_payload(original):
    config = copy.deepcopy(original["Config"])
    config["Image"] = image_id
    config["Env"] = [
        (key + "=" + REVISION) if key in ("GIT_SHA", "RAKAZO_GIT_SHA") else value
        for value in config.get("Env", [])
        for key in [value.split("=", 1)[0]]
    ]
    config["Labels"] = {
        **(config.get("Labels") or {}),
        "charlie.isolated.revision": REVISION,
    }
    host = copy.deepcopy(original["HostConfig"])
    host["NetworkMode"] = PRIMARY
    host["Binds"] = None
    host["Mounts"] = []
    for mount in original["Mounts"]:
        if mount["Type"] == "tmpfs":
            assert host.get("Tmpfs"), "Missing original tmpfs configuration"
            continue
        assert mount["Type"] in ("volume", "bind"), "Unsupported mount type"
        source = mount["Name"] if mount["Type"] == "volume" else mount["Source"]
        assert source, "Mount source unavailable"
        host["Mounts"].append({
            "Type": mount["Type"],
            "Source": source,
            "Target": mount["Destination"],
            "ReadOnly": not mount["RW"],
        })
    return {
        **config,
        "HostConfig": host,
        "NetworkingConfig": {
            "EndpointsConfig": {PRIMARY: endpoint(original, PRIMARY)}
        },
    }


def running(ref):
    return bool(inspect(ref)["State"]["Running"])


def start(ref):
    if not running(ref):
        invoke("POST", ref, "start")


def stop(ref, timeout=120):
    if running(ref):
        invoke("POST", ref, "stop", "?t=" + str(timeout))


def ready(ref, label):
    deadline = time.monotonic() + 160
    while time.monotonic() < deadline:
        current = inspect(ref)
        state = current["State"]
        if not state["Running"]:
            raise RuntimeError(label + " exited: " + str(state.get("ExitCode")))
        health = (state.get("Health") or {}).get("Status")
        if health in (None, "healthy"):
            assert current["Image"] == image_id, label + " running wrong image"
            assert set(current["NetworkSettings"]["Networks"]) == {PRIMARY, SECONDARY}, label + " network mismatch"
            # A container without a healthcheck must at least stay up.
            if health is None:
                time.sleep(5)
                assert running(ref), label + " terminated after startup"
            return
        if health == "unhealthy":
            raise RuntimeError(label + " reported unhealthy")
        time.sleep(3)
    raise RuntimeError(label + " health deadline exceeded")


def restore():
    errors = []
    for kind in reversed(ORDER):
        ref = created.get(kind)
        if ref:
            try:
                stop(ref, 20)
                call("DELETE", "/containers/" + quote(ref, safe="") + "?force=true")
            except Exception as exc:
                errors.append("remove " + kind + ": " + str(exc))
    for kind in ORDER:
        ref = previous[NAMES[kind]]["Id"]
        try:
            if inspect(ref)["Name"] != "/" + NAMES[kind]:
                invoke("POST", ref, "rename", "?name=" + quote(NAMES[kind]))
            start(ref)
        except Exception as exc:
            errors.append("restore " + kind + ": " + str(exc))
    return errors


def interrupt(signum, _frame):
    raise RuntimeError("Interrupted: signal " + str(signum))


for signum in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(signum, interrupt)

try:
    print("=== PRECREATE REPLACEMENTS ===", flush=True)
    for kind in ORDER:
        result = call(
            "POST",
            "/containers/create?name=" + quote(NAMES[kind] + "-candidate-" + suffix),
            clone_payload(previous[NAMES[kind]]),
        )
        created[kind] = result["Id"]

    print("=== CUT OVER ISOLATED API AND WORKER ONLY ===", flush=True)
    stop(previous[NAMES["worker"]]["Id"])
    stop(previous[NAMES["api"]]["Id"])
    for kind in ORDER:
        invoke("POST", previous[NAMES[kind]]["Id"], "rename", "?name=" + quote(archive[kind]))
    for kind in ORDER:
        invoke("POST", created[kind], "rename", "?name=" + quote(NAMES[kind]))

    for kind in ORDER:
        ref = created[kind]
        start(ref)
        call(
            "POST",
            "/networks/" + quote(SECONDARY) + "/connect",
            {"Container": ref, "EndpointConfig": endpoint(previous[NAMES[kind]], SECONDARY)},
        )
        ready(ref, kind)
        print(kind.upper() + "_HEALTHY", flush=True)

    record = {
        "revision": REVISION,
        "candidate_image": image_id,
        "new": created,
        "rollback": {
            kind: {
                "id": previous[NAMES[kind]]["Id"],
                "name": archive[kind],
                "image": previous[NAMES[kind]]["Image"],
            } for kind in ORDER
        },
    }
    output = os.path.join(os.path.dirname(SNAPSHOT), "phase1-rollout-record.json")
    with open(output, "w", encoding="utf-8") as destination:
        json.dump(record, destination, indent=2)
    print("ISOLATED_CUTOVER_PASSED revision=" + REVISION, flush=True)
    print("ROLLBACK_RECORD=" + output, flush=True)
except BaseException as error:
    print("CUTOVER_FAILED: " + str(error), file=sys.stderr, flush=True)
    errors = restore()
    if errors:
        print("ROLLBACK_INCOMPLETE: " + " | ".join(errors), file=sys.stderr, flush=True)
    else:
        print("ROLLBACK_RESTORED", file=sys.stderr, flush=True)
    sys.exit(1)
