import base64
import collections
import concurrent.futures
from dataclasses import replace
import hashlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from bridge import Bridge, Config, Refusal, finite_result, initial_bytes
from cloud import AwsCli, CloudError, GuestHttp, PROTOCOL, Unavailable, encode, endpoint_host
from registry import Registry, Full
from serve import Server

import bridge as _bridge
from dataclasses import dataclass


@dataclass(frozen=True)
class Config(_bridge.Config):
    """bridge.Config built unpaced (the pacer's top bounds, 50 a second and a burst of 50, unless a case names a
    rate), so the cases that are not about pacing prove only what they pin; every other field and check is
    bridge.Config's own. test_launch_pacer.py pins the pacing at the code defaults."""
    launch_rate: float = 50.0
    launch_burst: int = 50

IMAGE = "arn:aws:lambda:ap-southeast-1:123456789012:microvm-image:test"
EGRESS = "arn:aws:lambda:ap-southeast-1:123456789012:network-connector:private"
INGRESS = "arn:aws:lambda:ap-southeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS"
JOB = {"mode": "tests", "files": {"test.py": "print('hello')"}, "timeoutSeconds": 1}
PREVIEW = {"mode": "preview", "files": {"api/main.py": "print('hello')"}, "service": {"command": ["python3", "api/main.py"]}}
RESULT = {"ok": True, "exitKind": "ok", "durationMs": 12, "stdout": "", "stderr": "",
          "tests": {"total": 1, "passed": 1, "failed": 0, "errored": 0, "cases": [{"name": "one", "status": "passed"}]}}
# The code defaults (Config.job_limit, Config.cleanup_limit) as the default pins expect them. Only the default pins
# read this; every other case builds its limits explicitly, most at a job limit of 2 and a cleanup limit of 1, so
# they keep proving that configuration whatever the code defaults are.
CODE_DEFAULT_LIMITS = (24, 24)


class Cloud:
    def __init__(self):
        self.calls, self.vms, self.creates = [], {}, {}
        self.ambiguous = False
        self.bad_endpoint = None

    def launch(self, parameters):
        self.calls.append(("launch", parameters))
        token = parameters["clientToken"]
        if token not in self.creates:
            self.creates[token] = "mvm-" + token
            self.vms[self.creates[token]] = {"microvmId": self.creates[token], "state": "RUNNING",
                "imageArn": parameters["imageIdentifier"], "imageVersion": parameters["imageVersion"],
                "endpoint": "guest.lambda-microvm.ap-southeast-1.on.aws",
                "egressNetworkConnectors": parameters["egressNetworkConnectors"],
                "ingressNetworkConnectors": parameters["ingressNetworkConnectors"]}
        if self.ambiguous:
            self.ambiguous = False
            raise Unavailable("launch timed out after acceptance")
        answer = dict(self.vms[self.creates[token]])
        if self.bad_endpoint: answer["endpoint"] = self.bad_endpoint
        return answer

    def get(self, vm_id):
        self.calls.append(("get", vm_id))
        return dict(self.vms[vm_id])

    def terminate(self, vm_id):
        self.calls.append(("terminate", vm_id))
        self.vms[vm_id]["state"] = "TERMINATED"
        return {}

    def token(self, vm_id, timeout=10): return "secret-jwe"


class Guest:
    def __init__(self):
        self.calls = []
        self.result = RESULT
        self.fail = False
        self.started = threading.Event()
        self.wait = None

    def request(self, row, route, body=None, timeout=30):
        self.calls.append((route, row["id"], body))
        if route == "/health": return {"ok": True, "purpose": row["purpose"]}
        if self.fail: raise Unavailable("guest failed")
        if route in ("/execute", "/app/start"):
            if hashlib.sha256(body).hexdigest() != row["source_hash"]: raise AssertionError("bytes drifted")
            self.started.set()
            if self.wait: self.wait.wait(3)
        if route == "/execute": return self.result
        if route in ("/app/start", "/app/status"):
            return {"id": "private-guest-id", "status": "ready", "console": [], "cursor": 0, "bundleOk": True}
        return {"status": 200, "body": base64.b64encode(b"ok").decode(),
                "contentType": "text/html", "headers": {"content-type": "application/json", "set-cookie": "secret"}}

    def forget(self, vm_id): pass


