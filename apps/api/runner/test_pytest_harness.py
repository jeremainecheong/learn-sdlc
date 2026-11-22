"""Tests for the pytest harness: the one the learner reads and writes.

The learner gets pytest (plain `assert`, fixtures,
parametrize) and keeps the sealed graded artefacts on unittest, whose seal
three tests already prove. That split is only safe if the two harnesses share
one blocklist and one seal rather than a copy each, so the first thing asserted
here is that they are literally the same strings, and the next thing is that the
seal still holds when pytest is the harness running over it: `GradedFilesTest`,
`GradedShadowTest` and `GradedTeardownTest` from test_runner.py, ported.

Every fixture is written inline and passed to execute_job as a job dict (the
same payload SandboxService.execute posts), so these exercise the real child
process, the real bootstrap and the real workspace teardown.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sandbox_runner import (  # noqa: E402
    BLOCKS,
    BOOTSTRAP,
    PYTEST_BOOTSTRAP,
    SEAL,
    child_env,
    execute_job,
    parse_result_line,
    run_child,
    runtime_site_packages,
)


def setUpModule():
    """Without the pre-baked layer there is no pytest to run under.

    A skip rather than a failure: a fresh clone has not run `npm run prebake`
    yet, and a suite that fails before the machine is set up teaches nobody
    anything. CI bakes the layer before it runs this directory.
    """
    if runtime_site_packages() is None:
        raise unittest.SkipTest(
            "no pre-baked runtime: run `node scripts/prebake.mjs build` first"
        )


def pytest_job(files, test_paths, **extra):
    job = {
        "files": files,
        "mode": "tests",
        "testPaths": test_paths,
        "language": "python",
        "harness": "pytest",
        "timeoutSeconds": 30,
        "memoryMb": 256,
    }
    job.update(extra)
    return job


def by_name(tests):
    return {case["name"]: case for case in tests["cases"]}


def line_of(source, needle):
    """The 1-based line carrying needle, so no assertion hardcodes a number."""
    for number, text in enumerate(source.splitlines(), start=1):
        if needle in text:
            return number
    raise AssertionError(f"fixture has no line containing {needle!r}")


OVERDUE_PY = '''"""The slice of the tasks repository these fixtures need."""


def overdue(rows, today):
    """Open tasks with a due date strictly before today."""
    return [row for row in rows if row["due"] and row["due"] < today]


def explode():
    raise ValueError("the query is not written yet")
'''

SUITE_PY = '''import pytest

from repository import explode, overdue

ROWS = [{"due": "2026-01-01"}, {"due": None}, {"due": "2026-03-09"}]


def test_overdue_leaves_out_a_task_with_no_due_date():
    assert overdue(ROWS, "2026-03-01") == [{"due": "2026-01-01"}]


def test_overdue_is_strict_about_today():
    assert overdue(ROWS, "2026-01-01") == []


@pytest.mark.parametrize("today", ["2026-02-01", "2026-02-02"])
def test_overdue_over_two_days(today):
    assert len(overdue(ROWS, today)) == 1


def test_a_failing_assertion_is_a_failure():
    assert overdue(ROWS, "2026-03-01") == []


def test_an_exception_is_an_error():
    explode()


@pytest.fixture
def a_broken_fixture():
    raise RuntimeError("the fixture could not build its rows")


def test_a_broken_fixture_is_an_error(a_broken_fixture):
    assert True


@pytest.mark.skip(reason="not written yet")
def test_a_skip_is_not_a_result():
    assert False
'''


class SharedBlocklistTest(unittest.TestCase):
    """The two bootstraps are built from one blocklist and one seal.

    Not a style point. Two copies of a security blocklist diverge the first time
    somebody tightens one of them, and the copy nobody remembered is a hole that
    stays open until it is used. Asserting the substring is the cheapest way to
    make the arrangement structural rather than a convention.
    """

    def test_both_bootstraps_embed_the_same_blocklist(self):
        self.assertIn(BLOCKS, BOOTSTRAP)
        self.assertIn(BLOCKS, PYTEST_BOOTSTRAP)

    def test_both_bootstraps_embed_the_same_seal(self):
        self.assertIn(SEAL, BOOTSTRAP)
        self.assertIn(SEAL, PYTEST_BOOTSTRAP)


class PytestSuiteTest(unittest.TestCase):
    """One suite with a pass, a failure, an error, a broken fixture and a skip."""

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            pytest_job(
                {"repository.py": OVERDUE_PY, "tests/test_overdue.py": SUITE_PY},
                ["tests"],
            )
        )
        cls.tests = cls.result["tests"]
        cls.cases = by_name(cls.tests)

    def test_the_suite_ran(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertFalse(self.result["ok"])
        self.assertIsNotNone(self.tests)

    def test_a_passing_test_passes(self):
        self.assertEqual(
            self.cases["test_overdue_leaves_out_a_task_with_no_due_date"]["status"], "passed"
        )
        self.assertEqual(self.cases["test_overdue_is_strict_about_today"]["status"], "passed")

    def test_parametrize_produces_one_case_per_parameter(self):
        self.assertIn("test_overdue_over_two_days[2026-02-01]", self.cases)
        self.assertIn("test_overdue_over_two_days[2026-02-02]", self.cases)

    def test_a_failing_assert_is_failed_and_not_errored(self):
        # The distinction the kill matrix and scoreTests are built on: a failed
        # assertion is the suite doing its job, an exception is the suite broken.
        case = self.cases["test_a_failing_assertion_is_a_failure"]
        self.assertEqual(case["status"], "failed")
        self.assertIn("AssertionError", case["message"])

    def test_a_non_assertion_exception_is_errored(self):
        case = self.cases["test_an_exception_is_an_error"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("ValueError", case["message"])
        self.assertIn("the query is not written yet", case["message"])

    def test_a_fixture_that_raises_is_one_errored_case(self):
        case = self.cases["test_a_broken_fixture_is_an_error"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("the fixture could not build its rows", case["message"])

    def test_a_skip_records_nothing(self):
        # unittest's JsonResult does not override addSkip, so a skip is not a
        # row there either. Two harnesses, one meaning.
        self.assertNotIn("test_a_skip_is_not_a_result", self.cases)

    def test_the_counts_add_up(self):
        self.assertEqual(self.tests["total"], len(self.tests["cases"]))
        self.assertEqual(
            self.tests["total"],
            self.tests["passed"] + self.tests["failed"] + self.tests["errored"],
        )
        self.assertEqual(self.tests["failed"], 1)
        self.assertEqual(self.tests["errored"], 2)

    def test_frames_are_workspace_relative_and_carry_the_source_line(self):
        case = self.cases["test_a_failing_assertion_is_a_failure"]
        frame = case["frames"][0]
        self.assertEqual(frame["path"], "tests/test_overdue.py")
        self.assertEqual(
            frame["line"], line_of(SUITE_PY, 'assert overdue(ROWS, "2026-03-01") == []')
        )
        self.assertIn("assert overdue(ROWS", frame["snippet"])

    def test_a_frame_reaches_the_file_the_error_came_from(self):
        paths = [f["path"] for f in self.cases["test_an_exception_is_an_error"]["frames"]]
        self.assertIn("repository.py", paths)

    def test_no_case_carries_a_step_when_the_job_names_no_run(self):
        for case in self.tests["cases"]:
            self.assertNotIn("step", case)


class PytestRunIdTest(unittest.TestCase):
    def test_every_case_is_stamped_with_the_run_it_came_from(self):
        # A phase that spans two languages is two jobs, and the API merges their
        # cases into one list. Without the stamp the Tests pane cannot group them.
        result = execute_job(
            pytest_job(
                {"repository.py": OVERDUE_PY, "tests/test_overdue.py": SUITE_PY},
                ["tests"],
                runId="api",
            )
        )
        self.assertTrue(result["tests"]["cases"])
        for case in result["tests"]["cases"]:
            self.assertEqual(case["step"], "api")


BROKEN_IMPORT_PY = '''import repository_that_is_not_here


def test_never_reached():
    assert True
'''


class PytestImportErrorTest(unittest.TestCase):
    """A file that will not import is one errored case, not an empty suite."""

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            pytest_job(
                {
                    "repository.py": OVERDUE_PY,
                    "tests/test_broken.py": BROKEN_IMPORT_PY,
                    "tests/test_fine.py": (
                        "from repository import overdue\n\n\n"
                        "def test_the_rest_of_the_suite_still_runs():\n"
                        "    assert overdue([], '2026-01-01') == []\n"
                    ),
                },
                ["tests"],
            )
        )
        cls.tests = cls.result["tests"]
        cls.cases = by_name(cls.tests)

    def test_the_broken_file_is_one_errored_case_named_after_the_file(self):
        case = self.cases["tests/test_broken.py"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("repository_that_is_not_here", case["message"])

    def test_the_broken_file_produces_exactly_one_case(self):
        named = [c for c in self.tests["cases"] if c["name"] == "tests/test_broken.py"]
        self.assertEqual(len(named), 1)

    def test_the_rest_of_the_suite_still_ran(self):
        # pytest stops at the first collection error unless it is told not to.
        # The unittest and JS harnesses both report the rest, and a learner
        # comparing two layers must not meet two different rules.
        self.assertEqual(self.cases["test_the_rest_of_the_suite_still_runs"]["status"], "passed")

    def test_the_run_is_not_reported_as_a_pass(self):
        self.assertFalse(self.result["ok"])
        self.assertEqual(self.tests["errored"], 1)

    def test_the_workspace_root_is_absent_from_the_whole_payload(self):
        payload = json.dumps(self.result)
        self.assertNotIn("lsdlc-", payload)
        self.assertNotIn(tempfile.gettempdir(), payload)


BLOCKED_PROBE_PY = '''import socket


def test_socketpair_is_blocked():
    try:
        socket.socketpair()
    except RuntimeError as exc:
        assert "network access is disabled" in str(exc)
    else:
        raise AssertionError("socketpair was not blocked")


def test_opening_a_connection_is_blocked():
    try:
        socket.create_connection(("example.com", 80), timeout=1)
    except RuntimeError as exc:
        assert "network access is disabled" in str(exc)
    else:
        raise AssertionError("create_connection was not blocked")


def test_ctypes_is_blocked():
    try:
        import ctypes  # noqa: F401
    except ImportError as exc:
        assert "not available in the LearnSDLC sandbox" in str(exc)
    else:
        raise AssertionError("ctypes was importable")
'''

BLOCKED_PROBE_UNITTEST_PY = '''import socket
import unittest


class TestBlocked(unittest.TestCase):
    def test_socketpair_is_blocked(self):
        with self.assertRaises(RuntimeError):
            socket.socketpair()

    def test_ctypes_is_blocked(self):
        with self.assertRaises(ImportError):
            import ctypes  # noqa: F401
'''


class BlocklistHoldsUnderBothHarnessesTest(unittest.TestCase):
    """The network is shut under pytest exactly as it is under unittest.

    pytest imports a great deal more than unittest does, and it is imported
    after the blocklist is installed. This is the test that says the blocklist
    survived that.
    """

    def test_the_pytest_harness_still_blocks_the_network_and_ctypes(self):
        result = execute_job(pytest_job({"tests/test_blocked.py": BLOCKED_PROBE_PY}, ["tests"]))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 3)

    def test_the_unittest_harness_still_blocks_the_network_and_ctypes(self):
        result = execute_job(
            {
                "files": {"tests/test_blocked.py": BLOCKED_PROBE_UNITTEST_PY},
                "mode": "tests",
                "testPaths": ["tests/test_blocked.py"],
                "language": "python",
                "timeoutSeconds": 30,
                "memoryMb": 256,
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 2)


FLASK_APP_PY = '''"""The shape of the canonical application's API, in one file."""

