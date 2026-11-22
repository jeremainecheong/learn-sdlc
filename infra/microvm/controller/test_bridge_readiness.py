"""The readiness poll's /health timeout is the whole remaining boot budget, so a VM queued behind other VMs' token
mints still gets its mint.

The VM's proxy-token mint runs inside GuestHttp.request under cloud.py's one process-wide guest lock and shares the
request's timeout (lock wait + mint + HTTP). A short fixed poll (5 s) would let a VM queued behind other VMs' mints get
the lock with little of its time left, and its mint would be killed (cloud_timeout). These cases pin the timeout, the
mint's own bound behind a held lock, the short-budget case, and the accepted trade-off (a /health that never answers
holds its poll to the boot deadline). The controller suite's style: unittest, the same fakes.

    python3.11 -B -m unittest test_bridge_readiness   (from this folder; pytest collects it too)
"""
from dataclasses import dataclass
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bridge as _bridge
from bridge import Bridge
from cloud import GuestHttp, PROTOCOL, Unavailable, encode
from registry import Registry
from test_bridge import IMAGE, EGRESS, INGRESS

JOB = {"mode": "tests", "files": {"test.py": "print('hello')"}, "timeoutSeconds": 1}


@dataclass(frozen=True)
class Config(_bridge.Config):
    """Unpaced, like test_bridge.Config, so these cases prove only the readiness poll."""
    launch_rate: float = 50.0
    launch_burst: int = 50


class Cloud:
    def __init__(self):
        self.vms, self.mint_timeouts = {}, []

    def launch(self, parameters):
        vm = "mvm-" + parameters["clientToken"]
        self.vms[vm] = {"microvmId": vm, "state": "RUNNING", "imageArn": parameters["imageIdentifier"],
                        "imageVersion": parameters["imageVersion"],
                        "endpoint": "guest.lambda-microvm.ap-southeast-1.on.aws",
                        "egressNetworkConnectors": parameters["egressNetworkConnectors"],
                        "ingressNetworkConnectors": parameters["ingressNetworkConnectors"]}
        return dict(self.vms[vm])

    def get(self, vm_id): return dict(self.vms[vm_id])

    def terminate(self, vm_id):
        self.vms[vm_id]["state"] = "TERMINATED"
        return {}

    def token(self, vm_id, timeout=10):
        self.mint_timeouts.append(timeout)
        return "secret-jwe"


class Guest:
    """/health answers from a script: an exception instance is raised (after moving the test clock), else ok."""
    def __init__(self, clock, script=()):
        self.clock, self.script, self.timeouts = clock, list(script), []

    def request(self, row, route, body=None, timeout=30):
        assert route == "/health"
        self.timeouts.append(timeout)
        step = self.script.pop(0) if self.script else None
        if step is not None:
            spent, error = step
            self.clock[0] += timeout if spent == "all" else spent
            raise error
        return {"ok": True, "purpose": row["purpose"]}

    def forget(self, vm_id): pass


class ReadinessPollTimeoutTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.registry = Registry(Path(temp.name) / "private" / "registry.sqlite")
        self.addCleanup(self.registry.close)
        self.cloud, self.clock = Cloud(), [100.0]

    def bridge(self, guest, boot=60):
        config = Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, boot_seconds=boot, job_limit=8, cleanup_limit=1)
        bridge = Bridge(config, self.registry, self.cloud, guest)
        row = bridge._launch(bridge._admit("job", encode(JOB)))
        self.addCleanup(bridge._released, row["id"])
        return bridge, row

    def ready(self, bridge, row, deadline):
        def sleep(seconds): self.clock[0] += seconds
        with patch("bridge.time.monotonic", side_effect=lambda: self.clock[0]), \
             patch("bridge.time.sleep", side_effect=sleep):
            return bridge._ready(row, deadline)

    def test_each_poll_is_given_the_whole_remaining_boot_budget_not_five_seconds(self):
        # Two polls fail after 7 s each (a mint queued behind other VMs' mints), then the guest answers.
        guest = Guest(self.clock, [(7, Unavailable("guest busy", code="cloud_timeout")),
                                   (7, Unavailable("guest busy", code="guest_transport"))])
        bridge, row = self.bridge(guest)
        self.assertEqual(self.ready(bridge, row, 160.0)["id"], row["id"])
        # 60 s at the start; 60 - 7 - 0.5 = 52.5; 52.5 - 7 - 0.5 = 45 (a fixed 5 s poll would read 5 each time)
        self.assertEqual(guest.timeouts, [60.0, 52.5, 45.0])

    def test_a_short_remaining_budget_is_still_the_poll_timeout(self):
        for left in (3.0, 2.5, .25):
            with self.subTest(left=left):
                self.clock[0] = 100.0
                guest = Guest(self.clock)
                bridge, row = self.bridge(guest)
                self.ready(bridge, row, self.clock[0] + left)
                self.assertEqual(guest.timeouts, [left])

    def test_a_health_that_never_answers_holds_its_poll_to_the_boot_deadline(self):
        # The accepted trade-off: one poll, which spends the whole budget, then runtime_not_ready, the same answer
        # a run gets whenever its guest never answers.
        guest = Guest(self.clock, [("all", Unavailable("no answer", code="guest_transport"))])
        bridge, row = self.bridge(guest)
        with self.assertRaises(Unavailable) as raised:
            self.ready(bridge, row, 160.0)
        self.assertEqual(raised.exception.code, "runtime_not_ready")
        self.assertEqual(guest.timeouts, [60.0])
        self.assertEqual(self.registry.get(row["id"])["last_error_code"], "guest_transport")


class MintBehindTheGuestLockTests(unittest.TestCase):
    """The real GuestHttp: a mint that waited for the process-wide lock still gets its own full bound (10 s) while the
    boot budget allows it; a fixed 5 s poll would leave it what was left of 5 s (4.7 s here, and under a long queue
    nearly 0)."""

    def test_a_mint_queued_behind_the_guest_lock_keeps_its_own_bound(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        registry = Registry(Path(temp.name) / "private" / "registry.sqlite")
        self.addCleanup(registry.close)
        cloud = Cloud()
        guest = GuestHttp(cloud, "ap-southeast-1")
        config = Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, boot_seconds=60, job_limit=2, cleanup_limit=1)
        bridge = Bridge(config, registry, cloud, guest)
        row = bridge._launch(bridge._admit("job", encode(JOB)))
        self.addCleanup(bridge._released, row["id"])
        answer = {"protocol": PROTOCOL, "instanceId": row["id"], "microvmId": row["vm_id"],
                  "sourceHash": row["source_hash"], "ok": True, "purpose": row["purpose"]}

        class Response:
            status = 200
            def read(self, limit): return json.dumps(answer).encode()

        held, release = threading.Event(), threading.Event()
        def other_vms_mint():  # another request holds the guest lock for 0.3 s, as a queued mint does
            with guest.lock:
                held.set()
                release.wait(2)
        holder = threading.Thread(target=other_vms_mint)
        holder.start()
        self.assertTrue(held.wait(2))
        threading.Timer(.3, release.set).start()
        with patch("cloud.http.client.HTTPSConnection") as connection:
            connection.return_value.getresponse.return_value = Response()
            self.assertEqual(bridge._ready(row, time.monotonic() + 60)["id"], row["id"])
        holder.join(2)
        self.assertEqual(cloud.mint_timeouts, [10], "the mint's bound is min(10, what is left), never 5 - the wait")


if __name__ == "__main__": unittest.main()
