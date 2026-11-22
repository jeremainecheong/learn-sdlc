"""The operator's real-MicroVM verification refuses to start without its own options."""
import contextlib
import io
import sys
import unittest
from unittest import mock

import verify_real


def run_main(*argv):
    """Run verify_real.main with argv and answer (exit code, stderr text); it must stop."""
    error = io.StringIO()
    with mock.patch.object(sys, "argv", ["verify_real.py", *argv]), contextlib.redirect_stderr(error):
        try:
            verify_real.main()
        except SystemExit as stop:
            return stop.code, error.getvalue()
    raise AssertionError("verify_real.main() returned instead of stopping")


class RequiredOptionsTests(unittest.TestCase):
    def test_the_profile_outputs_and_evidence_folder_have_no_defaults(self):
        code, error = run_main("--run")
        self.assertEqual(code, 2)
        for option in ("--profile", "--outputs", "--evidence-dir"):
            self.assertIn(option, error)

    def test_a_missing_option_stops_the_run_before_anything_is_read_or_launched(self):
        with mock.patch.object(verify_real, "OperatorVerificationCli") as cli, \
                mock.patch.object(verify_real.Path, "read_text") as read:
            code, _ = run_main("--run", "--profile", "operator", "--outputs", "outputs.json")
        self.assertEqual(code, 2)
        cli.assert_not_called()
        read.assert_not_called()

    def test_without_run_it_still_refuses_to_launch(self):
        code, _ = run_main("--profile", "operator", "--outputs", "outputs.json", "--evidence-dir", "evidence")
        self.assertIn("--run", str(code))

    def test_the_aws_cli_defaults_to_the_one_on_path(self):
        self.assertEqual(verify_real.AWS_BIN, "aws")


if __name__ == "__main__":
    unittest.main()
