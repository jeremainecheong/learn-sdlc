"""Offline trust-boundary tests. No AWS calls, user pool, email or network."""
import copy
import contextlib
import hashlib
import hmac
import io
import importlib.util
import json
import os
from pathlib import Path
import signal
import ssl
import tempfile
import time
import traceback
import types
import unittest
from unittest.mock import Mock, patch
import zipfile

import migration
import package


KEY = bytes.fromhex("ab" * 32)
REGION = "ap-southeast-1"
POOL = REGION + "_Fixture123"
EMAIL = "learner@example.test"
USER_ID = "3460284c-0082-4b42-a94a-a21151231dda"
ENV = {
    "EXPECTED_REGION": REGION, "EXPECTED_ACCOUNT_ID": "123456789012",
    "MIGRATION_SECRET_ARN": "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:fixture-AbCdEf",
    "MIGRATION_ENDPOINT": "https://preview.example.test/api/v1/auth/cognito/migrate",
}


def event(trigger=migration.MIGRATE_AUTH):
    return {"version": "1", "region": REGION, "userPoolId": POOL,
            "userName": EMAIL, "triggerSource": trigger, "callerContext": {"clientId": "fixtureclient"},
            "request": {"password": "existing password ñ"} if trigger == migration.MIGRATE_AUTH else {},
            "response": {}}


def native(timestamp="1800000000", email=EMAIL, pool=POOL):
    value = event(migration.SIGNUP_NATIVE)
    nonce = "cd" * 16
    signature = hmac.new(KEY, f"signup.{timestamp}.{nonce}.{email}.{pool}".encode(), hashlib.sha256).hexdigest()
    value["request"] = {"userAttributes": {"email": email, "name": "Learner"}, "clientMetadata": {
        "signupTimestamp": timestamp, "signupNonce": nonce, "signupSignature": signature,
    }}
    return value


