import hashlib
import http.client
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from gate import COOKIE, ConfigurationError, Gate, GateServer, b64, safe_path


class GateFixture:
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.file = Path(self.directory.name) / "gate.json"
        self.now = 2000000000
        self.token = b64(b"test-only-invitation-32-byte-value")
        self.digest = hashlib.sha256(self.token.encode()).hexdigest()
        self.data = {"signing_key": b64(b"test-only-signing-key-32-byte-value"),
                     "invites": [{"token_sha256": self.digest, "expires_at": self.now + 5000, "revoked": False}]}
        self.write()
        self.gate = Gate(self.file, "preview.example", cookie_ttl=3600, clock=lambda: self.now)

    def tearDown(self):
        self.directory.cleanup()

    def write(self):
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data))
        tmp.replace(self.file)

    def cookie(self):
        return self.gate.exchange(self.token).split(";", 1)[0]


class GateTest(GateFixture, unittest.TestCase):
    def test_exchange_has_host_cookie_security_and_shorter_expiry(self):
        cookie = self.gate.exchange(self.token)
        for field in [COOKIE + "=", "Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=3600"]:
            self.assertIn(field, cookie)
        self.assertNotIn("Domain=", cookie)
        self.assertNotIn(self.token, cookie)
        self.assertTrue(self.gate.authorized([cookie.split(";", 1)[0]]))

    def test_tampered_missing_duplicate_and_future_cookies_fail(self):
        cookie = self.cookie()
        self.assertFalse(self.gate.authorized([]))
        self.assertFalse(self.gate.authorized([cookie + "x"]))
        self.assertFalse(self.gate.authorized([cookie, cookie]))
        self.assertFalse(self.gate.authorized([COOKIE + "=bad.bad"]))
        self.now -= 1
        self.assertFalse(self.gate.authorized([cookie]))

    def test_expiration_is_enforced_without_server_restart(self):
        cookie = self.cookie()
        self.now += 3600
        self.assertFalse(self.gate.authorized([cookie]))

    def test_revocation_rotation_and_removal_are_immediate_after_atomic_replace(self):
        cookie = self.cookie()
        self.data["invites"][0]["revoked"] = True
        self.write()
        self.assertFalse(self.gate.authorized([cookie]))
        self.assertIsNone(self.gate.exchange(self.token))
        self.data["invites"][0]["revoked"] = False
        self.data["signing_key"] = b64(b"different-signing-key-32-byte-value")
        self.write()
        self.assertFalse(self.gate.authorized([cookie]))
        cookie = self.cookie()
        self.data["invites"] = []
        self.write()
        self.assertFalse(self.gate.authorized([cookie]))

    def test_cookie_cannot_outlive_shortened_invitation(self):
        cookie = self.cookie()
        self.data["invites"][0]["expires_at"] = self.now + 60
        self.write()
        self.assertFalse(self.gate.authorized([cookie]))
        self.assertIn("Max-Age=60", self.gate.exchange(self.token))

    def test_invalid_codes_and_config_fail_closed(self):
        for value in [None, "short", self.token + "?next=//evil", "a" * 43]:
            self.assertIsNone(self.gate.exchange(value))
        self.data["invites"].append(self.data["invites"][0].copy())
        self.write()
        with self.assertRaises(ConfigurationError):
            self.gate.authorized([self.cookie()])
        self.file.write_text("invalid JSON")
        with self.assertRaises(ConfigurationError):
            self.gate.config()

    def test_unsafe_path_encodings_never_reach_capability_match(self):
        cap = "A" * 32
        prefix = f"/api/v1/preview/{cap}"
        for value in ["//api/v1/preview/" + cap, prefix + "/../auth/me", prefix + "/%2e%2e/auth/me",
                      prefix + "/%2f..%2fauth", prefix + "/%252e%252e/auth", prefix + "/a\\b",
                      prefix + "/a%5cb", prefix + "/a%00b", prefix + "/%zz", prefix + "//api",
                      "/api/v1/preview/" + cap + "/%2e", "/\napi", "https://elsewhere/"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                safe_path(value)
        self.assertEqual(safe_path(prefix + "/api/tasks?next=%2f.."), prefix + "/api/tasks")


class HttpTest(GateFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.server = GateServer(("127.0.0.1", 0), self.gate, timeout=0.7)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        super().tearDown()

    def request(self, path, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_url_exchange_redirect_clears_token_and_has_no_referrer_or_cache(self):
        status, headers, body = self.request("/_preview/access/" + self.token)
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertIn("noindex", headers["X-Robots-Tag"])
        self.assertNotIn(self.token.encode(), body)
        self.assertIn(COOKIE, headers["Set-Cookie"])

    def test_form_post_requires_same_origin_and_supports_code(self):
        headers = {"Origin": "https://preview.example", "Content-Type": "application/x-www-form-urlencoded"}
        self.assertEqual(self.request("/_preview/access", "POST", headers, "code=" + self.token)[0], 303)
        headers["Origin"] = "https://attacker.example"
        self.assertEqual(self.request("/_preview/access", "POST", headers, "code=" + self.token)[0], 403)

    def test_only_canonical_preview_capability_bypasses_cookie_including_preflight(self):
        cap = "A" * 32
        for method in ["GET", "OPTIONS", "POST"]:
            for path in [f"/api/v1/preview/{cap}", f"/api/v1/preview/{cap}/api/tasks"]:
                status, _, _ = self.request("/check", headers={"X-Forwarded-Uri": path, "X-Forwarded-Method": method, "Origin": "null"})
                self.assertEqual(status, 204)
        for path in ["/", "/api/v1/auth/me", "/socket.io/?EIO=4", "/api/v1/preview", "/api/v1/preview/short", "/%61pi/v1/preview/" + cap]:
            status, _, body = self.request("/check", headers={"X-Forwarded-Uri": path, "Authorization": "Bearer test-only"})
            self.assertEqual(status, 403)
            self.assertIn(b"Private preview", body)

    def test_valid_cookie_allows_protected_route_and_invalid_config_returns_unavailable(self):
        headers = {"X-Forwarded-Uri": "/api/v1/auth/me", "Cookie": self.cookie()}
        self.assertEqual(self.request("/check", headers=headers)[0], 204)
        self.file.write_text("bad JSON")
        self.assertEqual(self.request("/check", headers=headers)[0], 503)

    def test_invalid_redirect_query_body_limit_and_plaintext_are_not_reflected(self):
        self.assertEqual(self.request("/_preview/access/" + self.token + "?next=https://evil.example")[0], 400)
        status, headers, body = self.request("/_preview/access/invalid-token")
        self.assertEqual(status, 403)
        self.assertNotIn(b"invalid-token", body)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        headers = {"Origin": "https://preview.example", "Content-Type": "application/x-www-form-urlencoded"}
        self.assertEqual(self.request("/_preview/access", "POST", headers, "code=" + "a" * 2000)[0], 413)

    def test_absolute_request_deadline_closes_dripped_body(self):
        client = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2)
        client.sendall(b"POST /_preview/access HTTP/1.1\r\nHost: preview.example\r\nOrigin: https://preview.example\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 200\r\n\r\ncode=")
        start = time.monotonic()
        time.sleep(0.4)
        client.sendall(b"a")
        data = client.recv(1024)
        self.assertEqual(data, b"")
        self.assertLess(time.monotonic() - start, 1.5)
        client.close()


if __name__ == "__main__":
    unittest.main()