class TestBridge(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "private" / "registry.sqlite"
        self.registry = Registry(self.path)
        self.cloud, self.guest = Cloud(), Guest()
        self.config = Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, boot_seconds=1, job_limit=2, cleanup_limit=1)
        self.bridge = Bridge(self.config, self.registry, self.cloud, self.guest)

    def tearDown(self):
        if self.guest.wait: self.guest.wait.set()
        for _ in range(100):
            if not self.bridge.active and not self.bridge.cleanup_slots.busy(): break
            time.sleep(.01)
        self.registry.close()
        self.temp.cleanup()

    def ready_preview(self):
        first = self.bridge.start(PREVIEW)
        for _ in range(100):
            row = self.registry.get(first["id"])
            if row["state"] == "running": return first
            time.sleep(.005)
        self.fail("preview failed to start")

    def test_fresh_job_each_request_exact_payload_and_no_credentials(self):
        self.assertEqual(self.bridge.execute(JOB), RESULT)
        self.bridge.sweep()
        self.assertEqual(self.bridge.execute(JOB), RESULT)
        self.assertEqual(len(self.cloud.creates), 2)
        for _, parameters in (call for call in self.cloud.calls if call[0] == "launch"):
            self.assertNotIn("executionRoleArn", parameters)
            self.assertGreater(parameters["idlePolicy"]["maxIdleDurationSeconds"], parameters["maximumDurationInSeconds"])
            self.assertFalse(parameters["idlePolicy"]["autoResumeEnabled"])
            self.assertEqual(parameters["egressNetworkConnectors"], [EGRESS])
            hook = json.loads(parameters["runHookPayload"])
            self.assertEqual(hook["sourceHash"], hashlib.sha256(encode(JOB)).hexdigest())
            self.assertLess(len(parameters["runHookPayload"]), 4096)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def wait_cleanup(self):
        for _ in range(100):
            self.bridge.sweep()
            if not self.registry.active(): return
            time.sleep(.005)
        self.fail("cleanup did not complete")

    def test_unknown_launch_reconciles_same_token_without_running_job(self):
        self.cloud.ambiguous = True
        with self.assertRaises(Unavailable): self.bridge.execute(JOB)
        self.wait_cleanup()
        launches = [payload for name, payload in self.cloud.calls if name == "launch"]
        self.assertEqual(len(launches), 2)
        self.assertEqual(launches[0], launches[1])
        self.assertEqual(len(self.cloud.creates), 1)
        self.assertFalse(any(call[0] == "/execute" for call in self.guest.calls))
        self.assertEqual(next(iter(self.cloud.vms.values()))["state"], "TERMINATED")

    def test_malformed_result_cannot_be_success_and_cleanup_persists(self):
        self.guest.result = {**RESULT, "tests": {**RESULT["tests"], "failed": 1}}
        with self.assertRaises(Unavailable): self.bridge.execute(JOB)
        row = self.registry.get(next(iter(self.cloud.creates)))
        self.assertEqual(row["cleanup"], 1)
        self.assertIsNone(row["result_ok"])
        self.wait_cleanup()
        self.assertEqual(self.registry.active(), [])

    def test_guest_failure_terminates_and_does_not_retry_execution(self):
        self.guest.fail = True
        with self.assertRaises(Unavailable): self.bridge.execute(JOB)
        self.wait_cleanup()
        self.assertEqual(sum(call[0] == "/execute" for call in self.guest.calls), 1)
        self.assertEqual(next(iter(self.cloud.vms.values()))["state"], "TERMINATED")

    def test_preview_initial_response_is_prompt_then_proxy_uses_private_id(self):
        self.guest.wait = threading.Event()
        first = self.bridge.start(PREVIEW)
        self.assertEqual(first["status"], "starting")
        self.assertNotIn("bundleOk", first)
        self.assertTrue(self.guest.started.wait(1))
        self.assertEqual(self.bridge.app("status", {"id": first["id"]})["status"], "starting")
        self.guest.wait.set()
        for _ in range(100):
            if self.registry.get(first["id"])["state"] == "running": break
            time.sleep(.005)
        result = self.bridge.app("proxy", {"id": first["id"], "path": "/api/lists?x=1", "method": "POST",
            "body": base64.b64encode(b'{"name":"x"}').decode(),
            "headers": {"Authorization": "portal-secret", "Cookie": "session", "X-aws-proxy-port": "22", "Content-Type": "application/json"}})
        sent = json.loads(self.guest.calls[-1][2])
        self.assertEqual(sent["id"], "private-guest-id")
        self.assertEqual(sent["headers"], {"content-type": "application/json"})
        self.assertEqual(result["headers"], {"content-type": "application/json"})
        self.assertNotIn("private-guest-id", json.dumps(result))

    def test_stop_during_start_never_publishes_late_ready(self):
        self.guest.wait = threading.Event()
        first = self.bridge.start(PREVIEW)
        self.assertTrue(self.guest.started.wait(1))
        self.bridge.app("stop", {"id": first["id"]})
        self.guest.wait.set()
        for _ in range(100):
            if not self.bridge.active: break
            time.sleep(.005)
        self.assertNotEqual(self.bridge.app("status", {"id": first["id"]})["status"], "ready")
        self.assertEqual(next(iter(self.cloud.vms.values()))["state"], "TERMINATED")

    def test_restart_reconciles_finite_but_preserves_live_preview(self):
        preview = self.ready_preview()
        raw = initial_bytes(JOB, "job")
        job = self.bridge._admit("job", raw)
        self.bridge._launch(job)
        self.bridge._released(job["id"])
        self.registry.close()
        self.registry = Registry(self.path)
        self.bridge = Bridge(self.config, self.registry, self.cloud, self.guest)
        self.bridge.sweep(startup=True)
        self.assertEqual(self.bridge.app("status", {"id": preview["id"]})["status"], "ready")
        self.assertTrue(self.registry.get(job["id"])["cleanup"])
        self.assertFalse(any(call[0] == "/execute" for call in self.guest.calls))

    def test_admission_atomic_and_cross_kind_limits_independent(self):
        def create(_):
            try: return self.bridge._admit("job", encode(JOB))["id"]
            except Refusal: return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(create, range(8)))
        self.assertEqual(sum(bool(x) for x in ids), 2)
        self.assertIsNotNone(self.bridge._admit("preview", encode(PREVIEW)))
        for operation in list(self.bridge.active): self.bridge._released(operation)

    def cleaning_jobs(self):
        rows = []
        for _ in range(self.config.job_limit):
            row = self.bridge._launch(self.bridge._admit("job", encode(JOB)))
            self.registry.update(row["id"], cleanup=1, state="cleanup")
            self.bridge._released(row["id"])
            rows.append(row)
        return rows

    def test_serial_job_waits_for_confirmed_cleanup_without_exceeding_two_vms(self):
        entered, release, waiting = threading.Event(), threading.Event(), threading.Event()
        terminate, launch = self.cloud.terminate, self.cloud.launch
        wait = self.bridge.capacity_changed.wait
        maximum = [0]
        def slow_terminate(vm_id):
            entered.set()
            if not release.wait(2): raise AssertionError("test did not release teardown")
            return terminate(vm_id)
        def measured_launch(parameters):
            result = launch(parameters)
            maximum[0] = max(maximum[0], sum(vm["state"] != "TERMINATED" for vm in self.cloud.vms.values()))
            return result
        def observed_wait(timeout=None):
            waiting.set()
            return wait(timeout)
        with patch.object(self.cloud, "terminate", side_effect=slow_terminate), \
             patch.object(self.cloud, "launch", side_effect=measured_launch), \
             patch.object(self.bridge.capacity_changed, "wait", side_effect=observed_wait), \
             concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            try:
                self.assertEqual(self.bridge.execute(JOB), RESULT)
                self.assertTrue(entered.wait(1))
                self.assertEqual(self.bridge.execute(JOB), RESULT)
                third = pool.submit(self.bridge.execute, JOB)
                self.assertTrue(waiting.wait(1))
                self.assertEqual(len(self.cloud.creates), 2)
                self.assertFalse(third.done())
                self.assertEqual(self.bridge.health()["waiting"], 1)
                release.set()
                self.assertEqual(third.result(timeout=2), RESULT)
            finally:
                release.set()
        self.wait_cleanup()
        self.assertEqual(maximum[0], 2)
        self.assertEqual(self.bridge.health()["waiting"], 0)
        self.assertEqual(len(self.cloud.creates), 3)
        self.assertEqual(sum(call[0] == "/execute" for call in self.guest.calls), 3)

    def test_active_only_capacity_is_busy_without_wait_or_cloud_launch(self):
        for _ in range(2): self.bridge._admit("job", encode(JOB))
        with patch.object(self.bridge.capacity_changed, "wait", side_effect=AssertionError("must not wait for active work")):
            with self.assertRaises(Refusal) as refused: self.bridge.execute(JOB)
        self.assertEqual((refused.exception.status, refused.exception.message), (503, "runner capacity is full"))
        self.assertEqual(self.cloud.calls, [])
        self.assertEqual(self.registry.stats()["job"], 2)
        for operation in list(self.bridge.active): self.bridge._released(operation)

    def test_cleanup_wait_obeys_existing_boot_deadline(self):
        self.cleaning_jobs()
        for boot, expected_wait in [(60, 60), (1, 1)]:
            with self.subTest(boot=boot):
                self.bridge.config = replace(self.config, boot_seconds=boot)
                clock, waits = [100.0], []
                def elapsed_wait(timeout=None):
                    waits.append(timeout)
                    clock[0] += timeout
                before = len(self.cloud.calls)
                with patch("bridge.time.monotonic", side_effect=lambda: clock[0]), \
                     patch.object(self.bridge.capacity_changed, "wait", side_effect=elapsed_wait):
                    with self.assertRaises(Refusal) as refused: self.bridge.execute(JOB)
                self.assertEqual(refused.exception.message, "runner capacity is full")
                self.assertEqual(waits, [expected_wait])
                self.assertEqual(len(self.cloud.calls), before)
                self.assertEqual(len(self.registry.active()), 2)
                self.assertEqual(self.guest.calls, [])
                self.assertEqual(self.bridge.health()["waiting"], 0)

    def test_cleanup_longer_than_ten_seconds_consumes_the_original_boot_and_finite_budgets(self):
        rows = self.cleaning_jobs()
        self.bridge.config = replace(self.config, boot_seconds=60)
        clock, waits, request_timeouts, maximum = [100.0], [], {}, [2]
        launch, request = self.cloud.launch, self.guest.request

        def cleanup_during_wait(timeout=None):
            waits.append(timeout)
            clock[0] += 55
            # Only confirmed teardown frees a slot; the other VM stays counted.
            self.bridge.cleanup_one(rows[0]["id"])

        def launch_after_cleanup(parameters):
            clock[0] += 2
            answer = launch(parameters)
            maximum[0] = max(maximum[0], sum(vm["state"] != "TERMINATED" for vm in self.cloud.vms.values()))
            return answer

        def measured_request(row, route, body=None, timeout=30):
            request_timeouts[route] = timeout
            return request(row, route, body, timeout)

        with patch("bridge.time.monotonic", side_effect=lambda: clock[0]), \
             patch.object(self.bridge.capacity_changed, "wait", side_effect=cleanup_during_wait), \
             patch.object(self.cloud, "launch", side_effect=launch_after_cleanup), \
             patch.object(self.guest, "request", side_effect=measured_request):
            self.assertEqual(self.bridge.execute(JOB), RESULT)

        self.assertEqual(waits, [60])
        self.assertEqual(request_timeouts["/health"], 3, "55s cleanup + 2s launch leave only 3s of the original boot budget")
        self.assertEqual(request_timeouts["/execute"], 14, "the finite deadline remains start + 60s boot + 1s execution + 10s headroom")
        self.assertEqual(maximum[0], 2)
        self.assertEqual(len(self.cloud.creates), 3, "only one fresh VM is launched after confirmed cleanup")
        self.assertEqual(sum(call[0] == "/execute" for call in self.guest.calls), 1)
        self.assertEqual(self.bridge.health()["waiting"], 0)
        self.wait_cleanup()

    def test_cleanup_confirmed_at_the_boot_deadline_does_not_launch_or_execute(self):
        rows = self.cleaning_jobs()
        self.bridge.config = replace(self.config, boot_seconds=60)
        clock = [100.0]

        def cleanup_at_deadline(timeout=None):
            self.assertEqual(timeout, 60)
            clock[0] += timeout
            self.bridge.cleanup_one(rows[0]["id"])

        with patch("bridge.time.monotonic", side_effect=lambda: clock[0]), \
             patch.object(self.bridge.capacity_changed, "wait", side_effect=cleanup_at_deadline):
            with self.assertRaises(Refusal) as refused:
                self.bridge.execute(JOB)
        self.assertEqual(refused.exception.message, "runner capacity is full")
        self.assertEqual(len(self.cloud.creates), 2)
        self.assertEqual(self.guest.calls, [])
        self.assertEqual(self.registry.stats()["job"], 1)
        self.assertEqual(self.bridge.health()["waiting"], 0)

    def test_competing_cleanup_waiters_reserve_only_the_two_released_slots(self):
        rows = self.cleaning_jobs()
        waiting, count = threading.Event(), [0]
        wait = self.bridge.capacity_changed.wait
        def observed_wait(timeout=None):
            count[0] += 1
            if count[0] == 3: waiting.set()
            return wait(timeout)
        def admit():
            try: return self.bridge._admit("job", encode(JOB), deadline=time.monotonic() + 2)["id"]
            except Refusal: return None
        with patch.object(self.bridge.capacity_changed, "wait", side_effect=observed_wait), \
             concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            pending = [pool.submit(admit) for _ in range(3)]
            self.assertTrue(waiting.wait(1))
            for row in rows: self.bridge.cleanup_one(row["id"])
            ids = [future.result(timeout=3) for future in pending]
        self.assertEqual(sum(value is not None for value in ids), 2)
        self.assertEqual(len(set(value for value in ids if value)), 2)
        self.assertEqual(self.registry.stats()["job"], 2)
        self.assertEqual(len(self.cloud.creates), 2, "Waiting/admission itself must never launch a VM")
        for operation in list(self.bridge.active): self.bridge._released(operation)

    def test_shutdown_wakes_cleanup_waiter_without_launching_its_job(self):
        self.cleaning_jobs()
        waiting = threading.Event()
        wait = self.bridge.capacity_changed.wait
        def observed_wait(timeout=None):
            waiting.set()
            return wait(timeout)
        with patch.object(self.bridge.capacity_changed, "wait", side_effect=observed_wait), \
             concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.bridge.execute, JOB)
            self.assertTrue(waiting.wait(1))
            self.bridge.shutdown()
            with self.assertRaises(Refusal) as refused: pending.result(timeout=2)
        self.assertEqual(refused.exception.message, "runner stopping")
        self.assertEqual(len(self.cloud.creates), 2)
        self.assertEqual(self.guest.calls, [])

    def test_invalid_manifest_and_hidden_preview_refused_before_launch(self):
        for job in [{**JOB, "files": {"../secret": "x"}}, {**JOB, "files": {"/secret": "x"}},
                    {**PREVIEW, "gradedFiles": {"hidden.py": "x"}}]:
            with self.assertRaises(Refusal):
                (self.bridge.start if job["mode"] == "preview" else self.bridge.execute)(job)
        self.assertEqual(self.cloud.calls, [])

    def test_endpoint_escape_never_contacts_guest_but_cleans_vm(self):
        self.cloud.bad_endpoint = "https://127.0.0.1"
        with self.assertRaises(Unavailable): self.bridge.execute(JOB)
        self.wait_cleanup()
        self.assertEqual(self.guest.calls, [])
        self.assertEqual(next(iter(self.cloud.vms.values()))["state"], "TERMINATED")

    def test_duplicate_controller_process_refused(self):
        with self.assertRaises(BlockingIOError): Registry(self.path)

    def test_failed_termination_is_retained_and_retried_after_restart(self):
        row = self.bridge._admit("job", encode(JOB))
        row = self.bridge._launch(row)
        self.bridge._released(row["id"])
        self.registry.update(row["id"], cleanup=1)
        with patch.object(self.cloud, "terminate", side_effect=Unavailable("offline")):
            self.bridge.cleanup_one(row["id"])
        self.assertEqual(self.registry.get(row["id"])["vm_id"], row["vm_id"])
        self.assertNotEqual(self.registry.get(row["id"])["state"], "terminated")
        self.bridge.sweep(startup=True)
        self.assertEqual(self.registry.get(row["id"])["state"], "terminated")

    def test_double_ambiguous_launch_is_bounded_and_never_runs_source(self):
        with patch.object(self.cloud, "launch", side_effect=Unavailable("timeout")) as launches:
            with self.assertRaises(Unavailable): self.bridge.execute(JOB)
            for _ in range(100):
                if launches.call_count >= 2: break
                time.sleep(.005)
            self.bridge.sweep()
            self.assertEqual(launches.call_count, 2)
        self.assertFalse(any(call[0] == "/execute" for call in self.guest.calls))
        self.assertEqual(self.registry.active()[0]["launch_attempts"], 2)

    def test_real_memory_limit_outcome_is_preserved(self):
        answer = {"ok": False, "exitKind": "memory", "durationMs": 12, "stdout": "", "stderr": "memory limit", "tests": None}
        self.assertEqual(finite_result(answer, "tests"), answer)

    def test_empty_successful_test_evidence_is_refused(self):
        result = {**RESULT, "tests": {"total": 0, "passed": 0, "failed": 0, "errored": 0, "cases": []}}
        with self.assertRaises(Unavailable): finite_result(result, "tests")

    def test_invalid_timeout_does_not_allocate_cloud_capacity(self):
        for value in (float("inf"), True, 0, 61, "15"):
            with self.assertRaises(Refusal): self.bridge.execute({**JOB, "timeoutSeconds": value})
        self.assertEqual(self.cloud.calls, [])


class TestTransport(unittest.TestCase):
    def test_cli_uses_only_host_role_and_private_request_file_not_argv_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            cli = AwsCli("/usr/local/bin/aws", "ap-southeast-1", folder)
            paths = []
            def process(command, **options):
                self.assertNotIn("control-secret", " ".join(command))
                source = Path(command[command.index("--cli-input-json")+1].removeprefix("file://"))
                paths.append(source)
                self.assertEqual(source.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(source.read_text())["runHookPayload"], "control-secret")
                for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "AWS_ROLE_ARN", "AWS_ENDPOINT_URL"):
                    self.assertNotIn(key, options["env"])
                self.assertEqual(options["env"]["AWS_CONFIG_FILE"], "/dev/null")
                options["stdout"].write(b'{"microvmId":"mvm-test"}')
                from unittest.mock import Mock
                return Mock(returncode=0)
            with patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "operator-secret", "AWS_PROFILE": "operator"}), patch("cloud.subprocess.Popen", side_effect=process):
                self.assertEqual(cli.launch({"runHookPayload": "control-secret"}), {"microvmId": "mvm-test"})
            self.assertFalse(paths[0].exists())

    def test_endpoint_validation(self):
        self.assertEqual(endpoint_host("abc.lambda-microvm.ap-southeast-1.on.aws", "ap-southeast-1"), "abc.lambda-microvm.ap-southeast-1.on.aws")
        for url in ("http://abc.lambda-microvm.ap-southeast-1.on.aws", "https://evil.test", "https://x.lambda-microvm.ap-southeast-1.on.aws.evil.test",
                    "https://x.lambda-microvm.ap-southeast-1.on.aws:22", "https://user@x.lambda-microvm.ap-southeast-1.on.aws", "https://x.lambda-microvm.ap-southeast-1.on.aws/a"):
            with self.assertRaises(Unavailable): endpoint_host(url, "ap-southeast-1")

    def test_configuration_rejects_guest_role_network_fallbacks(self):
        with self.assertRaises(ValueError): Config("ap-southeast-1", IMAGE, "1", INGRESS, "INTERNET_EGRESS")
        with self.assertRaises(ValueError): Config("ap-southeast-1", IMAGE, "1", INGRESS.replace("ALL", "SHELL"), EGRESS)
        with self.assertRaises(ValueError): Config("ap-southeast-1", IMAGE, "", INGRESS, EGRESS)

    def test_aws_token_map_and_port_are_exact(self):
        cli = AwsCli("/does/not/run", "ap-southeast-1", "/tmp")
        with patch.object(cli, "call", return_value={"authToken": {"X-aws-proxy-auth": "token"}}) as call:
            self.assertEqual(cli.token("mvm-one"), "token")
            self.assertEqual(call.call_args.args[1]["allowedPorts"], [{"port": 8081}])

    def test_guest_identity_validation_and_tokens_never_in_output(self):
        row = {"id": "operation", "vm_id": "mvm-one", "endpoint": "abc.lambda-microvm.ap-southeast-1.on.aws",
               "control_token": "control-secret", "source_hash": "hash"}
        envelope = {"protocol": PROTOCOL, "instanceId": "wrong-operation", "microvmId": "mvm-one", "sourceHash": "hash", "result": RESULT}
        class Response:
            status = 200
            def read(self, limit): return encode(envelope)
        with patch("cloud.http.client.HTTPSConnection") as connection:
            connection.return_value.getresponse.return_value = Response()
            guest = GuestHttp(Cloud(), "ap-southeast-1")
            with self.assertRaises(Unavailable): guest.request(row, "/execute", encode(JOB))
            envelope["instanceId"] = "operation"
            self.assertEqual(guest.request(row, "/execute", encode(JOB)), RESULT)
            sent = connection.return_value.request.call_args.kwargs["headers"]
            self.assertEqual(sent["X-aws-proxy-port"], "8081")
            self.assertEqual(sent["Authorization"], "Bearer control-secret")