class FakeResponse:
    def __init__(self, raw=None, status=200, headers=None):
        self.status = status
        self.raw = raw if raw is not None else json.dumps({
            "id": USER_ID, "email": EMAIL, "emailVerified": True, "displayName": "Ada Learner",
        }).encode()
        self.headers = {"Content-Type": "application/json; charset=utf-8", **(headers or {})}

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, limit):
        return self.raw[:limit]


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, ENV, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.key = patch.object(migration, "_migration_key", return_value=KEY)
        self.key_mock = self.key.start()
        self.addCleanup(self.key.stop)
        self.connection = Mock()
        self.connection.getresponse.return_value = FakeResponse()
        self.transport = patch.object(migration.http.client, "HTTPSConnection", return_value=self.connection)
        self.https = self.transport.start()
        self.addCleanup(self.transport.stop)
        self.context = Mock(get_remaining_time_in_millis=Mock(return_value=5000))

    def invoke(self, value=None):
        return migration.handler(event() if value is None else value, self.context)

    def rejected(self, value=None):
        with self.assertRaisesRegex(migration.MigrationRejected, "^" + migration.FAILURE.replace(".", r"\.") + "$"):
            self.invoke(value)

    def test_authentication_signs_the_exact_utf8_body_and_preserves_identity(self):
        value = event()
        value["userName"] = "Learner@Example.Test"
        value["request"]["clientMetadata"] = {"role": "admin", "url": "https://other.invalid"}
        with patch.object(migration.time, "time", return_value=1800000000), patch.object(migration.secrets, "token_hex", return_value="cd" * 16):
            answer = self.invoke(value)
        args, kwargs = self.connection.request.call_args
        self.assertEqual(args, ("POST", "/api/v1/auth/cognito/migrate"))
        raw = kwargs["body"]
        self.assertEqual(raw, json.dumps({"email": EMAIL, "password": value["request"]["password"],
                         "poolId": POOL, "trigger": migration.MIGRATE_AUTH}, sort_keys=True,
                         separators=(",", ":"), ensure_ascii=False).encode())
        headers = kwargs["headers"]
        signed = (headers["X-Cognito-Migration-Timestamp"] + "." + headers["X-Cognito-Migration-Nonce"] + ".").encode() + raw
        self.assertEqual(headers["X-Cognito-Migration-Signature"], hmac.new(KEY, signed, hashlib.sha256).hexdigest())
        self.assertEqual(answer["response"], {"userAttributes": {"email": EMAIL, "email_verified": "true",
                         "name": "Ada Learner", "custom:learnsdlc_id": USER_ID}, "finalUserStatus": "CONFIRMED",
                         "messageAction": "SUPPRESS", "desiredDeliveryMediums": ["EMAIL"], "forceAliasCreation": False})
        self.assertEqual(self.https.call_args.args, ("preview.example.test",))
        tls = self.https.call_args.kwargs["context"]
        self.assertTrue(tls.check_hostname)
        self.assertEqual(tls.verify_mode, ssl.CERT_REQUIRED)
        self.connection.close.assert_called_once()
        self.assertEqual(value["response"], {})

    def test_existing_unverified_password_account_stays_unverified(self):
        user = json.loads(FakeResponse().raw)
        user["emailVerified"] = False
        self.connection.getresponse.return_value = FakeResponse(json.dumps(user).encode())
        answer = self.invoke()["response"]
        self.assertEqual(answer["userAttributes"]["email_verified"], "false")
        self.assertEqual(answer["finalUserStatus"], "CONFIRMED")

    def test_forgot_password_requires_verified_record_and_sends_null_password(self):
        answer = self.invoke(event(migration.MIGRATE_FORGOT))["response"]
        self.assertEqual(json.loads(self.connection.request.call_args.kwargs["body"])["password"], None)
        self.assertEqual(answer["finalUserStatus"], "RESET_REQUIRED")
        self.assertEqual(answer["messageAction"], "SUPPRESS")
        user = json.loads(FakeResponse().raw)
        user["emailVerified"] = False
        self.connection.getresponse.return_value = FakeResponse(json.dumps(user).encode())
        self.rejected(event(migration.MIGRATE_FORGOT))

    def test_unexpected_triggers_wrong_pool_region_and_bad_events_never_read_key(self):
        bad_events = [None, [], {}, {**event(), "version": 1}, {**event(), "triggerSource": "PostAuthentication_Authentication"},
                      {**event(), "region": "us-east-1"}, {**event(), "userPoolId": "us-east-1_Other"},
                      {**event(), "request": []}, {**event(), "userName": "learner@example.test\r\n"}]
        for value in bad_events:
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(migration.MigrationRejected):
                    migration.handler(value, self.context)
        self.key_mock.assert_not_called()
        self.https.assert_not_called()

    def test_invalid_or_oversized_password_and_body_never_call_transport(self):
        for password in [None, "", 1, [], "a" * 1025, "\U0001f600" * 1024, "\ud800"]:
            value = event()
            value["request"]["password"] = password
            self.rejected(value)
        value = event(migration.MIGRATE_FORGOT)
        value["request"]["password"] = "not allowed"
        self.rejected(value)
        self.https.assert_not_called()

    def test_response_identity_and_types_are_checked_not_just_http_success(self):
        valid = json.loads(FakeResponse().raw)
        invalid = [[], None, {}, {**valid, "id": "not-a-uuid"}, {**valid, "id": 7},
                   {**valid, "email": "other@example.test"}, {**valid, "emailVerified": "true"},
                   {**valid, "emailVerified": 1}, {**valid, "displayName": "bad\nname"},
                   {**valid, "displayName": " "}, {**valid, "role": "admin"}]
        for user in invalid:
            with self.subTest(user_type=type(user).__name__):
                self.connection.getresponse.return_value = FakeResponse(json.dumps(user).encode())
                self.rejected()

    def test_malformed_duplicate_oversized_and_nonfinite_json_fail_closed(self):
        for raw in [b"not JSON", b"\xff", b'{"id":"a","id":"b"}', b'{"id":NaN}', b" " * 4097]:
            self.connection.getresponse.return_value = FakeResponse(raw)
            self.rejected()

    def test_redirect_errors_wrong_media_type_and_compression_never_become_success(self):
        variants = [FakeResponse(status=status) for status in [204, 301, 302, 401, 403, 429, 500]]
        variants += [FakeResponse(headers=headers) for headers in [
            {"Content-Type": "text/html"}, {"Content-Encoding": "gzip"},
            {"Content-Length": "4097"}, {"Content-Length": "-1"},
        ]]
        for response in variants:
            self.connection.getresponse.return_value = response
            self.rejected()
        self.assertEqual(self.connection.request.call_count, len(variants))

    def test_transport_and_secret_errors_do_not_leak_values_or_get_retried(self):
        marker = "private-secret-not-for-logs"
        self.connection.getresponse.side_effect = TimeoutError(marker)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            try:
                self.invoke()
            except migration.MigrationRejected:
                detail = traceback.format_exc()
        self.assertNotIn(marker, detail)
        self.assertNotIn(marker, stdout.getvalue() + stderr.getvalue())
        self.connection.request.assert_called_once()
        self.connection.close.assert_called_once()
        self.key_mock.side_effect = RuntimeError(marker)
        self.rejected()
        self.connection.request.assert_called_once()

    def test_failure_diagnostics_use_only_fixed_stage_and_cause(self):
        marker = "private-password-signature-token@example.test"
        self.key_mock.side_effect = TimeoutError(marker)
        with self.assertLogs(migration._logger, level="ERROR") as logs:
            self.rejected(native())
        self.assertEqual(logs.output, ["ERROR:migration:migration_rejected stage=secret_lookup cause=unavailable"])
        self.assertNotIn(marker, "\n".join(logs.output))
        self.key_mock.side_effect = migration._DeadlineExceeded(marker)
        with self.assertLogs(migration._logger, level="ERROR") as logs:
            self.rejected(native())
        self.assertEqual(logs.output, ["ERROR:migration:migration_rejected stage=secret_lookup cause=deadline"])
        self.key_mock.side_effect = migration._SecretSetupUnavailable(marker)
        with self.assertLogs(migration._logger, level="ERROR") as logs:
            self.rejected(native())
        self.assertEqual(logs.output, ["ERROR:migration:migration_rejected stage=secret_setup cause=unavailable"])
        self.key_mock.side_effect = None
        with self.assertLogs(migration._logger, level="ERROR") as logs, \
                patch.object(migration.time, "time", return_value=1800000000):
            self.rejected(event(migration.SIGNUP_NATIVE))
        self.assertEqual(logs.output, ["ERROR:migration:migration_rejected stage=signup_proof cause=rejected"])
        self.https.assert_not_called()

    def test_untrusted_endpoint_secret_region_and_account_fail_before_network(self):
        endpoints = ["http://preview.example.test/api/v1/auth/cognito/migrate",
                     "https://name:password@preview.example.test/api/v1/auth/cognito/migrate",
                     "https://preview.example.test:443/api/v1/auth/cognito/migrate",
                     "https://preview.example.test/api/v1/auth/cognito/migrate?url=https://other.invalid",
                     "https://preview.example.test/other", "https://preview.example.test/api/v1/auth/cognito/migrate#secret"]
        for endpoint in endpoints:
            with patch.dict(os.environ, {"MIGRATION_ENDPOINT": endpoint}):
                self.rejected()
        with patch.dict(os.environ, {"EXPECTED_ACCOUNT_ID": "999999999999"}):
            self.rejected()
        self.key_mock.assert_not_called()
        self.https.assert_not_called()

    def test_exhausted_context_rejects_without_io(self):
        self.context.get_remaining_time_in_millis.return_value = 600
        self.rejected()
        self.key_mock.assert_not_called()
        self.https.assert_not_called()

    def test_native_signup_proof_allows_confirmation_but_never_verifies_email(self):
        value = native()
        value["response"] = {"autoConfirmUser": True, "autoVerifyEmail": True}
        with patch.object(migration.time, "time", return_value=1800000000):
            answer = self.invoke(value)
        self.assertEqual(answer["response"], {"autoConfirmUser": False, "autoVerifyEmail": False, "autoVerifyPhone": False})
        self.https.assert_not_called()
        value["userName"] = USER_ID
        with patch.object(migration.time, "time", return_value=1800000000):
            self.invoke(value)

    def test_native_signup_rejects_missing_proof_and_transplanted_or_expired_proof(self):
        valid = native()
        bad = [event(migration.SIGNUP_NATIVE)]
        for key, replacement in [("signupTimestamp", "1799999939"), ("signupTimestamp", "1800000061"),
                                 ("signupNonce", "1"), ("signupSignature", "00" * 32),
                                 ("signupSignature", 2), ("signupTimestamp", "1e9")]:
            value = copy.deepcopy(valid)
            value["request"]["clientMetadata"][key] = replacement
            bad.append(value)
        for email in ["other@example.test", "Learner@example.test"]:
            value = copy.deepcopy(valid)
            value["request"]["userAttributes"]["email"] = email
            bad.append(value)
        bad.append({**valid, "userPoolId": REGION + "_Other"})
        bad.append({**valid, "userName": ""})
        bad.append({**valid, "userName": "x" * 129})
        with patch.object(migration.time, "time", return_value=1800000000):
            for value in bad:
                self.rejected(value)
        self.https.assert_not_called()

    def test_only_cognito_external_or_iam_admin_events_pass_without_signup_proof(self):
        for trigger in [migration.SIGNUP_EXTERNAL, migration.SIGNUP_ADMIN]:
            value = event(trigger)
            self.assertEqual(self.invoke(value), value)
        self.key_mock.assert_not_called()
        self.https.assert_not_called()


