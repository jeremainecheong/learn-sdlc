"""Failure recovery contracts; fake cloud transport, real registry and guest latch."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from bridge import Bridge, Config
from cloud import AwsCli, CloudError, GuestError, GuestHttp, Unavailable, cloud_error, encode, PROTOCOL
from registry import Registry
from serve import failure_diagnostic
from test_bridge import Cloud, Guest, IMAGE, EGRESS, INGRESS, JOB, PREVIEW, RESULT

spec = importlib.util.spec_from_file_location("recovery_gateway", Path(__file__).parents[1] / "guest/gateway.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "registry.sqlite"
        self.registry = Registry(self.path)
        self.cloud, self.guest = Cloud(), Guest()
        # Explicit limits (a job limit of 2, a cleanup limit of 1), so these cases keep proving that configuration
        # whatever the code defaults are.
        self.bridge = Bridge(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, boot_seconds=1, job_limit=2, cleanup_limit=1),
                             self.registry, self.cloud, self.guest)

    def tearDown(self):
        for _ in range(100):
            if not self.bridge.active and not self.bridge.cleanup_slots.busy(): break
            time.sleep(.005)
        self.registry.close()
        self.temp.cleanup()

    def cleanup_row(self):
        row = self.bridge._admit("job", encode(JOB))
        row = self.bridge._launch(row)
        self.registry.update(row["id"], cleanup=1, state="cleanup", expires=100)
        self.bridge._released(row["id"])
        return row

    def not_found(self, row):
        return CloudError("get-microvm", "ResourceNotFoundException", row["vm_id"])

    def test_known_vm_disappears_after_lifetime_two_observations_release_slot(self):
        row = self.cleanup_row()
        with patch.object(self.cloud, "get", side_effect=self.not_found(row)), patch("bridge.time.time", return_value=101):
            self.bridge.cleanup_one(row["id"])
        self.assertEqual(self.registry.stats()["job"], 1)
        self.assertEqual(self.registry.get(row["id"])["missing_count"], 1)
        # The first observation survives a real controller registry restart.
        self.registry.close()
        self.registry = Registry(self.path)
        self.bridge.registry = self.registry
        with patch.object(self.cloud, "get", side_effect=self.not_found(row)), patch("bridge.time.time", return_value=106):
            self.bridge.cleanup_one(row["id"])
        final = self.registry.get(row["id"])
        self.assertEqual(final["state"], "terminated")
        self.assertEqual(final["cleanup_outcome"], "absent-after-expiry")
        self.assertEqual(final["cleanup_attempts"], 2)
        self.assertEqual(self.registry.stats()["job"], 0)
        self.assertEqual(len(self.cloud.creates), 1)
        self.assertFalse(any(route == "/execute" for route, *_ in self.guest.calls))

    def test_early_or_unspaced_not_found_never_releases_slot(self):
        row = self.cleanup_row()
        for now in (1, 5, 99, 100, 100, 104):
            with patch.object(self.cloud, "get", side_effect=self.not_found(row)), patch("bridge.time.time", return_value=now):
                self.bridge.cleanup_one(row["id"])
            self.assertEqual(self.registry.stats()["job"], 1)
        self.assertEqual(self.registry.get(row["id"])["missing_since"], 100)

    def test_denied_throttled_unknown_and_wrong_identity_reset_absence_evidence(self):
        row = self.cleanup_row()
        errors = [CloudError("get-microvm", "AccessDeniedException", row["vm_id"]),
                  CloudError("get-microvm", "ThrottlingException", row["vm_id"]),
                  CloudError("terminate-microvm", "ResourceNotFoundException", row["vm_id"]),
                  CloudError("get-microvm", "ResourceNotFoundException", "mvm-other"),
                  Unavailable("private-provider-canary")]
        for error in errors:
            self.registry.update(row["id"], missing_count=1, missing_since=100)
            with patch.object(self.cloud, "get", side_effect=error), patch("bridge.time.time", return_value=200):
                self.bridge.cleanup_one(row["id"])
            after = self.registry.get(row["id"])
            self.assertEqual(after["state"], "cleanup")
            self.assertEqual(after["missing_count"], 0)
            self.assertIsNone(after["missing_since"])
            self.assertNotIn("canary", json.dumps(after))

    def test_cleanup_diagnostic_retains_original_execution_failure(self):
        row = self.cleanup_row()
        self.bridge._diagnostic(row["id"], "initial-request", Unavailable("canary", code="guest_transport"))
        with patch.object(self.cloud, "get", side_effect=CloudError("get-microvm", "AccessDeniedException", row["vm_id"])):
            self.bridge.cleanup_one(row["id"])
        saved = self.registry.get(row["id"])
        self.assertEqual(saved["last_error_code"], "guest_transport")
        self.assertEqual(saved["last_error_stage"], "initial-request")
        self.assertEqual(saved["cleanup_error_code"], "cloud_access_denied")

    def test_lost_guest_response_reconciles_real_latch_without_second_execution(self):
        class Runner:
            count = 0
            def request(self, method, route, raw=b""):
                self.count += 1
                return 200, RESULT
        runner = Runner()
        real_guest = gateway.Guest(runner)
        calls = []
        def request(row, route, raw=None, timeout=30):
            if route == "/health":
                real_guest.bootstrap({"microvmId": row["vm_id"], "runHookPayload": json.loads(row["launch_json"])["runHookPayload"]})
                return {"ok": True, "purpose": "job"}
            real_guest.authorize("Bearer " + row["control_token"], row["id"])
            calls.append((row["id"], row["vm_id"], raw))
            status, envelope = real_guest.invoke(route, raw)
            if len(calls) == 1:
                raise Unavailable("connection reset after execution", code="guest_transport", retryable=True)
            self.assertEqual(status, 200)
            return envelope["result"]
        self.guest.request = request
        self.assertEqual(self.bridge.execute(JOB), RESULT)
        self.assertEqual(runner.count, 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(len(self.cloud.creates), 1)
        saved = self.registry.get(calls[0][0])
        self.assertEqual(saved["initial_attempts"], 2)
        self.assertEqual(saved["last_error_code"], "guest_transport")

    def test_bound_failure_identity_error_and_invalid_results_are_not_replayed(self):
        for error in (GuestError(502, authenticated=True), GuestError(403),
                      Unavailable("wrong instance", code="guest_identity"),
                      Unavailable("bad result", code="guest_response")):
            row = self.bridge._admit("job", encode(JOB))
            try:
                with patch.object(self.guest, "request", side_effect=error) as request:
                    with self.assertRaises(type(error)):
                        self.bridge._initial_request(row, "/execute", encode(JOB), time.monotonic() + 1, 1)
                    self.assertEqual(request.call_count, 1)
            finally:
                self.registry.update(row["id"], cleanup=1, state="terminated")
                self.bridge._released(row["id"])

    def test_proxy_failure_retries_once_with_original_deadline_and_bytes(self):
        row = self.bridge._admit("job", encode(JOB))
        clock = [10.0]
        calls = []
        def request(*args, **kwargs):
            calls.append((args, kwargs))
            clock[0] += .4
            raise GuestError(502)
        try:
            with patch.object(self.guest, "request", side_effect=request), patch("bridge.time.monotonic", side_effect=lambda: clock[0]), patch("bridge.time.sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
                with self.assertRaises(GuestError):
                    self.bridge._initial_request(row, "/execute", encode(JOB), 11, 2)
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][0], calls[1][0])
            self.assertAlmostEqual(calls[0][1]["timeout"], 1)
            self.assertAlmostEqual(calls[1][1]["timeout"], .35)
        finally:
            self.registry.update(row["id"], cleanup=1, state="terminated")
            self.bridge._released(row["id"])


class TransportRecoveryTests(unittest.TestCase):
    def test_waiting_for_another_vm_token_respects_own_deadline_without_network(self):
        cloud = Cloud()
        guest = GuestHttp(cloud, "ap-southeast-1")
        row = {"vm_id": "mvm-one", "endpoint": "guest.lambda-microvm.ap-southeast-1.on.aws"}
        done = threading.Event()
        errors = []
        def call():
            try: guest.request(row, "/health", timeout=.02)
            except Unavailable as error: errors.append(error.code)
            finally: done.set()
        guest.lock.acquire()
        thread = threading.Thread(target=call)
        try:
            with patch.object(cloud, "token") as token, patch("cloud.http.client.HTTPSConnection") as connection:
                thread.start()
                self.assertTrue(done.wait(.5), "a held cache lock ignored the caller deadline")
                self.assertEqual(errors, ["guest_deadline"])
                token.assert_not_called()
                connection.assert_not_called()
        finally:
            guest.lock.release()
            thread.join(1)

    def test_fixed_cli_header_classification_ignores_prose_and_operation_mismatch(self):
        payload = {"microvmIdentifier": "mvm-one"}
        raw = b"\nAn error occurred (ResourceNotFoundException) when calling the GetMicrovm operation: credential-canary"
        error = cloud_error(raw, "get-microvm", payload)
        self.assertEqual(error.code, "cloud_not_found")
        self.assertEqual(error.resource_id, "mvm-one")
        self.assertNotIn("credential-canary", str(error))
        for other in (b"log: " + raw, raw.replace(b"GetMicrovm", b"RunMicrovm"), b"ResourceNotFoundException inside untrusted text"):
            self.assertEqual(cloud_error(other, "get-microvm", payload).code, "unavailable")

    def test_cli_error_has_bounded_private_capture_and_safe_category(self):
        with tempfile.TemporaryDirectory() as folder:
            cli = AwsCli("/usr/local/bin/aws", "ap-southeast-1", folder)
            def start(command, **options):
                options["stderr"].write(b"An error occurred (AccessDeniedException) when calling the GetMicrovm operation: secret-canary")
                return Mock(returncode=255)
            with patch("cloud.subprocess.Popen", side_effect=start):
                with self.assertRaises(CloudError) as caught: cli.get("mvm-one")
            self.assertEqual(caught.exception.code, "cloud_access_denied")
            self.assertNotIn("secret-canary", str(caught.exception))
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_successful_empty_termination_is_accepted_but_other_empty_responses_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            cli = AwsCli("/usr/local/bin/aws", "ap-southeast-1", folder)
            with patch("cloud.subprocess.Popen", return_value=Mock(returncode=0)):
                self.assertEqual(cli.terminate("mvm-one"), {})
                for operation in ("get-microvm", "run-microvm", "list-microvms", "create-microvm-auth-token"):
                    with self.subTest(operation=operation), self.assertRaises(Unavailable) as caught:
                        cli.call(operation, {"microvmIdentifier": "mvm-one"})
                    self.assertEqual(caught.exception.code, "cloud_response")
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_empty_failed_termination_or_malformed_success_never_becomes_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            cli = AwsCli("/usr/local/bin/aws", "ap-southeast-1", folder)
            with patch("cloud.subprocess.Popen", return_value=Mock(returncode=255)):
                with self.assertRaises(CloudError): cli.terminate("mvm-one")
            def malformed(command, **options):
                options["stdout"].write(b"not JSON")
                return Mock(returncode=0)
            with patch("cloud.subprocess.Popen", side_effect=malformed):
                with self.assertRaises(Unavailable) as caught: cli.terminate("mvm-one")
            self.assertEqual(caught.exception.code, "cloud_response")

    def test_only_unbound_proxy_failures_are_retryable(self):
        row = {"id": "operation", "vm_id": "mvm-one", "endpoint": "guest.lambda-microvm.ap-southeast-1.on.aws", "control_token": "secret", "source_hash": "hash"}
        bound = {"protocol": PROTOCOL, "instanceId": "operation", "microvmId": "mvm-one", "sourceHash": "hash", "result": {"error": "private-canary"}}
        for body, expected in ((b"bad gateway", True), (encode(bound), False)):
            response = Mock(status=502)
            response.read.return_value = body
            with patch("cloud.http.client.HTTPSConnection") as connection:
                connection.return_value.getresponse.return_value = response
                with self.assertRaises(GuestError) as caught: GuestHttp(Cloud(), "ap-southeast-1").request(row, "/execute", encode(JOB))
            self.assertEqual(caught.exception.retryable, expected)
            self.assertNotIn("private-canary", str(caught.exception))

    def test_owner_diagnostic_never_formats_untrusted_values(self):
        error = Unavailable("secret-canary", code="secret-canary")
        error.operation_id, error.stage = "secret-canary", "secret-canary"
        self.assertEqual(failure_diagnostic(error), {"diagnosticCode": "unavailable"})


if __name__ == "__main__": unittest.main()