class StartupDiagnosticsTests(unittest.TestCase):
    def test_startup_failure_has_safe_type_location_and_no_values(self):
        import contextlib
        import io
        import serve
        output = io.StringIO()
        with patch("serve.main", side_effect=PermissionError("private-key-canary /secret/account/path")):
            with contextlib.redirect_stderr(output):
                self.assertEqual(serve.run(), 1)
        text = output.getvalue()
        self.assertRegex(text, r"PermissionError at serve\.py:[0-9]+")
        self.assertNotIn("private-key-canary", text)
        self.assertNotIn("/secret", text)

    def test_untrusted_exception_type_and_filename_are_not_reflected(self):
        import serve
        error_type = type("SecretCredentialCanary", (Exception,), {})
        try:
            exec(compile("raise error_type('value-canary')", "/secret-token-canary/arbitrary.py", "exec"))
        except Exception as error:
            text = serve.startup_diagnostic(error)
        self.assertEqual(text, "MicroVM bridge startup failed; Exception at unknown:0")


class JobLimitBoundTests(unittest.TestCase):
    """The finite-job limit is a configured value (code default 24), bounded at JOB_LIMIT_BOUND (32)."""

    def make(self, code_defaults=False, **limits):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        registry = Registry(Path(temp.name) / "private" / "registry.sqlite")
        self.addCleanup(registry.close)
        cloud, guest = Cloud(), Guest()
        # Explicit limits over (2, 1) unless the case pins the code defaults themselves.
        if not code_defaults: limits = {"job_limit": 2, "cleanup_limit": 1, **limits}
        # The code defaults are read from bridge.Config itself, never from the unpaced shim above.
        config = (_bridge.Config if code_defaults else Config)("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS,
                                                              boot_seconds=1, **limits)
        return Bridge(config, registry, cloud, guest), registry, cloud

    def release_all(self, bridge):
        for operation in list(bridge.active): bridge._released(operation)

    def test_default_job_limit_is_the_code_default_and_the_bound_is_thirty_two(self):
        import bridge as module
        self.assertEqual(module.JOB_LIMIT_BOUND, 32)
        config = module.Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS)
        self.assertEqual((config.job_limit, config.preview_limit), (CODE_DEFAULT_LIMITS[0], 10))
        bridge, _, _ = self.make(code_defaults=True)
        self.assertEqual(bridge.health()["slots"], CODE_DEFAULT_LIMITS[0])

    def test_job_limit_up_to_thirty_two_is_accepted_and_thirty_three_or_zero_refused_by_name(self):
        for limit in range(1, 33):
            with self.subTest(limit=limit):
                self.assertEqual(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, job_limit=limit, cleanup_limit=1).job_limit, limit)
        for limit in (0, 33, -1, 64, 2.0, True, "4"):
            with self.subTest(limit=limit):
                with self.assertRaises(ValueError) as refused:
                    Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, job_limit=limit)
                self.assertEqual(str(refused.exception), "job_limit must be a whole number from 1 to 32 (the bounded preview policy)")

    def test_health_reports_the_configured_job_limit(self):
        for limit in (4, 6, 8, 10, 12):
            with self.subTest(limit=limit):
                bridge, _, _ = self.make(job_limit=limit)
                self.assertEqual((bridge.health()["slots"], bridge.health()["previewSlots"]), (limit, 10))

    def test_admission_is_atomic_at_the_raised_limit(self):
        bridge, registry, _ = self.make(job_limit=8)
        def create(_):
            try: return bridge._admit("job", encode(JOB))["id"]
            except Refusal: return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            ids = list(pool.map(create, range(16)))
        self.assertEqual(sum(bool(x) for x in ids), 8)
        self.assertEqual(registry.stats()["job"], 8)
        self.release_all(bridge)

    def test_at_job_limit_k_the_next_execute_waits_on_a_cleaning_slot_and_is_refused_with_none_cleaning(self):
        for limit in (4, 8, 12):
            with self.subTest(limit=limit):
                bridge, registry, cloud = self.make(job_limit=limit)
                for _ in range(limit): bridge._admit("job", encode(JOB))
                with patch.object(bridge.capacity_changed, "wait", side_effect=AssertionError("must not wait for active work")):
                    with self.assertRaises(Refusal) as refused: bridge.execute(JOB)
                self.assertEqual((refused.exception.status, refused.exception.message), (503, "runner capacity is full"))
                self.assertEqual(cloud.calls, [])
                rows = [registry.update(operation, cleanup=1, state="cleanup") for operation in list(bridge.active)]
                self.release_all(bridge)
                waiting = threading.Event()
                wait = bridge.capacity_changed.wait
                def observed_wait(timeout=None):
                    waiting.set()
                    return wait(timeout)
                with patch.object(bridge.capacity_changed, "wait", side_effect=observed_wait), \
                     concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(bridge._admit, "job", encode(JOB), time.monotonic() + 2)
                    self.assertTrue(waiting.wait(1))
                    self.assertFalse(pending.done())
                    self.assertEqual(bridge.health()["waiting"], 1)
                    registry.update(rows[0]["id"], state="terminated", cleanup_outcome="not-launched")
                    with bridge.capacity_changed: bridge.capacity_changed.notify_all()
                    admitted = pending.result(timeout=2)
                self.assertEqual(registry.stats()["job"], limit)
                self.assertNotIn(admitted["id"], [row["id"] for row in rows])
                self.release_all(bridge)

    def test_cleanup_pending_rows_still_count_against_the_raised_limit(self):
        bridge, registry, _ = self.make(job_limit=8)
        for _ in range(8):
            row = bridge._admit("job", encode(JOB))
            registry.update(row["id"], cleanup=1, state="cleanup")
            bridge._released(row["id"])
        self.assertEqual(bridge.active, set())
        with self.assertRaises(Full):
            registry.create("job", "0" * 64, bridge.config.job_limit, lambda operation, secret: {"maximumDurationInSeconds": 180})
        self.assertEqual((bridge.health()["inFlight"], bridge.health()["slots"]), (8, 8))
        clock = [100.0]
        def elapsed_wait(timeout=None): clock[0] += timeout
        with patch("bridge.time.monotonic", side_effect=lambda: clock[0]), \
             patch.object(bridge.capacity_changed, "wait", side_effect=elapsed_wait):
            with self.assertRaises(Refusal) as refused: bridge.execute(JOB)
        self.assertEqual(refused.exception.message, "runner capacity is full")
        self.assertEqual(registry.stats()["job"], 8)

    def test_preview_limit_is_bounded_at_twelve(self):
        self.assertEqual(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, preview_limit=12, job_limit=8, cleanup_limit=1).preview_limit, 12)
        for limit in (0, 13, 32):
            with self.subTest(limit=limit):
                with self.assertRaises(ValueError) as refused:
                    Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, preview_limit=limit)
                self.assertEqual(str(refused.exception), "deployment limits exceed the bounded preview policy")

    def test_the_environment_file_keys_are_unchanged_and_never_set_the_job_limit(self):
        import bridge as module
        five = {"AWS_REGION": "ap-southeast-1", "MICROVM_IMAGE_ARN": IMAGE, "MICROVM_IMAGE_VERSION": "1",
                "MICROVM_INGRESS_ARN": INGRESS, "MICROVM_EGRESS_ARN": EGRESS}
        read = set()
        class Recording(dict):
            def __getitem__(self, key): read.add(key); return dict.__getitem__(self, key)
            def get(self, key, default=None): read.add(key); return dict.get(self, key, default)
        # Inputs unequal to every code default (24 slots, 24 cleanup, 10 preview), so a read of any of them shows.
        environ = Recording(five, MICROVM_JOB_LIMIT="7", JOB_LIMIT="7", RUNNER_SLOTS="7")
        with patch.object(module.os, "environ", environ):
            config = module.Config.from_env()
        self.assertEqual(read, set(five))
        self.assertEqual((config.job_limit, config.preview_limit), (CODE_DEFAULT_LIMITS[0], 10))


class RecordingCloud(Cloud):
    """The fake provider, logging each call by ordinal label; it can fail, lag or nest a cleanup in a terminate."""

    def __init__(self, log, vm):
        super().__init__()
        self.log, self.vm = log, vm
        self.fail_terminate, self.lagging, self.during_terminate = set(), set(), {}

    def launch(self, parameters):
        answer = super().launch(parameters)
        self.log.append(("launch", self.vm(answer["microvmId"])))
        return answer

    def get(self, vm_id):
        self.log.append(("get", self.vm(vm_id)))
        return super().get(vm_id)

    def terminate(self, vm_id):
        name = self.vm(vm_id)
        self.log.append(("terminate", name))
        nested = self.during_terminate.pop(name, None)
        if nested:
            nested()
            self.log.append(("nested-returned", name))
        if name in self.fail_terminate:
            raise Unavailable("provider refused terminate")
        super().terminate(vm_id)
        if name in self.lagging:
            self.vms[vm_id]["state"] = "TERMINATING"
        return {}


class RecordingGuest(Guest):
    def __init__(self, log, operation, vm):
        super().__init__()
        self.log, self.operation, self.vm = log, operation, vm

    def request(self, row, route, body=None, timeout=30):
        self.log.append((route, self.operation(row["id"])))
        return super().request(row, route, body, timeout)

    def forget(self, vm_id):
        self.log.append(("forget", self.vm(vm_id)))


class DeferredCleanups:
    """Stands in for threading.Thread in bridge: a started cleanup_one thread is held until run(operation);
    every other thread is a real one."""

    def __init__(self):
        self.real, self.pending = threading.Thread, {}

    def __call__(self, target=None, args=(), daemon=None, **options):
        if getattr(target, "__func__", None) is not Bridge.cleanup_one:
            return self.real(target=target, args=args, daemon=daemon, **options)
        pending = self.pending

        class Held:
            def start(self):
                pending[args[0]] = lambda: target(*args)
        return Held()

    def run(self, operation):
        self.pending.pop(operation)()


def cleanup_scenario(**limits):
    """One fixed scenario through execute, its teardown threads and the reaper: a teardown that starts while
    another runs, a failed terminate and its retry, an accepted but unconfirmed terminate, and a VM the provider
    already reports TERMINATED. Returns the provider and guest calls in order, with row and health checkpoints."""
    log, names = [], {}

    def operation(op):
        return "o" + names.setdefault(op, str(len(names) + 1))

    def vm(vm_id):
        return "v" + operation(vm_id[len("mvm-"):])[1:]

    temp = tempfile.TemporaryDirectory()
    registry = Registry(Path(temp.name) / "private" / "registry.sqlite")
    cloud, guest = RecordingCloud(log, vm), RecordingGuest(log, operation, vm)
    bridge = Bridge(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, boot_seconds=1, **limits), registry, cloud, guest)
    deferred = DeferredCleanups()
    order = []

    def admitted():
        before = set(deferred.pending)
        assert bridge.execute(JOB) == RESULT
        (new,) = set(deferred.pending) - before
        order.append(new)
        return new

    def row(op):
        value = registry.get(op)
        return (operation(op), value["state"], value["cleanup_outcome"], value["cleanup_attempts"],
                value["cleanup_error_code"])

    def checkpoint(name):
        health = bridge.health()
        log.append((name, health["slots"], health["inFlight"], health["waiting"], tuple(row(op) for op in order)))

    try:
        with patch("bridge.threading.Thread", deferred):
            first, second = admitted(), admitted()
            checkpoint("two-cleaning")
            # The second run's own teardown thread starts while the first's terminate is in flight.
            cloud.during_terminate["v1"] = lambda: deferred.run(second)
            deferred.run(first)
            checkpoint("after-first-teardown")
            bridge.sweep()
            checkpoint("after-sweep")
            cloud.fail_terminate.add("v3")
            deferred.run(admitted())
            checkpoint("after-failed-terminate")
            cloud.fail_terminate.clear()
            bridge.sweep()
            checkpoint("after-retry")
            cloud.lagging.add("v4")
            lagging = admitted()
            deferred.run(lagging)
            checkpoint("after-unconfirmed-terminate")
            cloud.vms["mvm-" + lagging]["state"] = "TERMINATED"
            bridge.sweep()
            checkpoint("after-confirmation")
            gone = admitted()
            cloud.vms["mvm-" + gone]["state"] = "TERMINATED"
            deferred.run(gone)
            checkpoint("final")
    finally:
        registry.close()
        temp.cleanup()
    return log


