"""Supervisor configuration tests with a mocked runner process only."""
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import gateway


class IsolationBootstrapTests(unittest.TestCase):
    def test_fixed_environment_binds_isolation_and_excludes_parent_credentials(self):
        process = Mock()
        process.poll.return_value = None
        client = Mock()
        client.request.return_value = (200, {"uid": 65534, "ok": True,
                                            "isolation": {"status": "ok", "mechanism": "single-job-microvm"}})
        with patch.dict(os.environ, {"RUNNER_ISOLATION": "learner-spoof", "AWS_SECRET_ACCESS_KEY": "secret-canary"}), \
             patch.object(Path, "mkdir"), patch.object(gateway.os, "chmod"), patch.object(gateway.os, "chown"), \
             patch.object(gateway.subprocess, "Popen", return_value=process) as spawn, \
             patch.object(gateway, "RunnerClient", return_value=client):
            gateway.start_runner()
        env = spawn.call_args.kwargs["env"]
        self.assertEqual(env["RUNNER_ISOLATION"], "single-job-microvm")
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertEqual(env["RUNNER_SLOTS"], "1")
        self.assertIs(spawn.call_args.kwargs["preexec_fn"], gateway.drop_runner_privileges)

    def test_unhealthy_or_legacy_runner_does_not_satisfy_bootstrap(self):
        for health in ({"uid": 65534, "ok": True}, {"uid": 65534, "ok": False,
                "isolation": {"status": "unsupported", "mechanism": "none"}}):
            with self.subTest(health=health):
                process, client = Mock(), Mock()
                process.poll.return_value = None
                client.request.return_value = (200, health)
                with patch.object(Path, "mkdir"), patch.object(gateway.os, "chmod"), patch.object(gateway.os, "chown"), \
                     patch.object(gateway.subprocess, "Popen", return_value=process), \
                     patch.object(gateway, "RunnerClient", return_value=client), \
                     patch.object(gateway.time, "monotonic", side_effect=[0, 0, 31]), patch.object(gateway.time, "sleep"):
                    with self.assertRaises(RuntimeError): gateway.start_runner()
                process.terminate.assert_called_once()


if __name__ == "__main__": unittest.main()
