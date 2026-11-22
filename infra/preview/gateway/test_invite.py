import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gate import Gate


class InvitationToolTest(unittest.TestCase):
    def test_private_output_no_logging_and_independent_invites(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / "gate.private.json"
            outputs = [Path(directory) / f"invite-{i}.private.json" for i in range(2)]
            base = [sys.executable, str(Path(__file__).with_name("invite.py")), "--secret-file", str(secret),
                    "--site-host", "preview.example"]
            # Two simultaneous local issuances must preserve both records.
            processes = [subprocess.Popen(base + ["--output", str(output)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for output in outputs]
            for process in processes:
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertNotIn("https://", stdout)
                self.assertNotIn("signing_key", stdout)
            config = json.loads(secret.read_text())
            self.assertEqual(len(config["invites"]), 2)
            self.assertEqual(os.stat(secret).st_mode & 0o777, 0o600)
            for output in outputs:
                result = json.loads(output.read_text())
                self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
                self.assertNotIn(result["code"], secret.read_text())
                self.assertTrue(result["url"].startswith("https://preview.example/_preview/access/"))
                self.assertIsNotNone(Gate(secret, "preview.example").exchange(result["code"]))
            before = secret.read_bytes(), outputs[0].read_bytes()
            repeat = subprocess.run(base + ["--output", str(outputs[0])], capture_output=True)
            self.assertNotEqual(repeat.returncode, 0)
            self.assertEqual(before, (secret.read_bytes(), outputs[0].read_bytes()))


if __name__ == "__main__":
    unittest.main()