# The calls of cleanup_scenario() at a job limit of 2 and a cleanup limit of 1, recorded from a controller that ran
# one teardown at a time and kept byte for byte: at cleanup_limit 1 the controller must make exactly these.
RECORDED_SERIAL_SEQUENCE = [
    ('launch', 'v1'),
    ('/health', 'o1'),
    ('/execute', 'o1'),
    ('launch', 'v2'),
    ('/health', 'o2'),
    ('/execute', 'o2'),
    ('two-cleaning', 2, 2, 0, (('o1', 'cleanup', None, 0, None), ('o2', 'cleanup', None, 0, None))),
    ('get', 'v1'),
    ('terminate', 'v1'),
    ('nested-returned', 'v1'),
    ('get', 'v1'),
    ('forget', 'v1'),
    ('after-first-teardown',
     2,
     1,
     0,
     (('o1', 'terminated', 'provider-terminated', 1, None), ('o2', 'cleanup', None, 0, None))),
    ('get', 'v2'),
    ('terminate', 'v2'),
    ('get', 'v2'),
    ('forget', 'v2'),
    ('after-sweep',
     2,
     0,
     0,
     (('o1', 'terminated', 'provider-terminated', 1, None), ('o2', 'terminated', 'provider-terminated', 1, None))),
    ('launch', 'v3'),
    ('/health', 'o3'),
    ('/execute', 'o3'),
    ('get', 'v3'),
    ('terminate', 'v3'),
    ('after-failed-terminate',
     2,
     1,
     0,
     (('o1', 'terminated', 'provider-terminated', 1, None),
      ('o2', 'terminated', 'provider-terminated', 1, None),
      ('o3', 'cleanup', None, 1, 'unavailable'))),
    ('get', 'v3'),
    ('terminate', 'v3'),
    ('get', 'v3'),
    ('forget', 'v3'),
    ('after-retry',
     2,
     0,
     0,
     (('o1', 'terminated', 'provider-terminated', 1, None),
      ('o2', 'terminated', 'provider-terminated', 1, None),
      ('o3', 'terminated', 'provider-terminated', 2, 'unavailable'))),
    ('launch', 'v4'),
    ('/health', 'o4'),
    ('/execute', 'o4'),
    ('get', 'v4'),
    ('terminate', 'v4'),
    ('get', 'v4'),
    ('after-unconfirmed-terminate',
     2,
     1,
     0,
     (('o1', 'terminated', 'provider-terminated', 1, None),
      ('o2', 'terminated', 'provider-terminated', 1, None),
      ('o3', 'terminated', 'provider-terminated', 2, 'unavailable'),
      ('o4', 'cleanup', None, 1, None))),
    ('get', 'v4'),
    ('forget', 'v4'),
    ('after-confirmation',
     2,
     0,
     0,
     (('o1', 'terminated', 'provider-terminated', 1, None),
      ('o2', 'terminated', 'provider-terminated', 1, None),
      ('o3', 'terminated', 'provider-terminated', 2, 'unavailable'),
      ('o4', 'terminated', 'provider-terminated', 2, None))),
    ('launch', 'v5'),
    ('/health', 'o5'),
    ('/execute', 'o5'),
    ('get', 'v5'),
    ('forget', 'v5'),
    ('final',
     2,
     0,
     0,
     (('o1', 'terminated', 'provider-terminated', 1, None),
      ('o2', 'terminated', 'provider-terminated', 1, None),
      ('o3', 'terminated', 'provider-terminated', 2, 'unavailable'),
      ('o4', 'terminated', 'provider-terminated', 2, None),
      ('o5', 'terminated', 'provider-terminated', 1, None))),
]


class OverlapCloud(Cloud):
    """terminate waits at a barrier of `width` before it returns, so a round passes only with `width` teardowns in
    flight at once (and breaks after 3 s otherwise). `observe` runs once at the barrier, with every one inside.
    VMs in `unconfirmed` stay TERMINATING after an accepted terminate; terminates of VMs in `fail` are refused."""

    def __init__(self, width=None, hold=0.0):
        super().__init__()
        self.guard = threading.Lock()
        self.inside = self.peak = 0
        self.barrier = threading.Barrier(width, action=self.at_barrier, timeout=3) if width else None
        self.hold, self.fail, self.unconfirmed = hold, set(), set()
        self.terminates, self.threads = collections.Counter(), set()
        self.observe, self.seen_at_barrier = (lambda: None), None

    def at_barrier(self):
        self.seen_at_barrier = self.observe()

    def terminate(self, vm_id):
        with self.guard:
            self.inside += 1
            self.peak = max(self.peak, self.inside)
            self.terminates[vm_id] += 1
            self.threads.add(threading.get_ident())
        try:
            if self.barrier: self.barrier.wait()
            if self.hold: time.sleep(self.hold)
            if vm_id in self.fail: raise CloudError("terminate-microvm", "ThrottlingException", vm_id)
            super().terminate(vm_id)
            if vm_id in self.unconfirmed: self.vms[vm_id]["state"] = "TERMINATING"
            return {}
        finally:
            with self.guard: self.inside -= 1


class CleanupLimitTests(unittest.TestCase):
    """Up to cleanup_limit confirmed teardowns run at once (code default 24; 1 is the serial order), bounded by
    job_limit, and the job limit is bounded at JOB_LIMIT_BOUND (32)."""

    def make(self, cloud=None, code_defaults=False, **limits):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        registry = Registry(Path(temp.name) / "private" / "registry.sqlite")
        self.addCleanup(registry.close)
        threads = threading.active_count()
        def settle():
            for _ in range(300):
                if threading.active_count() <= threads: return
                time.sleep(.01)
        self.addCleanup(settle)
        cloud = cloud or Cloud()
        # Explicit limits over (2, 1) unless the case pins the code defaults themselves.
        if not code_defaults: limits = {"job_limit": 2, "cleanup_limit": 1, **limits}
        # The code defaults are read from bridge.Config itself, never from the unpaced shim above.
        config = (_bridge.Config if code_defaults else Config)("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS,
                                                              boot_seconds=1, **limits)
        return Bridge(config, registry, cloud, Guest()), registry, cloud

    def cleaning(self, bridge, registry, count):
        rows = []
        for _ in range(count):
            row = bridge._launch(bridge._admit("job", encode(JOB)))
            registry.update(row["id"], cleanup=1, state="cleanup")
            bridge._released(row["id"])
            rows.append(row)
        return rows

    def refused_admission(self, bridge):
        try:
            bridge._admit("job", encode(JOB), deadline=time.monotonic() + .05)
        except Refusal as refused:
            return refused.message
        return "admitted"

    def test_cleanup_limit_has_its_code_default_and_is_bounded_by_the_job_limit_refused_by_name(self):
        self.assertEqual(_bridge.Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS).cleanup_limit, CODE_DEFAULT_LIMITS[1])
        for job_limit in (1, 2, 8, 12):
            for cleanup in range(1, job_limit + 1):
                with self.subTest(job_limit=job_limit, cleanup=cleanup):
                    config = Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, job_limit=job_limit, cleanup_limit=cleanup)
                    self.assertEqual((config.job_limit, config.cleanup_limit), (job_limit, cleanup))
            for cleanup in (0, -1, job_limit + 1, 13, 1.0, True, "1", None):
                with self.subTest(job_limit=job_limit, cleanup=cleanup):
                    with self.assertRaises(ValueError) as refused:
                        Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, job_limit=job_limit, cleanup_limit=cleanup)
                    self.assertEqual(str(refused.exception),
                                     "cleanup_limit must be a whole number from 1 to the job limit (%d)" % job_limit)
        with self.assertRaises(ValueError) as refused:
            Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, job_limit=2, cleanup_limit=3)
        self.assertEqual(str(refused.exception), "cleanup_limit must be a whole number from 1 to the job limit (2)")
        with self.assertRaises(ValueError) as refused:
            Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, job_limit=33, cleanup_limit=1)
        self.assertEqual(str(refused.exception), "job_limit must be a whole number from 1 to 32 (the bounded preview policy)")

    def test_at_cleanup_limit_one_the_calls_equal_the_recorded_serial_sequence(self):
        # The recorded configuration, explicit: a job limit of 2 and a cleanup limit of 1. The checkpoints log
        # health's slots, so only this job limit replays the recording; it keeps proving that a cleanup limit of 1
        # is the serial order.
        for limits in ({"job_limit": 2, "cleanup_limit": 1},):
            with self.subTest(limits=limits):
                self.assertEqual(cleanup_scenario(**limits), RECORDED_SERIAL_SEQUENCE)

    def test_above_one_a_teardown_that_starts_while_another_runs_overlaps_it_instead_of_waiting_for_the_sweep(self):
        log = cleanup_scenario(job_limit=2, cleanup_limit=2)
        start = log.index(("terminate", "v1"))
        self.assertEqual(log[start:start + 8], [
            ("terminate", "v1"), ("get", "v2"), ("terminate", "v2"), ("get", "v2"), ("forget", "v2"),
            ("nested-returned", "v1"), ("get", "v1"), ("forget", "v1")])
        first = next(entry for entry in log if entry[0] == "after-first-teardown")
        self.assertEqual(first[1:4], (2, 0, 0))
        after = log.index(first)
        self.assertEqual(log[after + 1][0], "after-sweep", "the sweep has nothing left to clean")
        # From the third run on, one teardown at a time: the calls are the recorded ones.
        tail = RECORDED_SERIAL_SEQUENCE.index(("launch", "v3"))
        self.assertEqual(log[log.index(("launch", "v3")):], RECORDED_SERIAL_SEQUENCE[tail:])

    def test_at_cleanup_limit_one_the_sweep_cleans_in_line_one_teardown_after_another(self):
        cloud = OverlapCloud(hold=.01)
        bridge, registry, _ = self.make(cloud, job_limit=3)
        self.cleaning(bridge, registry, 3)
        real, started = threading.Thread, []
        def counted(*args, **options):
            started.append(options.get("target"))
            return real(*args, **options)
        with patch("bridge.threading.Thread", side_effect=counted):
            bridge.sweep()
        self.assertEqual(started, [])
        self.assertEqual((cloud.peak, cloud.threads), (1, {threading.get_ident()}))
        self.assertEqual(registry.stats()["job"], 0)

    def test_at_cleanup_limit_n_the_sweeps_n_teardowns_overlap_and_no_slot_frees_before_its_confirmation(self):
        for n in (2, 4, 10):
            with self.subTest(n=n):
                cloud = OverlapCloud(width=n)
                bridge, registry, _ = self.make(cloud, job_limit=n, cleanup_limit=n)
                rows = self.cleaning(bridge, registry, n)
                late = rows[0]
                cloud.unconfirmed.add(late["vm_id"])
                cloud.observe = lambda: (registry.stats()["job"], self.refused_admission(bridge), cloud.inside)
                bridge.sweep()
                self.assertEqual(cloud.seen_at_barrier, (n, "runner capacity is full", n))
                self.assertEqual(cloud.peak, n)
                # An accepted terminate is not a confirmation: that VM keeps its slot.
                self.assertEqual(registry.stats()["job"], 1)
                self.assertEqual((registry.get(late["id"])["state"], registry.get(late["id"])["cleanup_outcome"]), ("cleanup", None))
                for row in rows[1:]:
                    self.assertEqual(registry.get(row["id"])["cleanup_outcome"], "provider-terminated")
                cloud.barrier = None
                cloud.vms[late["vm_id"]]["state"] = "TERMINATED"
                bridge.sweep()
                self.assertEqual(registry.stats()["job"], 0)
                self.assertEqual(registry.get(late["id"])["cleanup_outcome"], "provider-terminated")
                self.assertEqual(sorted(cloud.terminates.values()), [1] * n, "no VM is terminated twice")

    def test_at_cleanup_limit_n_each_runs_own_teardown_thread_overlaps_the_others(self):
        for n in (2, 4):
            with self.subTest(n=n):
                cloud = OverlapCloud(width=n)
                bridge, registry, _ = self.make(cloud, job_limit=n, cleanup_limit=n)
                cloud.observe = lambda: (registry.stats()["job"], cloud.inside)
                with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
                    results = list(pool.map(lambda _: bridge.execute(JOB), range(n)))
                self.assertEqual(results, [RESULT] * n)
                for _ in range(300):
                    if registry.stats()["job"] == 0: break
                    time.sleep(.01)
                self.assertEqual(registry.stats()["job"], 0, "every run's own teardown confirmed without a sweep")
                self.assertEqual((cloud.seen_at_barrier, cloud.peak), ((n, n), n))
                self.assertEqual(sorted(cloud.terminates.values()), [1] * n)

    def test_concurrent_teardowns_never_exceed_the_limit_and_never_clean_one_row_twice(self):
        cloud = OverlapCloud(hold=.05)
        bridge, registry, _ = self.make(cloud, job_limit=6, cleanup_limit=2)
        rows = self.cleaning(bridge, registry, 6)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda _: bridge.sweep(), range(3)))
        for _ in range(20):
            if not registry.active(): break
            bridge.sweep()
        self.assertEqual(cloud.peak, 2)
        self.assertEqual(sorted(cloud.terminates.values()), [1] * 6)
        self.assertEqual(registry.stats()["job"], 0)
        # Four callers asking to clean the same row at once: one teardown.
        bridge, registry, cloud = self.make(OverlapCloud(hold=.05), job_limit=4, cleanup_limit=4)
        (row,) = self.cleaning(bridge, registry, 1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: bridge.cleanup_one(row["id"]), range(4)))
        self.assertEqual((cloud.terminates[row["vm_id"]], registry.get(row["id"])["cleanup_attempts"]), (1, 1))
        self.assertEqual(registry.get(row["id"])["state"], "terminated")

    def test_a_teardown_failure_under_concurrency_is_recorded_and_keeps_its_slot(self):
        cloud = OverlapCloud(width=3)
        bridge, registry, _ = self.make(cloud, job_limit=3, cleanup_limit=3)
        rows = self.cleaning(bridge, registry, 3)
        failing = rows[1]
        cloud.fail.add(failing["vm_id"])
        cloud.observe = lambda: registry.stats()["job"]
        bridge.sweep()
        self.assertEqual((cloud.seen_at_barrier, cloud.peak), (3, 3))
        saved = registry.get(failing["id"])
        self.assertEqual((saved["state"], saved["cleanup"], saved["cleanup_outcome"], saved["cleanup_attempts"]),
                         ("cleanup", 1, None, 1))
        self.assertEqual(saved["cleanup_error_code"], "cloud_throttled")
        for row in (rows[0], rows[2]):
            self.assertEqual(registry.get(row["id"])["cleanup_outcome"], "provider-terminated")
        self.assertEqual(registry.stats()["job"], 1)
        # The failed teardown still holds its slot: at job limit 3 two new runs are admitted, the third is not.
        admitted = [bridge._admit("job", encode(JOB)) for _ in range(2)]
        self.assertEqual(self.refused_admission(bridge), "runner capacity is full")
        for row in admitted:
            registry.update(row["id"], cleanup=1)
            bridge._released(row["id"])
        cloud.barrier = None
        cloud.fail.clear()
        bridge.sweep()
        self.assertEqual(registry.get(failing["id"])["cleanup_outcome"], "provider-terminated")
        self.assertEqual(registry.get(failing["id"])["cleanup_attempts"], 2)
        self.assertEqual(registry.stats()["job"], 0)

    def test_health_reports_the_cleanup_limit_beside_slots_and_keeps_every_other_key(self):
        keys = {"ok", "transport", "protocol", "capabilities", "isolation", "slots", "cleanupLimit", "inFlight",
                "previews", "previewSlots", "expiredUnconfirmed", "waiting", "readiness", "launchThrottles",
                "launchRate", "launchBurst", "launchPaced", "launchPacedMs"}
        for limits, expected in (({}, CODE_DEFAULT_LIMITS), ({"job_limit": 10, "cleanup_limit": 4}, (10, 4)),
                                 ({"job_limit": 12, "cleanup_limit": 12}, (12, 12))):
            with self.subTest(limits=limits):
                bridge, _, _ = self.make(code_defaults=not limits, **limits)
                health = bridge.health()
                self.assertEqual(set(health), keys)
                self.assertEqual((health["slots"], health["cleanupLimit"], health["previewSlots"]), expected + (10,))

    def test_the_environment_file_never_sets_the_cleanup_limit(self):
        import bridge as module
        five = {"AWS_REGION": "ap-southeast-1", "MICROVM_IMAGE_ARN": IMAGE, "MICROVM_IMAGE_VERSION": "1",
                "MICROVM_INGRESS_ARN": INGRESS, "MICROVM_EGRESS_ARN": EGRESS}
        read = set()
        class Recording(dict):
            def __getitem__(self, key): read.add(key); return dict.__getitem__(self, key)
            def get(self, key, default=None): read.add(key); return dict.get(self, key, default)
        environ = Recording(five, MICROVM_CLEANUP_LIMIT="4", CLEANUP_LIMIT="4", MICROVM_JOB_LIMIT="12")
        with patch.object(module.os, "environ", environ):
            config = module.Config.from_env()
        self.assertEqual(read, set(five))
        self.assertEqual((config.job_limit, config.cleanup_limit), CODE_DEFAULT_LIMITS)

    def test_admission_is_atomic_at_a_job_limit_of_twelve(self):
        bridge, registry, _ = self.make(job_limit=12)
        def create(_):
            try: return bridge._admit("job", encode(JOB))["id"]
            except Refusal: return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
            ids = list(pool.map(create, range(24)))
        self.assertEqual(sum(bool(x) for x in ids), 12)
        self.assertEqual((registry.stats()["job"], bridge.health()["slots"]), (12, 12))
        for operation in list(bridge.active): bridge._released(operation)


