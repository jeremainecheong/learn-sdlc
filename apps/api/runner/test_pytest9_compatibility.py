"""A real pytest 9 subtest failure must remain a failed runner result."""

import importlib.metadata
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sandbox_runner import execute_job, runtime_site_packages


class Pytest9SubtestsTest(unittest.TestCase):
    def setUp(self):
        runtime = runtime_site_packages()
        if not runtime:
            self.skipTest("The reviewed pytest 9 runtime must be pre-baked first.")
        versions = {dist.metadata["Name"].lower(): dist.version
                    for dist in importlib.metadata.distributions(path=[runtime])}
        self.assertEqual(versions.get("pytest"), "9.0.3", "This compatibility check requires the reviewed pytest 9.0.3 runtime.")

    def run_suite(self, source):
        return execute_job({
            "files": {"tests/test_subtests.py": source},
            "testPaths": ["tests/test_subtests.py"], "mode": "tests",
            "language": "python", "harness": "pytest",
            "timeoutSeconds": 15, "memoryMb": 256,
        })

    def test_failed_subtest_cannot_be_reported_as_a_passing_suite(self):
        result = self.run_suite('''def test_numbers(subtests):
    for number in [1, 2]:
        with subtests.test(number=number):
            assert number == 1

def test_independent_success():
    assert True
''')
        self.assertEqual(result["exitKind"], "ok", result)
        self.assertFalse(result["ok"], result)
        tests = result["tests"]
        self.assertIsNotNone(tests)
        self.assertEqual(tests["failed"], 1, tests)
        self.assertEqual(tests["errored"], 0, tests)
        self.assertEqual(tests["total"], len(tests["cases"]))
        self.assertEqual(tests["total"], tests["passed"] + tests["failed"] + tests["errored"])
        self.assertTrue(any(case["name"] == "test_independent_success" and case["status"] == "passed"
                            for case in tests["cases"]), tests)
        failed = [case for case in tests["cases"] if case["status"] == "failed"]
        self.assertIn("test_numbers", failed[0]["name"])
        self.assertIn("AssertionError", failed[0].get("message", ""))
        self.assertTrue(failed[0].get("frames"), "The actual failed subtest must retain its workspace traceback.")

    def test_subtests_keep_their_own_assertion_and_exception_details(self):
        result = self.run_suite('''def test_mixed(subtests):
    with subtests.test("assertion"):
        assert 2 == 1
    with subtests.test("exception"):
        raise ValueError("different subtest failure")
''')
        self.assertEqual(result["exitKind"], "ok", result)
        self.assertFalse(result["ok"], result)
        tests = result["tests"]
        self.assertEqual(tests["failed"], 1, tests)
        self.assertEqual(tests["errored"], 1, tests)
        failed = next(case for case in tests["cases"] if case["status"] == "failed")
        errored = next(case for case in tests["cases"] if case["status"] == "errored")
        self.assertIn("AssertionError", failed.get("message", ""))
        self.assertIn("ValueError: different subtest failure", errored.get("message", ""))
        self.assertNotEqual(failed["name"], errored["name"], "A learner must be able to distinguish the two subtests.")

    def test_repeated_subtest_labels_do_not_hide_parent_or_teardown_failures(self):
        result = self.run_suite('''import pytest

@pytest.fixture
def broken_teardown():
    yield
    raise RuntimeError("teardown still failed")

def test_parent(subtests, broken_teardown):
    for number in [1, 2]:
        with subtests.test("repeated"):
            assert number == 0
    raise ValueError("parent still failed")
''')
        self.assertEqual(result["exitKind"], "ok", result)
        self.assertFalse(result["ok"], result)
        tests = result["tests"]
        self.assertEqual((tests["total"], tests["failed"], tests["errored"]), (4, 2, 2), tests)
        failed = [case for case in tests["cases"] if case["status"] == "failed"]
        self.assertEqual(len({case["name"] for case in failed}), 2)
        self.assertEqual({case["message"] for case in failed}, {"AssertionError: assert 1 == 0", "AssertionError: assert 2 == 0"})
        errors = [case["message"] for case in tests["cases"] if case["status"] == "errored"]
        self.assertCountEqual(errors, ["ValueError: parent still failed", "RuntimeError: teardown still failed"])

    def test_strict_xpass_parent_is_not_hidden_by_a_passing_subtest(self):
        result = self.run_suite('''import pytest

def test_strict_parent(subtests, request):
    with subtests.test("passing child"):
        assert True
    request.node.add_marker(pytest.mark.xfail(strict=True, reason="late expectation"))
''')
        self.assertEqual(result["exitKind"], "ok", result)
        self.assertFalse(result["ok"], result)
        tests = result["tests"]
        parent = next(case for case in tests["cases"] if case["name"] == "test_strict_parent")
        self.assertEqual(parent["status"], "failed", tests)
        self.assertIn("XPASS(strict)", parent.get("message", ""))


if __name__ == "__main__":
    unittest.main()
