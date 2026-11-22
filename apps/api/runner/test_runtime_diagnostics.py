"""Mocked supervisor/child tests; no learner program is executed."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
import app_session
import runtime_diagnostics as telemetry
import sandbox_runner as runner


class DiagnosticTests(unittest.TestCase):
    def test_linux_counters_are_numeric_and_never_include_process_text(self):
        # Fields 14/15 in stat, including a process name with spaces/parens.
        stat = "123 (secret-canary ) name) S " + " ".join(["0"] * 10 + ["20", "10"])
        def read(path):
            return stat if str(path).endswith("/stat") else "Name:\tsecret-canary\nVmHWM:\t321 kB\n"
        with patch.object(telemetry, "_read", side_effect=read), patch.object(telemetry.os, "sysconf", return_value=100):
            values = telemetry.process_sample(123)
        self.assertEqual(values, {"cpuUserMs": 200, "cpuSystemMs": 100, "peakRssBytes": 328704})
        self.assertNotIn("secret", json.dumps(values))

    def test_unavailable_proc_data_is_unknown_not_fabricated_zero(self):
        with patch.object(telemetry, "_read", return_value=""):
            self.assertEqual(telemetry.process_sample(123), {})
            self.assertEqual(telemetry.cgroup_sample(), {})

    def test_timeout_samples_before_kill_and_preserves_failed_verdict(self):
        proc = Mock(pid=123, returncode=-9)
        proc.communicate.side_effect = [subprocess.TimeoutExpired("hidden-source", 15), ("", "")]
        events = []
        with patch.object(runner, "isolation_status", return_value={"status": "ok"}), \
             patch.object(runner, "spawn_child", return_value=proc), \
             patch.object(runner, "reap_group", side_effect=lambda pid: events.append("kill")), \
             patch.object(telemetry, "process_sample", side_effect=lambda pid: events.append("sample") or {"cpuUserMs": 34, "peakRssBytes": 42}), \
             patch.object(telemetry, "cgroup_sample", return_value={}):
            result = runner.execute_job({"mode": "tests", "files": {}, "testPaths": [], "timeoutSeconds": 15})
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitKind"], "timeout")
        self.assertEqual(events[events.index("kill") - 1], "sample")
        diag = result["diagnostics"]
        self.assertEqual(diag["cpuUserMs"], 34)
        self.assertEqual(diag["peakRssBytes"], 42)
        self.assertIn("timeout", [stage["stage"] for stage in diag["stages"]])
        self.assertNotIn("hidden-source", json.dumps(diag))
        self.assertIsNone(telemetry.CURRENT.get())
        proc.communicate.assert_any_call(timeout=15)
        proc.communicate.assert_any_call(timeout=5)

    def test_thread_capacity_failure_does_not_change_result(self):
        diag = telemetry.Diagnostics()
        token = telemetry.CURRENT.set(diag)
        try:
            with patch.object(telemetry.threading.Thread, "start", side_effect=RuntimeError("no threads")):
                sampler = telemetry.ChildSampler(123)
                sampler.close()
            self.assertIsNone(sampler.thread)
        finally: telemetry.CURRENT.reset(token)

    def test_per_job_context_is_reset_on_error_and_counters_do_not_leak(self):
        with patch.object(runner, "isolation_status", return_value={"status": "ok"}), \
             patch.object(runner, "_execute_job", side_effect=ValueError("hidden-source")):
            with self.assertRaises(ValueError): runner.execute_job({})
        self.assertIsNone(telemetry.CURRENT.get())
        with patch.object(telemetry, "cgroup_sample", return_value={}):
            diag = telemetry.Diagnostics()
        for _ in range(100): diag.stage("prepare")
        result = diag.result()
        self.assertEqual(len(result["stages"]), 16)
        self.assertNotIn("cpuUserMs", result)


class IsolationTests(unittest.TestCase):
    def test_absent_kernel_isolation_refuses_before_workspace_or_child(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(runner, "landlock_abi", return_value=0), \
             patch.object(runner, "_execute_job") as execute, patch.object(app_session, "PreviewSession") as preview:
            result = runner.execute_job({"mode": "tests", "RUNNER_ISOLATION": "single-job-microvm"})
            session = app_session.start({"mode": "preview", "env": {"RUNNER_ISOLATION": "single-job-microvm"}})
        self.assertEqual(result["exitKind"], "unavailable")
        self.assertEqual(result["diagnostics"]["stages"][0]["stage"], "unsupported")
        self.assertEqual(session["status"], "unavailable")
        execute.assert_not_called()
        preview.assert_not_called()

    def test_health_mechanism_identifies_only_the_actual_configured_boundary(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(runner, "landlock_abi", return_value=0):
            self.assertEqual(runner.isolation_status(), {"status": "unsupported", "mechanism": "none", "reason": "kernel-isolation-unavailable"})
        with patch.dict(os.environ, {"RUNNER_ISOLATION": "single-job-microvm"}, clear=True):
            self.assertEqual(runner.isolation_status(), {"status": "ok", "mechanism": "single-job-microvm"})
        with patch.dict(os.environ, {}, clear=True), patch.object(runner, "landlock_abi", return_value=3):
            self.assertEqual(runner.isolation_status()["mechanism"], "landlock")

    def test_job_environment_cannot_set_supervisor_isolation(self):
        with self.assertRaises(ValueError):
            runner.child_env("/mock-workspace", {"RUNNER_ISOLATION": "single-job-microvm"})


class PreviewCleanupTests(unittest.TestCase):
    def test_terminal_status_retains_capacity_until_exact_child_group_is_gone(self):
        session = app_session.PreviewSession({}, app_session.limits())
        session.launch_finished = True
        session.proc = Mock(pid=123)
        with patch.dict(app_session.SESSIONS, {session.id: session}, clear=True), \
             patch.object(app_session, "reap_group") as reap, \
             patch.object(app_session.os, "killpg", side_effect=[None, ProcessLookupError()]):
            stopped = app_session._finish(session, "stopped")
            self.assertFalse(stopped["cleanupConfirmed"])
            self.assertEqual(stopped["status"], "stopped")
            self.assertEqual(app_session.stats()["sessions"], 1)
            app_session.sweep_once()
            self.assertTrue(session.view()["cleanupConfirmed"])
            self.assertEqual(app_session.stats()["sessions"], 0)
        reap.assert_any_call(123, group_id=123)

    def test_stop_during_build_fences_late_spawn_and_defers_cleanup_until_build_finishes(self):
        session_seen = []
        def stop_during_build(session, *_):
            session_seen.append(session)
            result = app_session._finish(session, "stopped", reason="learner")
            self.assertFalse(result["cleanupConfirmed"])
            self.assertTrue(os.path.isdir(session.workspace))
        with patch.dict(app_session.SESSIONS, {}, clear=True), \
             patch.object(app_session, "isolation_status", return_value={"status": "ok"}), \
             patch.object(app_session, "_bundle", side_effect=stop_during_build), \
             patch.object(app_session, "_free_port", return_value=8000), \
             patch.object(app_session, "spawn_child") as spawn:
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                app_session.start({"mode": "preview", "files": {}, "build": {"tool": "esbuild"},
                                   "service": {"command": ["python3", "api/main.py"]}})
            spawn.assert_not_called()
            self.assertTrue(session_seen[0].cleanup_confirmed)
            self.assertFalse(os.path.exists(session_seen[0].workspace))

    def test_cleanup_wait_timeout_is_not_confirmed(self):
        session = app_session.PreviewSession({}, app_session.limits())
        session.launch_finished = True
        session.proc = Mock(pid=123)
        session.proc.wait.side_effect = subprocess.TimeoutExpired("mock", 2)
        with patch.object(app_session, "reap_group"), patch.object(app_session.os, "killpg") as probe:
            self.assertFalse(app_session._finish(session, "failed")["cleanupConfirmed"])
        probe.assert_not_called()


if __name__ == "__main__": unittest.main()