class UnixHttpTests(unittest.TestCase):
    def test_actual_unix_health_body_validation_and_error_mapping(self):
        class FakeBridge:
            config = Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, job_limit=2, cleanup_limit=1)
            def health(self): return {"ok": True}
            def execute(self, job): raise Unavailable("secret-canary")
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "runner.sock")
            server = Server(path, FakeBridge())
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            def request(method, route, body=None):
                import socket
                conn = http.client.HTTPConnection("localhost")
                conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); conn.sock.connect(path)
                conn.request(method, route, body=body)
                response = conn.getresponse(); result = response.status, response.read()
                conn.close(); return result
            try:
                self.assertEqual(request("GET", "/health"), (200, b'{"ok":true}'))
                self.assertEqual(request("POST", "/execute", b'[]')[0], 400)
                self.assertEqual(request("POST", "/execute", b'{"x":NaN}')[0], 400)
                status, raw = request("POST", "/execute", encode(JOB))
                self.assertEqual(status, 502)
                self.assertNotIn(b"secret-canary", raw)
                self.assertEqual(request("POST", "/run", b'{}')[0], 404)
            finally:
                server.shutdown(); server.server_close(); thread.join()



# The CLI's own error lines (aws-cli/2.36.44, the host's version), recorded from the real binary with the
# controller's environment (AWS_MAX_ATTEMPTS=1) against a local fake endpoint.
CLI_THROTTLED = b"\naws: [ERROR]: An error occurred (ThrottlingException) when calling the RunMicrovm operation (reached max retries: 0): Rate exceeded\n"
CLI_TOO_MANY = b"\naws: [ERROR]: An error occurred (TooManyRequestsException) when calling the RunMicrovm operation (reached max retries: 0): Rate exceeded\n"
CLI_BARE_429 = b"\naws: [ERROR]: An error occurred (429) when calling the RunMicrovm operation (reached max retries: 0): <html>Too Many Requests</html>\n"
CLI_NOT_FOUND = b"\naws: [ERROR]: An error occurred (ResourceNotFoundException) when calling the GetMicrovm operation (reached max retries: 0): MicroVM not found\n"


def limited_bridge(test, cloud=None, guest=None, **limits):
    temp = tempfile.TemporaryDirectory()
    test.addCleanup(temp.cleanup)
    registry = Registry(Path(temp.name) / "private" / "registry.sqlite")
    test.addCleanup(registry.close)
    threads = threading.active_count()
    def settle():
        for _ in range(300):
            if threading.active_count() <= threads: return
            time.sleep(.01)
    test.addCleanup(settle)
    cloud, guest = cloud or Cloud(), guest or Guest()
    limits = {"job_limit": 2, "cleanup_limit": 1, **limits}
    config = Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, **limits)
    return Bridge(config, registry, cloud, guest), registry, cloud


class AdmissionRecheckTests(unittest.TestCase):
    """A teardown confirmed between the registry's Full and the read of the cleaning rows must not turn a free slot
    into an instant 503 (a refused call followed at once by an admitted one)."""

    def confirming_between_full_and_the_cleaning_read(self, bridge, registry, row):
        """registry.active() as the probe's interleaving: the teardown confirms just before the first read after Full."""
        real, fired = registry.active, []
        def active():
            if not fired:
                fired.append(True)
                registry.update(row["id"], state="terminated", cleanup_outcome="provider-terminated")
            return real()
        return patch.object(registry, "active", side_effect=active)

    def counted_creates(self, registry):
        real, calls = registry.create, []
        def create(*args, **options):
            calls.append(args[0])
            return real(*args, **options)
        return patch.object(registry, "create", side_effect=create), calls

    def test_a_teardown_confirmed_between_full_and_the_cleaning_read_is_admitted_on_one_recheck(self):
        for purpose, job, limits in (("job", JOB, {"job_limit": 1, "cleanup_limit": 1}), ("preview", PREVIEW, {"preview_limit": 2})):
            with self.subTest(purpose=purpose):
                bridge, registry, _ = limited_bridge(self, **limits)
                raw = initial_bytes(job, purpose)
                # The limit is full: one row is cleaning (its teardown confirms in the race); for previews the
                # second slot holds a live preview that is not cleaning.
                rows = [bridge._admit(purpose, raw) for _ in range(1 if purpose == "job" else 2)]
                registry.update(rows[0]["id"], cleanup=1, state="cleanup")
                bridge._released(rows[0]["id"])
                creates, calls = self.counted_creates(registry)
                with self.confirming_between_full_and_the_cleaning_read(bridge, registry, rows[0]), creates, \
                     patch.object(bridge.capacity_changed, "wait", side_effect=AssertionError("must not wait")):
                    admitted = bridge._admit(purpose, raw, deadline=time.monotonic() + 2 if purpose == "job" else None)
                self.assertNotIn(admitted["id"], [row["id"] for row in rows])
                self.assertEqual(calls, [purpose, purpose], "one Full, then one re-check that admits")
                self.assertEqual(registry.stats()[purpose], len(rows))
                for operation in list(bridge.active): bridge._released(operation)

    def test_the_probes_execute_is_answered_not_refused(self):
        bridge, registry, cloud = limited_bridge(self, job_limit=1, cleanup_limit=1, boot_seconds=1)
        row = bridge._admit("job", encode(JOB))
        registry.update(row["id"], cleanup=1, state="cleanup")
        bridge._released(row["id"])
        with self.confirming_between_full_and_the_cleaning_read(bridge, registry, row):
            self.assertEqual(bridge.execute(JOB), RESULT)
        self.assertEqual([call[0] for call in cloud.calls][:1], ["launch"])

    def test_the_recheck_is_bounded_to_one_and_full_active_capacity_is_still_refused_at_once(self):
        bridge, registry, cloud = limited_bridge(self, job_limit=2)
        for _ in range(2): bridge._admit("job", encode(JOB))
        creates, calls = self.counted_creates(registry)
        with creates, patch.object(bridge.capacity_changed, "wait", side_effect=AssertionError("must not wait")):
            started = time.monotonic()
            with self.assertRaises(Refusal) as refused:
                bridge._admit("job", encode(JOB), deadline=time.monotonic() + 2)
            elapsed = time.monotonic() - started
        self.assertEqual((refused.exception.status, refused.exception.message), (503, "runner capacity is full"))
        self.assertEqual(calls, ["job", "job"], "exactly one re-check, never a loop")
        self.assertLess(elapsed, .5)
        self.assertEqual(cloud.calls, [])
        for operation in list(bridge.active): bridge._released(operation)

    def test_a_recheck_that_finds_a_newly_cleaning_row_waits_as_before(self):
        bridge, registry, _ = limited_bridge(self, job_limit=1, cleanup_limit=1)
        first = bridge._admit("job", encode(JOB))
        registry.update(first["id"], cleanup=1, state="cleanup")
        bridge._released(first["id"])
        second = {}
        real_active, fired = registry.active, []
        def active():
            # The probe's interleaving, and in between another run took the freed slot and finished.
            if not fired:
                fired.append(True)
                registry.update(first["id"], state="terminated", cleanup_outcome="provider-terminated")
                second.update(bridge._admit("job", encode(JOB)))
                registry.update(second["id"], cleanup=1, state="cleanup")
                bridge._released(second["id"])
            return real_active()
        waited = []
        def wait(timeout=None):
            waited.append(timeout)
            registry.update(second["id"], state="terminated", cleanup_outcome="provider-terminated")
        with patch.object(registry, "active", side_effect=active), \
             patch.object(bridge.capacity_changed, "wait", side_effect=wait):
            admitted = bridge._admit("job", encode(JOB), deadline=time.monotonic() + 2)
        self.assertEqual(len(waited), 1, "a cleaning row found on the re-check is waited for")
        self.assertNotIn(admitted["id"], (first["id"], second["id"]))
        bridge._released(admitted["id"])


