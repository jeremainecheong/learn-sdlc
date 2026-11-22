"""Timeout output recovery, using mocked children only: no sandbox execution."""

import os
import signal
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sandbox_runner  # noqa: E402


class TimeoutOutputTest(unittest.TestCase):
    def setUp(self):
        self.proc = mock.Mock(pid=12345, returncode=-signal.SIGKILL)
        spawn = mock.patch.object(sandbox_runner, "spawn_child", return_value=self.proc)
        reap = mock.patch.object(sandbox_runner, "reap_group")
        self.spawn = spawn.start()
        self.reap = reap.start()
        self.addCleanup(spawn.stop)
        self.addCleanup(reap.stop)
        isolation = mock.patch.object(sandbox_runner, "isolation_status", return_value={"status": "ok", "mechanism": "mock"})
        isolation.start()
        self.addCleanup(isolation.stop)

    def expired(self, output=None, stderr=None, seconds=15):
        return subprocess.TimeoutExpired(["mock-child"], seconds, output=output, stderr=stderr)

    def run_timed_out(self, first, cleanup):
        self.proc.communicate.side_effect = [first, cleanup]
        result = sandbox_runner.run_child(
            ["mock-child"], "/mock-workspace", 15, 256,
            extra_env={"LEARNSDLC_NOW": "2026-09-15"}, extra_roots=["/mock-graded"],
        )
        self.assertEqual(len(result), 4)
        self.assertEqual((result[0], result[3]), (-1, "timeout"))
        self.assertEqual(self.proc.communicate.call_args_list,
                         [mock.call(timeout=15), mock.call(timeout=5)])
        self.reap.assert_called_once_with(self.proc.pid)
        self.spawn.assert_called_once_with(
            ["mock-child"], "/mock-workspace", 256, 15,
            extra_env={"LEARNSDLC_NOW": "2026-09-15"}, nofile=128,
            limit_address_space=True, extra_roots=["/mock-graded"],
        )
        return result[1:3]

    def test_latest_cumulative_bytes_replace_initial_snapshots_without_duplication(self):
        self.assertEqual(self.run_timed_out(
            self.expired(b"first\n", b"warning\n"),
            self.expired(b"first\nsecond\n", b"warning\nlast\n", 5),
        ), ("first\nsecond\n", "warning\nlast\n"))

    def test_latest_cumulative_text_is_also_supported(self):
        self.assertEqual(self.run_timed_out(
            self.expired("first\n", "warning\n"),
            self.expired("first\nsecond\n", "warning\nlast\n", 5),
        ), ("first\nsecond\n", "warning\nlast\n"))

    def test_missing_cleanup_streams_recover_the_first_snapshot(self):
        for output, stderr in ((b"first", b"warning"), ("first", "warning")):
            with self.subTest(output_type=type(output).__name__):
                self.proc.communicate.reset_mock()
                self.spawn.reset_mock()
                self.reap.reset_mock()
                self.assertEqual(self.run_timed_out(
                    self.expired(output, stderr), self.expired(seconds=5),
                ), ("first", "warning"))

    def test_missing_initial_streams_use_cleanup_snapshots(self):
        self.assertEqual(self.run_timed_out(
            self.expired(), self.expired(b"arrived during cleanup", "late warning", 5),
        ), ("arrived during cleanup", "late warning"))

    def test_streams_fall_back_independently(self):
        self.assertEqual(self.run_timed_out(
            self.expired(b"first", "warning"), self.expired(b"first and later", None, 5),
        ), ("first and later", "warning"))

    def test_empty_cleanup_snapshots_do_not_erase_available_output(self):
        self.assertEqual(self.run_timed_out(
            self.expired(b"first", "warning"), self.expired(b"", "", 5),
        ), ("first", "warning"))

    def test_both_missing_snapshots_produce_empty_strings(self):
        self.assertEqual(self.run_timed_out(self.expired(), self.expired(seconds=5)), ("", ""))

    def test_successful_drain_is_complete_and_not_concatenated_or_clipped(self):
        stdout = "first\n" + "x" * 25000
        stderr = "warning\nlast\n"
        self.assertEqual(self.run_timed_out(
            self.expired(b"first\n", b"warning\n"), (stdout, stderr),
        ), (stdout, stderr))

    def test_successful_drain_with_missing_streams_keeps_existing_empty_behavior(self):
        self.assertEqual(self.run_timed_out(self.expired(), (None, None)), ("", ""))

    def test_invalid_and_incomplete_utf8_cannot_erase_timeout_diagnostics(self):
        self.assertEqual(self.run_timed_out(
            self.expired(b"bad \xff", b"partial \xe2\x82"), self.expired(seconds=5),
        ), ("bad \ufffd", "partial \ufffd"))

    def test_timeout_snapshot_decoding_is_bounded_before_decode(self):
        decoded_lengths = []

        class MeasuredBytes(bytes):
            def __getitem__(self, key):
                return MeasuredBytes(super().__getitem__(key))

            def decode(self, encoding="utf-8", errors="strict"):
                decoded_lengths.append(len(self))
                return super().decode(encoding, errors)

        output = MeasuredBytes(b"x" * 19999 + "€".encode("utf-8") + b"y" * 50000)
        self.assertEqual(self.run_timed_out(
            self.expired(output, "w" * 50000), self.expired(seconds=5),
        ), ("x" * 19999 + "\ufffd\n… (truncated)", "w" * 20000 + "\n… (truncated)"))
        self.assertEqual(decoded_lengths, [20000])

    def test_recovered_passing_result_never_turns_timeout_into_success(self):
        marker = (b'@@LSDLC_RESULT@@{"total":1,"passed":1,"failed":0,"errored":0,'
                  b'"cases":[{"name":"a completed case","status":"passed","durationMs":1}]}\n')
        self.proc.communicate.side_effect = [self.expired(marker), self.expired(seconds=5)]
        result = sandbox_runner.execute_job({"mode": "tests", "language": "python", "files": {},
                                             "testPaths": [], "timeoutSeconds": 15})
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitKind"], "timeout")
        self.assertEqual(result["tests"]["passed"], 1)
        self.assertEqual(result["stdout"], "")
        self.assertEqual(result["stderr"], "")
        self.spawn.assert_called_once()
        self.reap.assert_called_once_with(self.proc.pid)

    def test_non_timeout_result_keeps_existing_contract(self):
        self.proc.returncode = 7
        self.proc.communicate.return_value = ("output", "failure")
        self.assertEqual(sandbox_runner.run_child(["mock-child"], "/mock-workspace", 15, 256),
                         (7, "output", "failure", "ok"))
        self.proc.communicate.assert_called_once_with(timeout=15)
        self.reap.assert_not_called()


if __name__ == "__main__":
    unittest.main()
