#!/usr/bin/env python3
"""Say in one line whether the sandbox runner can run learner code here.

    python3 scripts/runner-status.py           # the runner listening on RUNNER_SOCKET
    python3 scripts/runner-status.py --local   # this machine, before any runner starts

It prints one of these lines and exits with the matching status:

    ok <mechanism>          0  the runner answers and confines learner code
    unsupported <reason>    3  it answers, but this kernel cannot confine learner
                               code, so it refuses every Run, Submit and Preview
    down <why>              1  nothing answers on the socket

The words after the first are the runner's own: `isolation_status()` in
apps/api/runner/sandbox_runner.py, which is also what the runner's GET /health
reports. start_socket_runner in scripts/lib/common.sh (which scripts/start.sh
uses), scripts/demo.sh, scripts/demo-selftest.sh and scripts/host.sh read this
instead of `serve.py --check`, which answers only yes or no and so cannot
tell "not running" from "running, and refusing learner code on this machine".
"""

import http.client
import json
import os
import socket
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SOCKET = "/run/learnsdlc/runner.sock"


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


def report(isolation):
    if isolation.get("status") == "ok":
        print(f"ok {isolation.get('mechanism', 'unknown')}")
        return 0
    print(f"unsupported {isolation.get('reason', 'kernel-isolation-unavailable')}")
    return 3


def local():
    sys.path.insert(0, os.path.join(ROOT, "apps", "api", "runner"))
    from sandbox_runner import isolation_status

    return report(isolation_status())


def remote(path):
    try:
        conn = _UnixConnection(path, timeout=3)
        conn.request("GET", "/health")
        response = conn.getresponse()
        body = json.loads(response.read())
    except FileNotFoundError:
        print(f"down no socket at {path}")
        return 1
    except (OSError, ValueError) as error:
        print(f"down {type(error).__name__} on {path}")
        return 1
    if response.status != 200 or not isinstance(body.get("isolation"), dict):
        print(f"down GET /health answered {response.status}")
        return 1
    return report(body["isolation"])


if __name__ == "__main__":
    if "--local" in sys.argv[1:]:
        sys.exit(local())
    sys.exit(remote(os.environ.get("RUNNER_SOCKET") or DEFAULT_SOCKET))