class ConnectionCapTests(unittest.TestCase):
    """The server's concurrent-connection cap follows the configured limits (job_limit + preview_limit + 4, never
    below CONNECTION_FLOOR, 12), so at C = 10 previews, health and the operator still fit."""

    def server_for(self, **limits):
        import serve
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        bridge, _, _ = limited_bridge(self, **limits)
        server = serve.Server(str(Path(folder.name) / "runner.sock"), bridge)
        self.addCleanup(server.server_close)
        return server

    def held(self, server):
        count = 0
        while server.connections.acquire(blocking=False):
            count += 1
            if count > 100: break
        return count

    def test_the_cap_is_never_below_twelve_and_derived_from_the_limits_above_it(self):
        """The first three cases sit below the floor of 12 (C + P + 4 is 6, 8 and 8), so dropping the max() in
        serve.connection_limit fails them, and the fourth sits at it (12); they name a small preview_limit (2, and 1)
        explicitly, below the code default of 10. The rest are above the floor: C + P + 4."""
        import serve
        self.assertEqual((serve.CONNECTION_FLOOR, serve.CONNECTION_HEADROOM), (12, 4))
        for limits, expected in (({"job_limit": 1, "preview_limit": 1}, 12), ({"preview_limit": 2}, 12),
                                 ({"job_limit": 2, "cleanup_limit": 1, "preview_limit": 2}, 12),
                                 ({"job_limit": 6, "preview_limit": 2}, 12), ({}, 16), ({"job_limit": 6}, 20),
                                 ({"job_limit": 8}, 22), ({"job_limit": 10}, 24), ({"job_limit": 10, "cleanup_limit": 4}, 24),
                                 ({"job_limit": 12, "cleanup_limit": 12}, 26), ({"job_limit": 10, "preview_limit": 1}, 15)):
            with self.subTest(limits=limits):
                server = self.server_for(**limits)
                self.assertEqual(server.connection_limit, expected)
                self.assertEqual(self.held(server), expected)

    def test_the_cap_is_thirty_eight_at_the_code_defaults(self):
        """At bridge.Config's own defaults, 24 slots and 10 preview slots, the cap is max(12, 24 + 10 + 4) = 38. The
        pins above build through explicit limits, so only this one sees a drift in a code default or in the formula
        before the host's health read would."""
        import serve
        config = _bridge.Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS)
        self.assertEqual((config.job_limit, config.preview_limit), (CODE_DEFAULT_LIMITS[0], 10))
        self.assertEqual(serve.connection_limit(config), 38)

    def test_at_job_limit_ten_a_connection_beyond_the_cap_is_closed_and_one_within_it_is_served(self):
        import socket
        server = self.server_for(job_limit=10)
        for _ in range(23): self.assertTrue(server.connections.acquire(blocking=False))
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
        thread.start()
        def health():
            conn = http.client.HTTPConnection("localhost", timeout=2)
            conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); conn.sock.settimeout(2)
            conn.sock.connect(server.server_address)
            try:
                conn.request("GET", "/health"); response = conn.getresponse(); return response.status
            except (OSError, http.client.HTTPException):
                return None
            finally:
                conn.close()
        held = 23
        try:
            self.assertEqual(health(), 200, "the twenty-fourth connection at C = 10 is served (it was closed at 12)")
            self.assertTrue(server.connections.acquire(timeout=2), "the served connection gave its place back")
            held = 24
            self.assertIsNone(health(), "the twenty-fifth is closed at once, as the thirteenth was")
        finally:
            for _ in range(held): server.connections.release()
            server.shutdown(); thread.join(2)