from flask import Flask, jsonify

TASKS = [
    {"id": 1, "title": "write the report", "due_date": "2026-01-01", "status": "open"},
    {"id": 2, "title": "read the brief", "due_date": None, "status": "open"},
]


def create_app():
    app = Flask(__name__)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "version": "2.0.0"})

    @app.get("/api/tasks/overdue")
    def overdue():
        today = "2026-03-01"
        return jsonify([t for t in TASKS if t["due_date"] and t["due_date"] < today])

    return app
'''

FLASK_SUITE_PY = '''import socket

import pytest

from app import create_app


@pytest.fixture
def client():
    return create_app().test_client()


def test_health_answers(client):
    assert client.get("/api/health").get_json() == {"status": "ok", "version": "2.0.0"}


def test_overdue_leaves_out_a_task_with_no_due_date(client):
    body = client.get("/api/tasks/overdue").get_json()
    assert [task["id"] for task in body] == [1]


def test_the_network_is_still_shut_with_flask_loaded():
    with pytest.raises(RuntimeError):
        socket.socket()
    with pytest.raises(RuntimeError):
        socket.create_connection(("example.com", 80))


def test_ssl_did_not_smuggle_a_usable_socket_in():
    import ssl

    with pytest.raises(RuntimeError):
        ssl.socket()
    # ssl.SSLSocket subclasses whatever socket.socket is at the time ssl is
    # imported. If that were still the real class, this would build one.
    with pytest.raises(RuntimeError):
        ssl.SSLSocket.__mro__[1]()
