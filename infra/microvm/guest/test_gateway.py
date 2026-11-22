"""Contract/security tests use a fake runner; container smoke runs real code."""

import concurrent.futures
import hashlib
import http.client
import importlib.util
import json
import threading
import time
import unittest
import uuid
from pathlib import Path

from gateway import Guest, GuestError, HOOK_PREFIX, PROTOCOL, Server, decode_object


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.failure = False
        self.delay = 0

    def request(self, method, path, raw=b""):
        self.calls.append((method, path, raw))
        if self.failure:
            raise GuestError(503, "runner unavailable")
        if path == "/health":
            return 200, {"ok": True, "uid": 65534, "pool": {"slots": 1}}
        time.sleep(self.delay)
        if path == "/app/start":
            return 200, {"id": "private-app-id", "status": "starting"}
        return 200, {"ok": True, "path": path}


class GuestTests(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        self.guest = Guest(self.runner)
        self.raw = b'{"files":{"main.py":"print(42)"},"mode":"script"}'
        self.config = {"protocol": PROTOCOL, "controlToken": "a" * 64,
                       "instanceId": str(uuid.uuid4()), "purpose": "job",
                       "sourceHash": hashlib.sha256(self.raw).hexdigest()}
        self.body = {"microvmId": "mvm-test-instance", "runHookPayload": json.dumps(self.config)}

    def boot(self, purpose="job"):
        self.config["purpose"] = purpose
        self.body["runHookPayload"] = json.dumps(self.config)
        self.guest.bootstrap(self.body)

    def assert_guest_error(self, expected, call):
        with self.assertRaises(GuestError) as caught:
            call()
        self.assertEqual(caught.exception.status, expected)

    def test_cannot_authorize_before_bootstrap(self):
        self.assert_guest_error(403, lambda: self.guest.authorize("Bearer " + "a" * 64, self.config["instanceId"]))

    def test_bootstrap_is_immutable_and_retry_is_idempotent(self):
        self.boot()
        self.assertEqual(self.guest.bootstrap(self.body), {"ok": True})
        alternate = {**self.config, "controlToken": "b" * 64}
        self.assert_guest_error(409, lambda: self.guest.bootstrap({**self.body, "runHookPayload": json.dumps(alternate)}))
        self.guest.authorize("Bearer " + self.config["controlToken"], self.config["instanceId"])

    def test_invalid_bootstrap_does_not_bind_operation(self):
        for key, value in [("protocol", "other"), ("controlToken", "short"), ("sourceHash", ""),
                           ("instanceId", "../bad"), ("purpose", "shell")]:
            with self.subTest(key=key):
                config = {**self.config, key: value}
                self.assert_guest_error(400, lambda: self.guest.bootstrap({**self.body, "runHookPayload": json.dumps(config)}))
                self.assertIsNone(self.guest.identity)

    def test_malformed_bootstrap_encoding_is_rejected(self):
        self.assert_guest_error(400, lambda: self.guest.bootstrap({**self.body, "runHookPayload": "\ud800"}))

    def test_auth_requires_exact_token_and_instance_without_leaking(self):
        self.boot()
        for token, instance in [(None, None), ("Bearer " + "b" * 64, self.config["instanceId"]),
                                ("Bearer " + "a" * 64, str(uuid.uuid4())), ("Bearer café", None)]:
            self.assert_guest_error(403, lambda: self.guest.authorize(token, instance))

    def test_changed_source_and_wrong_kind_never_reach_runner(self):
        self.boot()
        self.assert_guest_error(409, lambda: self.guest.invoke("/execute", self.raw + b" "))
        self.assert_guest_error(409, lambda: self.guest.invoke("/app/start", self.raw))
        self.assertEqual(self.runner.calls, [])

    def test_concurrent_duplicate_initial_requests_execute_once(self):
        self.boot()
        self.runner.delay = 0.1
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(lambda _: self.guest.invoke("/execute", self.raw), range(6)))
        self.assertEqual(len(self.runner.calls), 1)
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(results[0][1]["sourceHash"], self.config["sourceHash"])
        self.assertNotIn("controlToken", json.dumps(results))

    def test_ambiguous_transport_failure_cannot_reexecute(self):
        self.boot()
        self.runner.failure = True
        first = self.guest.invoke("/execute", self.raw)
        self.runner.failure = False
        self.assertEqual(self.guest.invoke("/execute", self.raw), first)
        self.assertEqual(first[0], 503)
        self.assertEqual(len(self.runner.calls), 1)

    def test_preview_only_routes_to_its_own_returned_session(self):
        self.boot("preview")
        self.guest.invoke("/app/start", self.raw)
        self.assert_guest_error(404, lambda: self.guest.invoke("/app/status", b'{"id":"another-id"}'))
        code, response = self.guest.invoke("/app/status", b'{"id":"private-app-id"}')
        self.assertEqual(code, 200)
        self.assertEqual(response["result"]["path"], "/app/status")

    def test_parser_rejects_duplicate_keys_nonfinite_and_nonobject(self):
        for value in [b'{"mode":"tests","mode":"script"}', b'{"x":NaN}', b'[]', b'null', b'\xff']:
            self.assert_guest_error(400, lambda: decode_object(value))

    def test_unknown_route_has_no_runner_effect(self):
        self.boot()
        self.assert_guest_error(404, lambda: self.guest.invoke("/shell", b"{}"))
        self.assertEqual(self.runner.calls, [])


class HttpTests(unittest.TestCase):
    boot = GuestTests.boot

    def setUp(self):
        GuestTests.setUp(self)
        self.server = Server(("127.0.0.1", 0), self.guest)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, raw=b"{}", authorized=True):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers.update({"Authorization": "Bearer " + self.config["controlToken"],
                            "X-LearnSDLC-Instance": self.config["instanceId"]})
        connection.request(method, path, body=raw, headers=headers)
        result = connection.getresponse()
        answer = (result.status, json.loads(result.read()))
        self.assertEqual(result.getheader("Cache-Control"), "no-store")
        connection.close()
        return answer

    def test_real_http_control_auth_and_response_binding(self):
        code, _ = self.request("POST", HOOK_PREFIX + "run", json.dumps(self.body).encode(), False)
        self.assertEqual(code, 200)
        code, response = self.request("GET", "/health", authorized=False)
        self.assertEqual(code, 403)
        self.assertNotIn("instanceId", response)
        code, response = self.request("POST", "/execute", self.raw)
        self.assertEqual(code, 200)
        self.assertEqual(response["instanceId"], self.config["instanceId"])
        self.assertEqual(response["microvmId"], self.body["microvmId"])

    def test_lifecycle_calls_cannot_stop_or_reset_learner_operation(self):
        self.boot()
        for hook in ("ready", "validate", "resume", "suspend", "terminate"):
            self.assertEqual(self.request("POST", HOOK_PREFIX + hook, authorized=False)[0], 200)
        self.assertFalse(self.guest.started)
        self.assertTrue(all(call[1] == "/health" for call in self.runner.calls))
        self.assertEqual(self.request("POST", "/execute", self.raw)[0], 200)

    def test_wrong_hash_http_error_is_bound_to_operation(self):
        self.boot()
        code, result = self.request("POST", "/execute", b"{}")
        self.assertEqual(code, 409)
        self.assertEqual(result["instanceId"], self.config["instanceId"])
        self.assertIn("error", result["result"])

    def test_bodyless_lifecycle_hook_without_content_length(self):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.putrequest("POST", HOOK_PREFIX + "ready")
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read()), {"ok": True})
        connection.close()


if __name__ == "__main__":
    unittest.main()