class LaunchThrottleTests(unittest.TestCase):
    """RunMicrovm is rate limited per account and the CLI runs with AWS_MAX_ATTEMPTS=1, so without a re-send a
    throttled launch would fail its run. A throttled launch is re-sent with the same parameters (the same
    clientToken) after a jittered backoff, bounded, recorded on the row and counted on health."""

    def throttling_cloud(self, throttles, code="ThrottlingException"):
        cloud, left = Cloud(), [throttles]
        real = cloud.launch
        def launch(parameters):
            cloud.calls.append(("launch-sent", parameters))
            if left[0] > 0:
                left[0] -= 1
                raise CloudError("run-microvm", code)
            return real(parameters)
        cloud.launch = launch
        return cloud

    def test_the_cli_error_line_is_classified_as_the_cli_prints_it(self):
        from cloud import cloud_error
        for raw, operation, payload, code in (
                (CLI_THROTTLED, "run-microvm", {}, "cloud_throttled"),
                (CLI_TOO_MANY, "run-microvm", {}, "cloud_throttled"),
                (CLI_BARE_429, "run-microvm", {}, "cloud_throttled"),
                (CLI_NOT_FOUND, "get-microvm", {"microvmIdentifier": "mvm-one"}, "cloud_not_found"),
                (CLI_THROTTLED.replace(b"RunMicrovm", b"GetMicrovm"), "run-microvm", {}, "unavailable"),
                (b"log: " + CLI_THROTTLED.lstrip(), "run-microvm", {}, "unavailable"),
                (CLI_THROTTLED.replace(b"(reached max retries: 0)", b"(reached max tries: 0)"), "run-microvm", {}, "unavailable"),
                (CLI_BARE_429.replace(b"(429)", b"(500)"), "run-microvm", {}, "unavailable")):
            with self.subTest(raw=raw[:60], code=code):
                error = cloud_error(raw, operation, payload)
                self.assertEqual(error.code, code)
                self.assertEqual(error.retryable, code == "cloud_throttled")
                self.assertNotIn("Rate exceeded", str(error))
                self.assertNotIn("not found", str(error))
        self.assertEqual(cloud_error(CLI_NOT_FOUND, "get-microvm", {"microvmIdentifier": "mvm-one"}).resource_id, "mvm-one")

    def test_the_cli_runs_with_one_attempt_so_the_controller_owns_every_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            cli, seen = AwsCli("/usr/local/bin/aws", "ap-southeast-1", folder), {}
            def start(command, **options):
                seen.update(env=options["env"], command=command)
                options["stderr"].write(CLI_THROTTLED)
                from unittest.mock import Mock
                return Mock(returncode=254)
            with patch("cloud.subprocess.Popen", side_effect=start):
                with self.assertRaises(CloudError) as caught: cli.launch({"clientToken": "t"})
        self.assertEqual((caught.exception.code, caught.exception.retryable), ("cloud_throttled", True))
        self.assertEqual(seen["env"]["AWS_MAX_ATTEMPTS"], "1")
        self.assertNotIn("AWS_RETRY_MODE", seen["env"])
        self.assertEqual(seen["command"][seen["command"].index("--cli-read-timeout") + 1], "20")

    def test_the_retry_bounds_are_pinned(self):
        import bridge as module
        self.assertEqual((module.LAUNCH_BACKOFF_BASE, module.LAUNCH_BACKOFF_CAP,
                          module.LAUNCH_MAX_SENDS, module.LAUNCH_READY_RESERVE), (0.25, 1.0, 16, 10))

    def test_the_resend_window_is_one_named_constant_of_twenty_seconds(self):
        """The re-send window is LAUNCH_RETRY_WINDOW and nothing else: widening it (to 30 s at most) takes that one
        line and this pin's value. Every other pin reads the constant."""
        import bridge as module
        self.assertEqual(module.LAUNCH_RETRY_WINDOW, 20)
        # Inside the 60 s boot budget: a re-send that starts at the window's end and runs the CLI's own 20 s bound
        # still ends before the budget's last LAUNCH_READY_RESERVE seconds, which readiness and the run keep.
        self.assertLessEqual(module.LAUNCH_RETRY_WINDOW + 20, 60 - module.LAUNCH_READY_RESERVE)

    def always_throttled_sends(self, per_send, random_value):
        """Every send throttled, each costing per_send seconds of the CLI on a fake clock; returns the send times."""
        cloud = self.throttling_cloud(10 ** 6)
        bridge, _, _ = limited_bridge(self, cloud)
        clock, sends = [1000.0], []
        real_launch = cloud.launch
        def timed(parameters):
            sends.append(clock[0])
            clock[0] += per_send
            return real_launch(parameters)
        cloud.launch = timed
        with patch("bridge.time.monotonic", side_effect=lambda: clock[0]), \
             patch("bridge.time.sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
             patch("bridge.random.random", return_value=random_value), patch("bridge.threading.Thread", DeferredCleanups()):
            with self.assertRaises(CloudError) as caught: bridge.execute(JOB)
        self.assertEqual(caught.exception.code, "cloud_throttled")
        return [moment - sends[0] for moment in sends]

    def test_the_send_cap_alone_ends_a_fast_throttled_launch_at_exactly_sixteen_sends(self):
        import bridge as module
        # 0.05 s a send at the shortest backoff: sixteen sends take about 7.6 s, well inside the window, so only the
        # cap can stop them (a cap off by one, or removed, would survive every other pin).
        sends = self.always_throttled_sends(.05, 0.0)
        self.assertEqual(len(sends), module.LAUNCH_MAX_SENDS)
        self.assertLess(sends[-1], module.LAUNCH_RETRY_WINDOW / 2)

    def test_the_window_alone_ends_a_slow_throttled_launch_before_the_send_cap(self):
        import bridge as module
        # 2 s a send at the longest backoff: the window binds first, after fewer than sixteen sends (8 at 20 s), and
        # the last send starts inside it (a removed window would survive every other pin).
        sends = self.always_throttled_sends(2.0, 1.0)
        self.assertLess(len(sends), module.LAUNCH_MAX_SENDS)
        self.assertLessEqual(sends[-1], module.LAUNCH_RETRY_WINDOW)
        self.assertGreater(sends[-1] + 2.0 + module.LAUNCH_BACKOFF_CAP, module.LAUNCH_RETRY_WINDOW,
                           "the next re-send would have started past the window")
        self.assertGreater(len(sends), 1)

    def test_a_throttled_launch_is_resent_with_the_same_parameters_and_its_run_succeeds(self):
        for code in ("ThrottlingException", "TooManyRequestsException", "429"):
            with self.subTest(code=code):
                cloud = self.throttling_cloud(2, code)
                bridge, registry, _ = limited_bridge(self, cloud)
                slept = []
                with patch("bridge.time.sleep", side_effect=slept.append), patch("bridge.random.random", return_value=.5):
                    self.assertEqual(bridge.execute(JOB), RESULT)
                sent = [call[1] for call in cloud.calls if call[0] == "launch-sent"]
                self.assertEqual(len(sent), 3)
                self.assertTrue(all(parameters == sent[0] for parameters in sent), "the same parameters and clientToken")
                self.assertEqual(slept, [.25 * .75, .5 * .75])
                saved = registry.get(sent[0]["clientToken"])
                self.assertEqual(saved["launch_attempts"], 1, "a throttle is not an unknown launch")
                self.assertEqual((saved["last_error_code"], saved["last_error_stage"]), ("cloud_throttled", "launch"))
                self.assertEqual(saved["result_ok"], 1)
                self.assertEqual(bridge.health()["launchThrottles"], 2)

    def test_an_always_throttled_launch_gives_up_within_the_window_and_fails_its_run_as_before(self):
        import bridge as module
        cloud = self.throttling_cloud(10 ** 6)
        bridge, registry, _ = limited_bridge(self, cloud)
        clock, sends = [1000.0], []
        def sleep(seconds):
            self.assertLessEqual(seconds, module.LAUNCH_BACKOFF_CAP)
            clock[0] += seconds
        real_launch = cloud.launch
        def timed(parameters):
            sends.append(clock[0])
            clock[0] += .35  # the CLI's measured round trip for a throttle answer
            return real_launch(parameters)
        cloud.launch = timed
        with patch("bridge.time.monotonic", side_effect=lambda: clock[0]), patch("bridge.time.sleep", side_effect=sleep), \
             patch("bridge.random.random", return_value=1.0), patch("bridge.threading.Thread", DeferredCleanups()):
            with self.assertRaises(CloudError) as caught: bridge.execute(JOB)
        self.assertEqual(caught.exception.code, "cloud_throttled")
        self.assertLessEqual(len(sends), module.LAUNCH_MAX_SENDS)
        self.assertGreater(len(sends), 1)
        self.assertLessEqual(sends[-1] - sends[0], module.LAUNCH_RETRY_WINDOW)
        saved = registry.get(cloud.calls[0][1]["clientToken"])
        self.assertEqual((saved["launch_attempts"], saved["last_error_code"], saved["last_error_stage"]), (1, "cloud_throttled", "launch"))
        self.assertEqual(bridge.health()["launchThrottles"], len(sends))
        self.assertEqual(saved["cleanup"], 1)

    def test_a_retry_never_sleeps_into_the_last_ten_seconds_of_the_boot_budget(self):
        for boot, most in ((12, 2.0), (30, 20.0), (1, 0.0)):
            with self.subTest(boot_seconds=boot):
                cloud = self.throttling_cloud(10 ** 6)
                bridge, _, _ = limited_bridge(self, cloud, boot_seconds=boot)
                clock, slept = [1000.0], []
                def sleep(seconds):
                    slept.append(seconds)
                    clock[0] += seconds
                with patch("bridge.time.monotonic", side_effect=lambda: clock[0]), \
                     patch("bridge.time.sleep", side_effect=sleep), patch("bridge.threading.Thread", DeferredCleanups()):
                    with self.assertRaises(CloudError): bridge.execute(JOB)
                # every re-send starts before the boot deadline less the 10 s reserve (and within the 20 s window)
                self.assertLessEqual(sum(slept), most)
                self.assertLessEqual(clock[0], 1000.0 + max(boot - 10, 0) + 1e-9)
                if boot == 1: self.assertEqual(slept, [], "no boot budget left for a retry: the run fails")
                else: self.assertTrue(slept)

    def test_only_a_throttle_is_resent(self):
        for error in (CloudError("run-microvm", "ValidationException"), CloudError("run-microvm", "InternalServerException"),
                      CloudError("run-microvm", "ServiceQuotaExceededException"), Unavailable("cloud operation timed out", code="cloud_timeout"),
                      Unavailable("cloud response unavailable", code="cloud_response")):
            with self.subTest(code=error.code):
                cloud = Cloud()
                sent = []
                def launch(parameters, error=error):
                    sent.append(parameters)
                    raise error
                cloud.launch = launch
                bridge, _, _ = limited_bridge(self, cloud)
                with patch("bridge.time.sleep", side_effect=AssertionError("no backoff")), \
                     patch("bridge.threading.Thread", DeferredCleanups()):
                    with self.assertRaises(Unavailable): bridge.execute(JOB)
                self.assertEqual(len(sent), 1)
                self.assertEqual(bridge.health()["launchThrottles"], 0)

    def test_no_resend_once_the_controller_is_stopping(self):
        cloud = self.throttling_cloud(10 ** 6)
        bridge, _, _ = limited_bridge(self, cloud)
        slept = []
        def sleep(seconds):
            slept.append(seconds)
            bridge.closing = True
        with patch("bridge.time.sleep", side_effect=sleep), patch("bridge.threading.Thread", DeferredCleanups()):
            with self.assertRaises(CloudError): bridge.execute(JOB)
        self.assertEqual(len(slept), 1, "the throttle was backed off")
        self.assertEqual(len([c for c in cloud.calls if c[0] == "launch-sent"]), 1, "never re-sent after a stop")

    def test_the_backoff_holds_no_lock_so_health_and_another_admission_answer_at_once(self):
        # A backoff that slept under active_lock would survive every other pin; it would stall health, every
        # admission and every release for up to the whole window.
        cloud = self.throttling_cloud(1)
        bridge, registry, _ = limited_bridge(self, cloud)
        probes, stalled = [], []
        def probe():
            started = time.monotonic()
            bridge.health()
            row = bridge._admit("job", encode(JOB))
            probes.append(time.monotonic() - started)
            registry.update(row["id"], cleanup=1, state="terminated", cleanup_outcome="not-launched")
            bridge._released(row["id"])
        def sleep(seconds):
            thread = threading.Thread(target=probe, daemon=True)
            thread.start()
            thread.join(1.0)
            stalled.append(thread.is_alive())
        with patch("bridge.time.sleep", side_effect=sleep), patch("bridge.random.random", return_value=.5):
            self.assertEqual(bridge.execute(JOB), RESULT)
        self.assertEqual(stalled, [False], "health and an admission waited on the backoff")
        self.assertEqual(len(probes), 1)
        self.assertLess(probes[0], .25)

    def test_a_preview_stopped_during_its_backoff_gets_no_further_send(self):
        # Without the cleanup check after the sleep, a preview stopped during its backoff would be re-sent until
        # the window closed. Its own launch makes one send; the teardown's one replay is the second.
        cloud = self.throttling_cloud(10 ** 6)
        bridge, registry, _ = limited_bridge(self, cloud)
        slept, stopped, pause = [], [], time.sleep  # the patch replaces time.sleep everywhere; poll on the real one
        def sleep(seconds):
            slept.append(seconds)
            (row,) = registry.active()
            stopped.append(bridge.app("stop", {"id": row["id"]})["status"])
        with patch("bridge.time.sleep", side_effect=sleep):
            view = bridge.start(PREVIEW)
            for _ in range(400):
                saved = registry.get(view["id"])
                if saved["cleanup_attempts"] >= 1 and not bridge.active and not bridge.cleanup_slots.busy(): break
                pause(.005)
        self.assertEqual(stopped, ["stopped"])
        self.assertEqual(len(slept), 1, "no backoff after the stop")
        self.assertEqual(len([c for c in cloud.calls if c[0] == "launch-sent"]), 2, "the run's one send and the replay")
        saved = registry.get(view["id"])
        self.assertEqual((saved["cleanup"], saved["launch_attempts"]), (1, 1))

    def test_the_cleanup_replay_is_one_send_and_never_backs_off_while_it_holds_a_claim(self):
        cloud = self.throttling_cloud(10 ** 6)
        bridge, registry, _ = limited_bridge(self, cloud)
        row = bridge._admit("job", encode(JOB))
        row = registry.update(row["id"], launch_attempts=1, cleanup=1, state="cleanup")
        bridge._released(row["id"])
        with patch("bridge.time.sleep", side_effect=AssertionError("a teardown never sleeps on a throttle")):
            bridge.cleanup_one(row["id"])
        saved = registry.get(row["id"])
        # The throttle refused the replay: it is not spent, and the row's life is not extended (the next sweep repeats it).
        self.assertEqual((saved["launch_attempts"], saved["cleanup_error_code"], saved["state"]), (1, "cloud_throttled", "cleanup"))
        self.assertEqual(saved["expires"], row["expires"])
        self.assertEqual(len([c for c in cloud.calls if c[0] == "launch-sent"]), 1)
        self.assertEqual(bridge.health()["launchThrottles"], 1)

    def test_a_previews_throttled_launch_is_resent_too(self):
        cloud = self.throttling_cloud(1)
        bridge, registry, _ = limited_bridge(self, cloud)
        with patch("bridge.time.sleep"):
            view = bridge.start(PREVIEW)
            for _ in range(200):
                if registry.get(view["id"])["state"] == "running": break
                time.sleep(.005)
        self.assertEqual(registry.get(view["id"])["state"], "running")
        self.assertEqual(len([c for c in cloud.calls if c[0] == "launch-sent"]), 2)
        self.assertEqual(bridge.health()["launchThrottles"], 1)
        bridge.app("stop", {"id": view["id"]})

    def test_ten_launches_at_once_under_a_one_token_bucket_all_run(self):
        """The applied quota's shape (burst 1, a steady refill), with time scaled 20x: ten runs fired together at
        job limit 10 all return their verdict; the throttles are counted, none fails a run."""
        import bridge as module
        scale = 20.0
        class Bucket(Cloud):
            def __init__(self):
                super().__init__()
                self.guard, self.tokens, self.last, self.throttled = threading.Lock(), 1.0, time.monotonic(), 0
            def launch(self, parameters):
                time.sleep(.6 / scale)  # the CLI's start-up before the request leaves
                with self.guard:
                    now = time.monotonic()
                    self.tokens = min(1.0, self.tokens + (now - self.last) * scale)
                    self.last = now
                    if self.tokens < 1:
                        self.throttled += 1
                        raise CloudError("run-microvm", "ThrottlingException")
                    self.tokens -= 1
                    return super().launch(parameters)
        cloud = Bucket()
        bridge, registry, _ = limited_bridge(self, cloud, job_limit=10, cleanup_limit=10)
        with patch.object(module, "LAUNCH_BACKOFF_BASE", .25 / scale), patch.object(module, "LAUNCH_BACKOFF_CAP", 1.0 / scale), \
             patch.object(module, "LAUNCH_RETRY_WINDOW", module.LAUNCH_RETRY_WINDOW / scale), patch.object(module, "LAUNCH_READY_RESERVE", 0), \
             concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            fired = time.monotonic()
            results = list(pool.map(lambda _: bridge.execute(JOB), range(10)))
        self.assertEqual(results, [RESULT] * 10)
        self.assertLess(time.monotonic() - fired, 60 / scale, "the whole wave inside the boot budget")
        self.assertGreater(cloud.throttled, 0)
        self.assertEqual(bridge.health()["launchThrottles"], cloud.throttled)
        self.assertEqual(len(cloud.creates), 10)

    def test_health_names_the_launch_throttles_beside_every_other_key(self):
        bridge, _, _ = limited_bridge(self)
        self.assertEqual(bridge.health()["launchThrottles"], 0)


class ClaimNeverWaitsTests(unittest.TestCase):
    """A cleanup claim never waits; a pass that finds no free claim returns at once, with no call."""

    def test_a_cleanup_pass_that_finds_every_claim_taken_returns_at_once_and_makes_no_call(self):
        for limit in (1, 3):
            with self.subTest(cleanup_limit=limit):
                bridge, registry, cloud = limited_bridge(self, job_limit=3, cleanup_limit=limit)
                row = bridge._launch(bridge._admit("job", encode(JOB)))
                registry.update(row["id"], cleanup=1, state="cleanup")
                bridge._released(row["id"])
                for index in range(limit): self.assertTrue(bridge.cleanup_slots.claim("held-%d" % index))
                cloud.calls.clear()
                started = time.monotonic()
                bridge.cleanup_one(row["id"])
                self.assertLess(time.monotonic() - started, .05)
                self.assertEqual(cloud.calls, [])
                self.assertEqual(registry.get(row["id"])["cleanup_attempts"], 0)
                for index in range(limit): bridge.cleanup_slots.release("held-%d" % index)
                started = time.monotonic()
                self.assertTrue(bridge.cleanup_slots.claim(row["id"]))
                self.assertFalse(bridge.cleanup_slots.claim(row["id"]), "never two claims of one operation")
                self.assertLess(time.monotonic() - started, .05)
                bridge.cleanup_slots.release(row["id"])


class SweepWorkerStartTests(unittest.TestCase):
    """A sweep worker that cannot start (the unit's task limit) must not make the sweep raise,
    leave started workers unjoined, or make shutdown skip the socket unlink and print "startup failed"."""

    def test_a_worker_that_fails_to_start_leaves_every_pending_row_its_pass_and_joins_the_started_ones(self):
        for fail_at in (1, 2, 3):
            with self.subTest(fail_at=fail_at):
                bridge, registry, cloud = limited_bridge(self, job_limit=4, cleanup_limit=3)
                for _ in range(4):
                    row = bridge._launch(bridge._admit("job", encode(JOB)))
                    registry.update(row["id"], cleanup=1, state="cleanup")
                    bridge._released(row["id"])
                real, started = threading.Thread, []
                class Failing:
                    def __init__(self, *args, **options):
                        self.thread = real(*args, **options)
                    def start(self):
                        if len(started) + 1 == fail_at: raise RuntimeError("can't start new thread")
                        started.append(self.thread)
                        self.thread.start()
                    def join(self, timeout=None): self.thread.join(timeout)
                with patch("bridge.threading.Thread", Failing):
                    bridge.sweep()
                self.assertEqual(len(started), fail_at - 1)
                self.assertTrue(all(not thread.is_alive() for thread in started), "started workers are joined")
                self.assertEqual(registry.stats()["job"], 0, "every pending row had its pass")
                self.assertEqual(bridge.cleanup_slots.busy(), False)

    def test_shutdown_with_a_failing_worker_start_still_unlinks_the_socket_and_reports_no_startup_failure(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / "probe.py"
            script.write_text(SHUTDOWN_PROBE)
            here = str(Path(__file__).resolve().parent)
            result = subprocess.run([sys.executable, "-B", str(script), here, folder], capture_output=True, timeout=60,
                                    env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            self.assertNotIn(b"startup failed", result.stderr)
            self.assertIn(b"listening", result.stdout)
            self.assertIn(b"worker-start-refused", result.stdout, "the probe really refused a worker start")
            self.assertFalse((Path(folder) / "runner.sock").exists(), "the socket is unlinked at shutdown")


class ThrottledReplayTests(unittest.TestCase):
    """The teardown's same-token replay of an unknown launch tolerates a throttle.
    A throttled replay is a refused request: it does not spend the one replay or extend the row's life, the next
    sweep repeats it, and a replay throttled until the row's expiry ends expired-unconfirmed."""

    def throttled_row(self, throttles):
        cloud = LaunchThrottleTests.throttling_cloud(None, throttles)
        bridge, registry, _ = limited_bridge(self, cloud)
        row = bridge._admit("job", encode(JOB))
        row = registry.update(row["id"], launch_attempts=1, cleanup=1, state="cleanup")
        bridge._released(row["id"])
        return bridge, registry, cloud, row

    def test_a_throttled_replay_is_repeated_by_the_next_sweep_and_its_vm_confirmed(self):
        bridge, registry, cloud, row = self.throttled_row(2)
        bridge.sweep()
        bridge.sweep()
        self.assertEqual(registry.get(row["id"])["launch_attempts"], 1)
        bridge.sweep()
        saved = registry.get(row["id"])
        self.assertEqual((saved["state"], saved["cleanup_outcome"], saved["launch_attempts"]), ("terminated", "provider-terminated", 2))
        self.assertEqual(len([c for c in cloud.calls if c[0] == "launch-sent"]), 3)
        self.assertEqual([c[0] for c in cloud.calls if c[0] != "launch-sent"][-3:], ["get", "terminate", "get"])
        self.assertEqual((registry.stats()["job"], bridge.health()["launchThrottles"]), (0, 2))

    def test_a_replay_throttled_until_the_rows_expiry_ends_expired_unconfirmed_and_frees_the_slot(self):
        bridge, registry, cloud, row = self.throttled_row(10 ** 6)
        for _ in range(3): bridge.sweep()
        self.assertEqual(registry.get(row["id"])["expires"], row["expires"], "a throttle never extends the row's life")
        with patch("bridge.time.time", return_value=row["expires"] + 1):
            bridge.sweep()
        saved = registry.get(row["id"])
        self.assertEqual((saved["state"], saved["cleanup_outcome"]), ("expired-unconfirmed", "expired-unconfirmed"))
        self.assertEqual((registry.stats()["job"], bridge.health()["expiredUnconfirmed"]), (0, 1))

    def test_an_unknown_replay_answer_still_spends_the_replay(self):
        cloud = Cloud()
        sent = []
        def launch(parameters):
            sent.append(parameters)
            raise Unavailable("cloud operation timed out", code="cloud_timeout")
        cloud.launch = launch
        bridge, registry, _ = limited_bridge(self, cloud)
        row = bridge._admit("job", encode(JOB))
        registry.update(row["id"], launch_attempts=1, cleanup=1, state="cleanup")
        bridge._released(row["id"])
        bridge.sweep(); bridge.sweep()
        self.assertEqual((registry.get(row["id"])["launch_attempts"], len(sent)), (2, 1), "one bounded replay")


class CloseExpiredTests(unittest.TestCase):
    """A named operation closes an expired-unconfirmed row, on the controller's proof: the row is past its recorded
    life and one complete read-only inventory of the row's own image and version shows no MicroVM that is not
    TERMINATED and not a registered row's own. The life is the row's expiry plus the VM's maximum duration: a
    throttled replay puts the expiry back, so a VM that "throttled" send did start could outlive the expiry by one
    maximum duration."""

    def expired(self, items=(), next_token=None, fail=None):
        cloud = Cloud()
        cloud.inventory_calls = []
        def inventory(image, version):
            cloud.inventory_calls.append((image, version))
            if fail: raise fail
            answer = {"items": [dict(item) for item in items]}
            if next_token: answer["nextToken"] = next_token
            return answer
        cloud.inventory = inventory
        bridge, registry, _ = limited_bridge(self, cloud)
        row = bridge._admit("job", encode(JOB))
        life = json.loads(row["launch_json"])["maximumDurationInSeconds"]
        row = registry.update(row["id"], state="expired-unconfirmed", cleanup=1, cleanup_outcome="expired-unconfirmed",
                              launch_attempts=2, expires=time.time() - life - 1)
        bridge._released(row["id"])
        return bridge, registry, cloud, row

    def test_a_row_past_its_expiry_but_not_its_expiry_plus_the_vms_life_is_refused_and_closes_after_it(self):
        bridge, registry, cloud, row = self.expired()
        life = json.loads(row["launch_json"])["maximumDurationInSeconds"]
        self.assertEqual(life, 180)
        expires = time.time() - 1
        registry.update(row["id"], expires=expires)
        for now in (expires + 1, expires + life - 1):
            with self.subTest(after_expiry=now - expires):
                with patch("bridge.time.time", return_value=now):
                    with self.assertRaises(Refusal) as refused: bridge.close_expired({"id": row["id"]})
                self.assertEqual((refused.exception.status, refused.exception.message),
                                 (409, "the operation is not expired-unconfirmed"))
        self.assertEqual(cloud.inventory_calls, [], "no provider call before the row's whole life has passed")
        with patch("bridge.time.time", return_value=expires + life):
            self.assertEqual(bridge.close_expired({"id": row["id"]}), {"closed": True, "cleanupConfirmed": True})
        self.assertEqual(registry.get(row["id"])["cleanup_outcome"], "absent-after-expiry")

    def test_the_inventory_lists_the_rows_own_image_and_version_not_the_controllers_current_ones(self):
        bridge, registry, cloud, row = self.expired()
        bridge.config = replace(bridge.config, image=IMAGE + "-next", version="2")
        self.assertEqual(bridge.close_expired({"id": row["id"]}), {"closed": True, "cleanupConfirmed": True})
        self.assertEqual(cloud.inventory_calls, [(IMAGE, "1")])

    def test_an_unreadable_launch_record_closes_nothing_and_calls_no_provider(self):
        for launch in ("[]", "{}", json.dumps({"maximumDurationInSeconds": "180", "imageIdentifier": IMAGE, "imageVersion": "1"}),
                       json.dumps({"maximumDurationInSeconds": 180, "imageVersion": "1"})):
            with self.subTest(launch=launch):
                bridge, registry, cloud, row = self.expired()
                registry.db.execute("UPDATE operations SET launch_json=? WHERE id=?", (launch, row["id"]))
                with self.assertRaises(Refusal) as refused: bridge.close_expired({"id": row["id"]})
                self.assertEqual((refused.exception.status, refused.exception.message),
                                 (409, "the operation's launch record is unreadable"))
                self.assertEqual((cloud.inventory_calls, registry.get(row["id"])["state"]), ([], "expired-unconfirmed"))

    def test_closes_an_expired_unconfirmed_row_when_no_unregistered_microvm_of_the_image_runs(self):
        for items in ((), ({"microvmId": "mvm-gone", "state": "TERMINATED"},)):
            with self.subTest(items=items):
                bridge, registry, cloud, row = self.expired(items)
                live = bridge._launch(bridge._admit("job", encode(JOB)))  # a registered VM still running is no orphan
                cloud.inventory_calls.clear()
                items = list(items) + [{"microvmId": live["vm_id"], "state": "RUNNING"}]
                cloud.inventory = lambda image, version, items=items: (cloud.inventory_calls.append((image, version)) or {"items": items})
                self.assertEqual(bridge.close_expired({"id": row["id"]}), {"closed": True, "cleanupConfirmed": True})
                saved = registry.get(row["id"])
                self.assertEqual((saved["state"], saved["cleanup_outcome"]), ("terminated", "absent-after-expiry"))
                self.assertEqual(cloud.inventory_calls, [(IMAGE, "1")])
                self.assertEqual(bridge.health()["expiredUnconfirmed"], 0)
                bridge._released(live["id"])

    def test_refuses_by_name_without_the_proof(self):
        cases = (
            (dict(items=({"microvmId": "mvm-orphan", "state": "RUNNING"},)), 409, "an unregistered MicroVM of this image is still running"),
            (dict(items=({"microvmId": "mvm-orphan", "state": "TERMINATING"},)), 409, "an unregistered MicroVM of this image is still running"),
            (dict(next_token="more"), 409, "the MicroVM inventory is incomplete"),
        )
        for options, status, message in cases:
            with self.subTest(options=options):
                bridge, registry, _, row = self.expired(**options)
                with self.assertRaises(Refusal) as refused: bridge.close_expired({"id": row["id"]})
                self.assertEqual((refused.exception.status, refused.exception.message), (status, message))
                self.assertEqual(registry.get(row["id"])["state"], "expired-unconfirmed")
        bridge, registry, cloud, row = self.expired()
        other = bridge._admit("job", encode(JOB))
        with self.assertRaises(Refusal) as refused: bridge.close_expired({"id": other["id"]})
        self.assertEqual((refused.exception.status, refused.exception.message), (409, "the operation is not expired-unconfirmed"))
        bridge._released(other["id"])
        young = registry.update(row["id"], expires=time.time() + 60)
        with self.assertRaises(Refusal) as refused: bridge.close_expired({"id": young["id"]})
        self.assertEqual(refused.exception.message, "the operation is not expired-unconfirmed", "never before its recorded life")
        registry.update(row["id"], expires=time.time() - 1)
        for job, status in (({"id": "0" * 8 + "-0000-4000-8000-" + "0" * 12}, 404), ({"id": "not-an-id"}, 400),
                            ({"id": row["id"], "extra": 1}, 400), ({}, 400)):
            with self.subTest(job=job):
                with self.assertRaises(Refusal) as refused: bridge.close_expired(job)
                self.assertEqual(refused.exception.status, status)
        self.assertEqual(cloud.inventory_calls, [], "no provider call before the row and its state are checked")

    def test_an_inventory_failure_closes_nothing(self):
        bridge, registry, _, row = self.expired(fail=CloudError("list-microvms", "AccessDeniedException"))
        with self.assertRaises(CloudError): bridge.close_expired({"id": row["id"]})
        self.assertEqual(registry.get(row["id"])["state"], "expired-unconfirmed")

    def test_the_route_is_served_on_the_socket_and_maps_refusals(self):
        import socket, serve
        bridge, registry, _, row = self.expired(items=({"microvmId": "mvm-orphan", "state": "RUNNING"},))
        with tempfile.TemporaryDirectory() as folder:
            server = serve.Server(str(Path(folder) / "runner.sock"), bridge)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .05}, daemon=True); thread.start()
            def post(body):
                conn = http.client.HTTPConnection("localhost", timeout=3)
                conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); conn.sock.connect(server.server_address)
                conn.request("POST", "/operation/close-expired", body=encode(body), headers={"Content-Type": "application/json"})
                response = conn.getresponse(); result = response.status, json.loads(response.read()); conn.close()
                return result
            try:
                self.assertEqual(post({"id": row["id"]}), (409, {"error": "an unregistered MicroVM of this image is still running",
                                                                  "reason": "an unregistered MicroVM of this image is still running"}))
                bridge.cloud.inventory = lambda image, version: {"items": []}
                self.assertEqual(post({"id": row["id"]}), (200, {"closed": True, "cleanupConfirmed": True}))
            finally:
                server.shutdown(); server.server_close(); thread.join(2)