'''


class FlaskUnderTheSandboxTest(unittest.TestCase):
    """The reason the reference application is Flask: it runs with no socket at all.

    Flask's test client is in-process WSGI, so a graded API run opens nothing.
    Getting there needs one thing from the blocklist: `ssl.py`
    subclasses socket.socket at import time and werkzeug imports ssl through
    werkzeug.serving, so a socket constructor that is a function rather than an
    inert class makes the whole of Flask unimportable four frames inside the
    standard library. This is the test that says the pack's API layer runs.
    """

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            pytest_job(
                {"app.py": FLASK_APP_PY, "tests/test_app.py": FLASK_SUITE_PY},
                ["tests"],
            )
        )
        cls.cases = by_name(cls.result["tests"])

    def test_the_suite_ran_and_passed(self):
        self.assertTrue(self.result["ok"], self.result)
        self.assertEqual(self.result["tests"]["total"], 4)
        self.assertEqual(self.result["tests"]["passed"], 4)

    def test_the_api_answered_through_flasks_test_client(self):
        self.assertEqual(self.cases["test_health_answers"]["status"], "passed")
        self.assertEqual(
            self.cases["test_overdue_leaves_out_a_task_with_no_due_date"]["status"], "passed"
        )

    def test_the_network_stayed_shut(self):
        self.assertEqual(
            self.cases["test_the_network_is_still_shut_with_flask_loaded"]["status"], "passed"
        )
        self.assertEqual(
            self.cases["test_ssl_did_not_smuggle_a_usable_socket_in"]["status"], "passed"
        )


class PytestCacheTest(unittest.TestCase):
    """pytest writes .pytest_cache unless told not to, and it must not.

    RLIMIT_FSIZE and a read-only runner image both make that write a failure,
    and a failure there fails the run rather than the test. Asserted against the
    workspace itself, which means driving the child directly: execute_job
    deletes the workspace on its way out, which is the whole point of it.
    """

    def test_the_child_writes_no_cache_directory_into_the_workspace(self):
        workspace = tempfile.mkdtemp(prefix="lsdlc-cache-probe-")
        try:
            os.makedirs(os.path.join(workspace, "tests"))
            with open(os.path.join(workspace, "tests", "test_one.py"), "w") as fh:
                fh.write("def test_one():\n    assert True\n")
            spec = json.dumps({"testPaths": ["tests"], "gradedDir": "", "gradedTestPaths": []})
            code, stdout, stderr, kind = run_child(
                [sys.executable, "-I", "-S", "-B", "-c", PYTEST_BOOTSTRAP, spec],
                workspace, 30, 256,
            )
            self.assertEqual(kind, "ok", stderr)
            tests = parse_result_line(stdout)
            self.assertIsNotNone(tests, stdout + stderr)
            self.assertEqual(tests["passed"], 1)
            written = set()
            for dirpath, dirnames, filenames in os.walk(workspace):
                written.update(dirnames)
                written.update(filenames)
            self.assertNotIn(".pytest_cache", written)
            self.assertNotIn("__pycache__", written)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    def test_the_child_is_given_the_pre_baked_library_directory(self):
        env = child_env("/tmp/does-not-matter")
        self.assertEqual(env["LSDLC_PYLIB"], runtime_site_packages())


# ---------------------------------------------------------------------------
# The seal, under pytest. Ported from test_runner.py's GradedFilesTest,
# GradedShadowTest and GradedTeardownTest: a suite that can read the
# implementation it is scored against knows which bug was planted without
# writing a test that finds it, and would score full marks on mutation while
# nothing failed.
# ---------------------------------------------------------------------------

GRADED_MANAGER_PY = '''"""The graded implementation. A learner is scored against it, never shown it."""


