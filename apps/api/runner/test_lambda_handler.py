"""The Lambda entrypoint hands the runner's own sentence through untouched.

A TypeScript step on the Lambda transport has no
node to run on, so `execute_job` answers `unavailable` with a sentence that
names the limit. The API reads a non-empty stderr on an `unavailable` result
as that permanent limit and shows the sentence to the learner verbatim; an
empty one is the transport failing, where "try again" is right. So the one
thing the handler must not do is rewrite, clip or drop that field on its way
out, and the two envelopes it does write itself (`{error}` for a preview
and for a job it cannot read) must stay distinguishable from a result.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lambda_handler  # noqa: E402
from sandbox_runner import JS_UNAVAILABLE_MESSAGE  # noqa: E402


def typescript_job(files, test_paths):
    return {
        "files": files,
        "mode": "tests",
        "testPaths": test_paths,
        "language": "typescript",
        "transform": {"tool": "esbuild", "jsx": "automatic"},
        "timeoutSeconds": 20,
        "memoryMb": 512,
    }


class WithoutNodeTest(unittest.TestCase):
    """The function image: python3 and the baked layer, no node."""

    def setUp(self):
        self._node = os.environ.get("NODE_BIN")
        os.environ["NODE_BIN"] = "/nonexistent/lambda-has-no/node"

    def tearDown(self):
        if self._node is None:
            os.environ.pop("NODE_BIN", None)
        else:
            os.environ["NODE_BIN"] = self._node

    def test_the_runners_sentence_reaches_the_caller_verbatim(self):
        result = lambda_handler.handler(
            typescript_job({"x.test.ts": "test('ok', () => { assert.ok(true); });"}, ["x.test.ts"]),
            None,
        )
        self.assertEqual(result["exitKind"], "unavailable")
        self.assertFalse(result["ok"])
        self.assertIsNone(result["tests"])
        # Verbatim: the API's rule is "stderr on an unavailable result is the
        # runner's sentence", and the panel draws exactly this string.
        self.assertEqual(result["stderr"], JS_UNAVAILABLE_MESSAGE)
        self.assertIn("cannot run JavaScript", result["stderr"])
        # A sentence, not a traceback: nothing about the missing binary's path.
        self.assertNotIn("/nonexistent", result["stderr"])
        self.assertNotIn("Traceback", result["stderr"])

    def test_a_python_job_still_runs_and_carries_no_sentence(self):
        result = lambda_handler.handler({
            "files": {"tests/test_x.py": (
                "import unittest\n"
                "class T(unittest.TestCase):\n"
                "    def test_ok(self):\n"
                "        self.assertEqual(1 + 1, 2)\n"
            )},
            "mode": "tests", "testPaths": ["tests/test_x.py"],
            "timeoutSeconds": 10, "memoryMb": 128,
        }, None)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["exitKind"], "ok")
        self.assertEqual(result["tests"]["passed"], 1)


class HandlerEnvelopesTest(unittest.TestCase):
    """What the handler writes itself is an envelope, never a result."""

    def test_a_preview_is_an_error_envelope_not_a_result(self):
        answer = lambda_handler.handler({"mode": "preview", "files": {}}, None)
        self.assertEqual(answer, {"error": lambda_handler.PREVIEW_UNAVAILABLE})
        self.assertNotIn("exitKind", answer)

    def test_a_job_it_cannot_read_is_an_error_envelope_not_a_result(self):
        answer = lambda_handler.handler({"mode": "no-such-mode", "files": {}}, None)
        self.assertEqual(sorted(answer.keys()), ["error"])
        self.assertTrue(answer["error"].startswith("invalid job: "), answer)


if __name__ == "__main__":
    unittest.main()