class TokenMintRetryTests(unittest.TestCase):
    """With the CLI's error form classified, a throttled or internal-error token mint at the
    initial request is retryable. It is retried once after 0.25 s, before any byte reaches the guest, so the guest
    sees one request; a mint refused for any other reason is not retried."""

    def initial_request(self, mint_error):
        bridge, registry, cloud = limited_bridge(self)
        row = bridge._launch(bridge._admit("job", encode(JOB)))
        mints = []
        def token(vm_id, timeout=10):
            mints.append(vm_id)
            if len(mints) == 1: raise mint_error
            return "secret-jwe"
        cloud.token = token
        bridge.guest = GuestHttp(cloud, "ap-southeast-1")
        envelope = {"protocol": PROTOCOL, "instanceId": row["id"], "microvmId": row["vm_id"],
                    "sourceHash": row["source_hash"], "result": RESULT}
        class Response:
            status = 200
            def read(self, limit): return encode(envelope)
        slept = []
        with patch("cloud.http.client.HTTPSConnection") as connection, patch("bridge.time.sleep", side_effect=slept.append):
            connection.return_value.getresponse.return_value = Response()
            try:
                outcome = bridge._initial_request(row, "/execute", encode(JOB), time.monotonic() + 30, 30)
            except Unavailable as error:
                outcome = error
            sent = [call.args[:2] for call in connection.return_value.request.call_args_list]
        return outcome, mints, sent, slept, registry.get(row["id"])

    def test_a_throttled_or_internal_error_mint_is_retried_once_and_the_guest_sees_one_request(self):
        for provider, code in (("ThrottlingException", "cloud_throttled"), ("InternalServerException", "cloud_internal")):
            with self.subTest(code=code):
                outcome, mints, sent, slept, saved = self.initial_request(CloudError("create-microvm-auth-token", provider))
                self.assertEqual(outcome, RESULT)
                self.assertEqual(len(mints), 2)
                self.assertEqual(sent, [("POST", "/execute")], "the guest sees one request")
                self.assertEqual(slept, [.25])
                self.assertEqual((saved["initial_attempts"], saved["last_error_code"], saved["last_error_stage"]),
                                 (2, code, "initial-request"))

    def test_a_mint_refused_for_any_other_reason_is_not_retried(self):
        for provider, code in (("AccessDeniedException", "cloud_access_denied"), ("ValidationException", "cloud_validation")):
            with self.subTest(code=code):
                outcome, mints, sent, slept, saved = self.initial_request(CloudError("create-microvm-auth-token", provider))
                self.assertIsInstance(outcome, CloudError)
                self.assertEqual((outcome.code, len(mints), sent, slept, saved["initial_attempts"]), (code, 1, [], [], 1))


SHUTDOWN_PROBE = r"""
import os, signal, sys, threading, time
here, folder = sys.argv[1], sys.argv[2]
sys.path.insert(0, here)
import bridge, registry, serve
IMAGE = "arn:aws:lambda:ap-southeast-1:123456789012:microvm-image:test"
EGRESS = "arn:aws:lambda:ap-southeast-1:123456789012:network-connector:private"
INGRESS = "arn:aws:lambda:ap-southeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS"
path = os.path.join(folder, "state", "registry.sqlite")
store = registry.Registry(path)
for _ in range(2):
    row = store.create("preview", "0" * 64, 2, lambda operation, secret: {"maximumDurationInSeconds": 600})
    store.update(row["id"], state="running")
store.close()
serve.Config.from_env = classmethod(lambda cls: bridge.Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS,
                                                              job_limit=2, cleanup_limit=2))
real = threading.Thread
class Thread(real):
    def start(self):
        # Only the shutdown sweep's second worker (on the main thread) is refused, as at the unit's task limit.
        if getattr(self, "_target", None) is not None and self._target.__name__ == "worker" \
                and threading.current_thread() is threading.main_thread() and getattr(Thread, "started", 0) >= 1:
            print("worker-start-refused", flush=True)
            raise RuntimeError("can't start new thread")
        if getattr(self, "_target", None) is not None and self._target.__name__ == "worker":
            Thread.started = getattr(Thread, "started", 0) + 1
        return real.start(self)
bridge.threading.Thread = Thread
def stop():
    time.sleep(1.0)
    os.kill(os.getpid(), signal.SIGTERM)
real(target=stop, daemon=True).start()
sys.argv = ["serve.py", "--socket", os.path.join(folder, "runner.sock"), "--registry", path, "--aws-bin", "/bin/echo"]
code = serve.run()
print("exit", code, flush=True)
raise SystemExit(code)
"""

if __name__ == "__main__": unittest.main()