class TaskManager:
    def __init__(self):
        self._tasks = {}
        self._next_id = 1

    def add_task(self, title):
        task = {"id": self._next_id, "title": title, "completed": False}
        self._tasks[task["id"]] = task
        self._next_id += 1
        return task
'''

GRADED_PROBE_PY = '''import os
import sys

from tasktrackr.manager import TaskManager


def test_the_implementation_still_imports():
    assert TaskManager().add_task("a")["id"] == 1


def test_reading_the_implementation_by_its_own_path():
    with open("tasktrackr/manager.py") as fh:
        fh.read()


def test_reading_the_implementation_where_it_really_is():
    directories = [entry for entry in sys.path if "lsdlc-graded-" in entry]
    assert directories, "the graded directory was never on sys.path"
    for directory in directories:
        with open(os.path.join(directory, "tasktrackr", "manager.py")) as fh:
            fh.read()


def test_reading_it_out_of_the_module():
    import tasktrackr.manager

    with open(tasktrackr.manager.__file__) as fh:
        fh.read()
'''


class PytestGradedFilesTest(unittest.TestCase):
    """One pytest suite that imports the graded implementation, then reads it."""

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            pytest_job(
                {"tests/test_probe.py": GRADED_PROBE_PY},
                ["tests/test_probe.py"],
                gradedFiles={
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": GRADED_MANAGER_PY,
                },
            )
        )
        cls.cases = by_name(cls.result["tests"])

    def test_the_suite_ran_against_the_graded_implementation(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertEqual(self.cases["test_the_implementation_still_imports"]["status"], "passed")

    def test_the_implementation_is_not_at_the_path_it_imports_from(self):
        case = self.cases["test_reading_the_implementation_by_its_own_path"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("FileNotFoundError", case["message"])
        self.assertIn("tasktrackr/manager.py", case["message"])

    def test_the_implementation_is_not_where_the_import_path_says_either(self):
        case = self.cases["test_reading_the_implementation_where_it_really_is"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("FileNotFoundError", case["message"])

    def test_the_module_names_a_file_that_no_longer_exists(self):
        case = self.cases["test_reading_it_out_of_the_module"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("FileNotFoundError", case["message"])

    def test_the_graded_path_never_reaches_the_report(self):
        self.assertNotIn("lsdlc-graded-", json.dumps(self.result))


class PytestGradedShadowTest(unittest.TestCase):
    """A workspace copy of a graded file must not shadow the graded one."""

    def test_the_graded_implementation_wins(self):
        result = execute_job(
            pytest_job(
                {
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": GRADED_MANAGER_PY.replace(
                        "self._next_id = 1", "self._next_id = 99"
                    ),
                    "tests/test_probe.py": (
                        "from tasktrackr.manager import TaskManager\n\n\n"
                        "def test_first_id():\n"
                        "    assert TaskManager().add_task('a')['id'] == 1\n"
                    ),
                },
                ["tests/test_probe.py"],
                gradedFiles={
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": GRADED_MANAGER_PY,
                },
            )
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


class PytestGradedTeardownTest(unittest.TestCase):
    def test_the_graded_directory_does_not_outlive_the_job(self):
        # Its own temp root, so the assertion is about the directories this job
        # made and not about whatever else the machine is running.
        home = tempfile.mkdtemp(prefix="lsdlc-teardown-")
        previous = tempfile.tempdir
        tempfile.tempdir = home
        try:
            execute_job(
                pytest_job(
                    {"tests/test_probe.py": GRADED_PROBE_PY},
                    ["tests/test_probe.py"],
                    gradedFiles={
                        "tasktrackr/__init__.py": "",
                        "tasktrackr/manager.py": GRADED_MANAGER_PY,
                    },
                )
            )
        finally:
            tempfile.tempdir = previous
        try:
            self.assertEqual(os.listdir(home), [])
        finally:
            shutil.rmtree(home, ignore_errors=True)


class PytestSealedTestPathTest(unittest.TestCase):
    def test_a_sealed_test_file_is_refused_rather_than_silently_empty(self):
        # pytest collects from paths, and the seal deletes the file before it
        # gets there. A phase that needs a sealed suite says
        # hiddenHarness: "unittest", which is the harness whose seal is proved.
        with self.assertRaises(ValueError) as caught:
            execute_job(
                pytest_job(
                    {"tests/test_visible.py": "def test_ok():\n    assert True\n"},
                    ["tests/test_visible.py", "tests/test_hidden.py"],
                    gradedFiles={"tests/test_hidden.py": "def test_hidden():\n    assert True\n"},
                )
            )
        self.assertIn("hiddenHarness", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