class DependencyAndPackagingTests(unittest.TestCase):
    def setUp(self):
        migration._key_cache = None
        self.addCleanup(lambda: setattr(migration, "_key_cache", None))

    def test_cold_sdk_setup_precedes_request_budget_and_is_reused(self):
        # Simulated cold setup would exhaust the 3.5s handler budget. This is
        # an ordering/retention regression, not a claim about AWS latency.
        budget = {"active": False, "cold_setup_ms": 3600}
        client = Mock()
        client.get_secret_value.return_value = {"SecretString": json.dumps({"hmacKey": "ab" * 32})}

        def construct(*args, **kwargs):
            if budget["active"] and budget["cold_setup_ms"] >= 3500:
                raise TimeoutError("simulated cold SDK setup exhausted request budget")
            return client

        sdk = types.SimpleNamespace(client=Mock(side_effect=construct))
        configuration = Mock(side_effect=lambda **kwargs: kwargs)
        spec = importlib.util.spec_from_file_location("cold_migration", migration.__file__)
        cold = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, ENV, clear=True), patch.dict("sys.modules", {
                "boto3": sdk, "botocore.config": types.SimpleNamespace(Config=configuration)}):
            spec.loader.exec_module(cold)
            self.assertEqual(sdk.client.call_count, 1)
            self.assertEqual(sdk.client.call_args.args, ("secretsmanager",))
            self.assertEqual(sdk.client.call_args.kwargs["region_name"], REGION)
            client.get_secret_value.assert_not_called()

            @contextlib.contextmanager
            def request_budget(context):
                budget["active"] = True
                try:
                    yield
                finally:
                    budget["active"] = False

            def read_secret(**kwargs):
                self.assertTrue(budget["active"], "Secret reads must remain bounded by the handler deadline")
                return {"SecretString": json.dumps({"hmacKey": "ab" * 32})}

            client.get_secret_value.side_effect = read_secret
            with patch.object(cold, "_deadline", request_budget), \
                    patch.object(cold.time, "time", return_value=1800000000):
                for _ in range(2):
                    answer = cold.handler(native(), Mock())
                    self.assertFalse(answer["response"]["autoConfirmUser"])
                    self.assertFalse(answer["response"]["autoVerifyEmail"])
        self.assertEqual(sdk.client.call_count, 1)
        client.get_secret_value.assert_called_once()
        self.assertEqual(configuration.call_args.kwargs["retries"]["total_max_attempts"], 1)

    def test_failed_initialization_and_region_change_fail_closed_without_retry(self):
        sdk = types.SimpleNamespace(client=Mock(side_effect=RuntimeError("private-sdk-credential")))
        with patch.dict(os.environ, ENV, clear=True), patch.dict("sys.modules", {
                "boto3": sdk, "botocore.config": types.SimpleNamespace(Config=lambda **kwargs: kwargs)}):
            self.assertIsNone(migration._initialize_secret_client())
        for prepared in [None, ("us-east-1", Mock())]:
            with patch.object(migration, "_secret_client", prepared):
                with self.assertRaises(migration._SecretSetupUnavailable):
                    migration._migration_key(REGION, ENV["MIGRATION_SECRET_ARN"])
        self.assertEqual(sdk.client.call_count, 1)
        self.assertIsNone(migration._key_cache)

    def test_cold_secret_read_is_still_interrupted_and_never_cached(self):
        client = Mock()
        client.get_secret_value.side_effect = lambda **kwargs: time.sleep(1)
        context = Mock(get_remaining_time_in_millis=Mock(return_value=800))
        started = time.monotonic()
        with patch.dict(os.environ, ENV, clear=True), patch.object(migration, "_secret_client", (REGION, client)), \
                self.assertLogs(migration._logger, level="ERROR") as logs:
            with self.assertRaises(migration.MigrationRejected):
                migration.handler(native(), context)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(logs.output, ["ERROR:migration:migration_rejected stage=secret_lookup cause=deadline"])
        client.get_secret_value.assert_called_once()
        self.assertIsNone(migration._key_cache)

    def test_secret_is_exact_hex_format_cached_briefly_with_no_sdk_retries(self):
        sdk = Mock()
        client = Mock()
        client.get_secret_value.return_value = {"SecretString": json.dumps({"hmacKey": "ab" * 32})}
        sdk.client.return_value = client
        configuration = Mock(side_effect=lambda **kwargs: kwargs)
        with patch.dict(os.environ, ENV, clear=True), \
                patch.dict("sys.modules", {"boto3": sdk, "botocore.config": types.SimpleNamespace(Config=configuration)}):
            prepared = migration._initialize_secret_client()
        with patch.object(migration, "_secret_client", prepared), \
                patch.object(migration.time, "monotonic", return_value=10):
            self.assertEqual(migration._migration_key(REGION, ENV["MIGRATION_SECRET_ARN"]), KEY)
            self.assertEqual(migration._migration_key(REGION, ENV["MIGRATION_SECRET_ARN"]), KEY)
        client.get_secret_value.assert_called_once_with(SecretId=ENV["MIGRATION_SECRET_ARN"])
        self.assertEqual(configuration.call_args.kwargs["retries"]["total_max_attempts"], 1)
        with patch.object(migration, "_secret_client", prepared), \
                patch.object(migration.time, "monotonic", return_value=71):
            migration._migration_key(REGION, ENV["MIGRATION_SECRET_ARN"])
        self.assertEqual(client.get_secret_value.call_count, 2)
        sdk.client.assert_called_once()

    def test_bad_secret_document_cannot_be_interpreted_as_a_key(self):
        sdk = Mock()
        client = sdk.client.return_value
        bad = [{}, {"hmacKey": "AB" * 32}, {"hmacKey": "ab" * 31}, {"hmacKey": 10},
               {"hmacKey": "ab" * 32, "extra": "ignored?"}]
        with patch.object(migration, "_secret_client", (REGION, client)):
            for value in bad:
                client.get_secret_value.return_value = {"SecretString": json.dumps(value)}
                with self.assertRaises(migration.MigrationRejected):
                    migration._migration_key(REGION, ENV["MIGRATION_SECRET_ARN"])
                self.assertIsNone(migration._key_cache)

    def test_overall_deadline_interrupts_a_slow_operation_and_restores_alarm(self):
        context = Mock(get_remaining_time_in_millis=Mock(return_value=800))
        previous = signal.getsignal(signal.SIGALRM)
        started = time.monotonic()
        with self.assertRaises(migration.MigrationRejected):
            with migration._deadline(context):
                time.sleep(1)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_zip_is_deterministic_and_contains_only_handler_source(self):
        with tempfile.TemporaryDirectory() as folder:
            first = package.build(Path(folder) / "first.zip")
            second = package.build(Path(folder) / "second.zip")
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), ["migration.py"])
                self.assertEqual(archive.read("migration.py"), Path(migration.__file__).read_bytes())
                self.assertEqual(archive.getinfo("migration.py").external_attr >> 16, 0o100644)


if __name__ == "__main__":
    unittest.main()
