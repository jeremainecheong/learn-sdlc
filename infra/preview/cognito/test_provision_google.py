import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import provision_google as google


CONFIG = {"awsProfile": "preview-fixture", "awsRegion": "ap-southeast-1", "expectedAccountId": "123456789012",
          "userPoolId": "ap-southeast-1_Fixture123", "clientId": "fixture.apps.googleusercontent.com",
          "clientSecret": "private-google-secret-fixture"}


class GoogleProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / "google.local.json"
        self.file.write_text(json.dumps(CONFIG))
        self.file.chmod(0o600)

    def test_secret_file_mode_symlink_and_duplicate_keys_are_rejected(self):
        self.assertEqual(google.read_config(self.file), CONFIG)
        for mode in [0o644, 0o660, 0o400]:
            self.file.chmod(mode)
            with self.assertRaises(google.ProvisioningError):
                google.read_config(self.file)
        self.file.chmod(0o600)
        link = Path(self.folder.name) / "link.json"
        link.symlink_to(self.file)
        with self.assertRaises(OSError):
            google.read_config(link)
        self.file.write_text('{"clientSecret":"one","clientSecret":"two"}')
        with self.assertRaises(google.ProvisioningError):
            google.read_config(self.file)

    def test_offline_validation_makes_no_aws_requests_and_prints_no_credentials(self):
        output = io.StringIO()
        with patch.object(google.subprocess, "run") as run, contextlib.redirect_stdout(output):
            self.assertEqual(google.main(["--config", str(self.file)]), 0)
        run.assert_not_called()
        self.assertNotIn(CONFIG["clientSecret"], output.getvalue())
        self.assertNotIn(CONFIG["clientId"], output.getvalue())

    def test_wrong_account_stops_before_any_provider_request(self):
        with patch.object(google, "_aws", return_value={"Account": "999999999999"}) as aws:
            with self.assertRaises(google.ProvisioningError):
                google.provision(CONFIG, "/fake/aws")
        aws.assert_called_once()

    def test_create_and_update_preserve_minimal_mapping_and_do_not_touch_app_client(self):
        for exists in [False, True]:
            providers = [{"ProviderName": "Google", "ProviderType": "Google"}] if exists else []
            with patch.object(google, "_aws", side_effect=[{"Account": CONFIG["expectedAccountId"]}, {"Providers": providers}, None]) as aws:
                self.assertEqual(google.provision(CONFIG, "/fake/aws"), "updated" if exists else "created")
            call = aws.call_args
            self.assertEqual(call.args[2], ["cognito-idp", "update-identity-provider" if exists else "create-identity-provider"])
            payload = call.kwargs["payload"]
            self.assertEqual(payload["AttributeMapping"], {"email": "email", "email_verified": "email_verified", "name": "name"})
            self.assertEqual(payload["ProviderDetails"]["authorize_scopes"], "openid email profile")
            self.assertEqual("ProviderType" in payload, not exists)
            self.assertFalse(call.kwargs["decode"])
            self.assertEqual(aws.call_count, 3)

    def test_mutation_keeps_secret_out_of_argv_uses_private_file_and_discards_response(self):
        payload = {"ProviderDetails": {"client_secret": CONFIG["clientSecret"]}}
        seen = []
        def fake_run(command, **kwargs):
            seen.append(command)
            self.assertNotIn(CONFIG["clientSecret"], " ".join(command))
            path = Path(command[-1].removeprefix("file://"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), payload)
            self.assertTrue(kwargs["capture_output"])
            self.assertEqual(kwargs["env"]["AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"], "true")
            self.assertEqual(kwargs["env"]["AWS_EC2_METADATA_DISABLED"], "true")
            return subprocess.CompletedProcess(command, 0, stdout=CONFIG["clientSecret"].encode(), stderr=b"")
        with patch.object(google.subprocess, "run", side_effect=fake_run):
            self.assertIsNone(google._aws("/fake/aws", CONFIG, ["cognito-idp", "create-identity-provider"], payload=payload, decode=False))
        self.assertFalse(Path(seen[0][-1].removeprefix("file://")).exists())

    def test_cli_failure_never_prints_secret_or_raw_provider_output(self):
        output = io.StringIO()
        with patch.object(google.shutil, "which", return_value="/fake/aws"), \
                patch.object(google.subprocess, "run", return_value=subprocess.CompletedProcess([], 1,
                             stdout=CONFIG["clientSecret"].encode(), stderr=CONFIG["clientSecret"].encode())), \
                contextlib.redirect_stdout(output):
            self.assertEqual(google.main(["--config", str(self.file), "--apply"]), 1)
        self.assertNotIn(CONFIG["clientSecret"], output.getvalue())


if __name__ == "__main__":
    unittest.main()
