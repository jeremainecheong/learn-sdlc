"""Tests for the structured result the sandbox runner hands back.

Every fixture is written inline and passed to execute_job as a job dict (the
same payload SandboxService.execute posts), so these tests exercise the real
child process, the real harnesses and the real workspace teardown rather than
a stand-in. The Python jobs run once per class and are asserted case by case,
because each job is a process spawn.
"""

import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sandbox_runner  # noqa: E402
from sandbox_runner import (  # noqa: E402
    PREBAKE_MISSING_MESSAGE,
    child_env,
    execute_job,
    harness_for,
    limits_address_space,
    parse_result_line,
    reap_group,
    redact_workspace,
    runtime_esbuild,
    runtime_node_modules,
    runtime_root,
    runtime_site_packages,
    spawn_child,
)

RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sandbox_runner.py")

# The child's PATH is scrubbed to these three directories, so a node outside
# them is invisible to the job unless NODE_BIN names it outright.
CHILD_PATH = "/usr/local/bin:/usr/bin:/bin"

MANAGER_PY = '''"""The slice of the tasktrackr manager these fixtures need."""


class TaskManager:
    def __init__(self):
        self._tasks = {}
        self._next_id = 1

    def add_task(self, title):
        task = {"id": self._next_id, "title": title, "completed": False}
        self._tasks[task["id"]] = task
        self._next_id += 1
        return task

    def complete_task(self, task_id):
        task = self._tasks[task_id]
        assert not task["completed"], f"task {task_id} is already complete"
        task["completed"] = True
        return task

    def overdue_tasks(self, today):
        return [task for task in self._tasks.values() if task["due"] < today]

    def dig(self, depth):
        if depth == 0:
            raise ValueError("bottom of the stack")
        return self.dig(depth - 1)

    def wide_failure(self):
        raise ValueError("a wide line")  # padded out past the snippet limit so the trim has something to bite on, xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
'''

WIDE_LINE = next(
    line.strip() for line in MANAGER_PY.splitlines() if "wide line" in line and "raise" in line
)

TEST_VISIBLE_PY = '''import os
import unittest

from tasktrackr.manager import TaskManager


class TestTaskManager(unittest.TestCase):
    def test_add_assigns_incrementing_ids(self):
        manager = TaskManager()
        self.assertEqual((manager.add_task("a")["id"], manager.add_task("b")["id"]), (1, 2))

    def test_complete_twice_is_rejected(self):
        manager = TaskManager()
        task = manager.add_task("Write report")
        self.assertTrue(manager.complete_task(task["id"])["completed"])
        manager.complete_task(task["id"])  # the second completion raises

    def test_title_is_normalised(self):
        manager = TaskManager()
        self.assertEqual(manager.add_task("Write report")["title"], "write report")

    def test_overdue_reads_the_due_date(self):
        manager = TaskManager()
        manager.add_task("Write report")
        manager.overdue_tasks("2026-09-03")

    def test_priority_parses(self):
        int("high")  # an error in the test file itself

    def test_data_file_is_seeded(self):
        with open(os.environ["TASKTRACKR_DATA"], encoding="utf-8") as handle:
            handle.read()

    def test_deep_call_keeps_five_frames(self):
        TaskManager().dig(20)

    def test_wide_line_is_trimmed(self):
        TaskManager().wide_failure()
'''

MANAGER_JS = '''class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.nextId = 1;
  }

  addTask(title) {
    const task = { id: this.nextId++, title, completed: false };
    this.tasks.set(task.id, task);
    return task;
  }

  completeTask(id) {
    const task = this.tasks.get(id);
    if (task.completed) throw new Error(`task ${id} is already complete`);
    task.completed = true;
    return task;
  }

  dig(depth) {
    if (depth === 0) throw new Error('bottom of the stack');
    return this.dig(depth - 1);
  }
}

module.exports = { TaskManager };
'''

TEST_VISIBLE_JS = '''const { TaskManager } = require('./tasktrackr/manager');

test('add assigns incrementing ids', () => {
  const manager = new TaskManager();
  assert.strictEqual(manager.addTask('a').id, 1);
  assert.strictEqual(manager.addTask('b').id, 2);
});

test('completing twice is rejected', () => {
  const manager = new TaskManager();
  const task = manager.addTask('Write report');
  manager.completeTask(task.id);
  manager.completeTask(task.id); // the second completion throws
});

test('title is normalised', () => {
  const manager = new TaskManager();
  assert.strictEqual(manager.addTask('Write report').title, 'write report');
});

test('a deep call keeps five frames', () => {
  new TaskManager().dig(20);
});
'''


def line_of(source, needle):
    """The 1-based line carrying needle, so no assertion hardcodes a number."""
    for number, text in enumerate(source.splitlines(), start=1):
        if needle in text:
            return number
    raise AssertionError(f"fixture has no line containing {needle!r}")


def by_method(tests):
    return {case["name"].split(".")[-1]: case for case in tests["cases"]}


def node_bin():
    return shutil.which("node", path=CHILD_PATH) or shutil.which("node")


def python_tests_job(files, test_paths):
    return {
        "files": files,
        "mode": "tests",
        "testPaths": test_paths,
        "language": "python",
        "timeoutSeconds": 20,
        "memoryMb": 256,
    }


class PythonFramesTest(unittest.TestCase):
    """One failing suite, asserted case by case."""

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            python_tests_job(
                {
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": MANAGER_PY,
                    "test_visible.py": TEST_VISIBLE_PY,
                },
                ["test_visible.py"],
            )
        )
        cls.tests = cls.result["tests"]
        cls.cases = by_method(cls.tests)

    def test_the_suite_ran_and_failed(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertFalse(self.result["ok"])
        self.assertEqual(
            (self.tests["total"], self.tests["passed"], self.tests["failed"], self.tests["errored"]),
            (8, 1, 2, 5),
        )

    def test_a_pass_carries_a_duration_and_no_frames(self):
        case = self.cases["test_add_assigns_incrementing_ids"]
        self.assertEqual(case["status"], "passed")
        self.assertNotIn("frames", case)
        self.assertNotIn("message", case)
        self.assertIsInstance(case["durationMs"], int)
        self.assertGreaterEqual(case["durationMs"], 0)

    def test_every_case_carries_a_duration(self):
        for case in self.tests["cases"]:
            self.assertIsInstance(case.get("durationMs"), int, case["name"])
        self.assertLessEqual(
            sum(case["durationMs"] for case in self.tests["cases"]),
            self.result["durationMs"],
        )

    def test_a_failure_inside_the_module_names_the_module_first(self):
        case = self.cases["test_complete_twice_is_rejected"]
        self.assertEqual(case["status"], "failed")
        self.assertEqual(case["message"], "AssertionError: task 1 is already complete")
        frames = case["frames"]
        self.assertEqual(frames[0]["path"], "tasktrackr/manager.py")
        self.assertEqual(frames[0]["line"], line_of(MANAGER_PY, 'assert not task["completed"]'))
        self.assertEqual(frames[0]["snippet"], 'assert not task["completed"], f"task {task_id} is already complete"')
        self.assertEqual(frames[1]["path"], "test_visible.py")
        self.assertEqual(
            frames[1]["line"], line_of(TEST_VISIBLE_PY, "# the second completion raises")
        )
        self.assertIn("complete_task", frames[1]["snippet"])

    def test_an_assertion_in_the_test_file_names_only_the_test_file(self):
        case = self.cases["test_title_is_normalised"]
        self.assertEqual(case["status"], "failed")
        self.assertEqual(
            case["frames"],
            [
                {
                    "path": "test_visible.py",
                    "line": line_of(TEST_VISIBLE_PY, '"write report")'),
                    "snippet": 'self.assertEqual(manager.add_task("Write report")["title"], "write report")',
                }
            ],
        )

    def test_an_error_in_the_test_file_is_errored_with_its_own_frame(self):
        case = self.cases["test_priority_parses"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("ValueError", case["message"])
        self.assertEqual(
            case["frames"],
            [
                {
                    "path": "test_visible.py",
                    "line": line_of(TEST_VISIBLE_PY, "an error in the test file itself"),
                    "snippet": 'int("high")  # an error in the test file itself',
                }
            ],
        )

    def test_an_error_raised_deeper_keeps_the_whole_path(self):
        case = self.cases["test_overdue_reads_the_due_date"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("KeyError", case["message"])
        paths = [frame["path"] for frame in case["frames"]]
        self.assertEqual(paths[0], "tasktrackr/manager.py")
        self.assertEqual(paths[-1], "test_visible.py")

    def test_frames_are_capped_at_five_deepest_first(self):
        case = self.cases["test_deep_call_keeps_five_frames"]
        frames = case["frames"]
        self.assertEqual(len(frames), 5)
        self.assertEqual({frame["path"] for frame in frames}, {"tasktrackr/manager.py"})
        self.assertEqual(frames[0]["snippet"], 'raise ValueError("bottom of the stack")')
        self.assertEqual(
            [frame["snippet"] for frame in frames[1:]],
            ["return self.dig(depth - 1)"] * 4,
        )

    def test_nothing_leaks_the_workspace_temp_directory(self):
        serialised = json.dumps(self.result)
        self.assertNotIn("lsdlc-", serialised)
        for case in self.tests["cases"]:
            for frame in case.get("frames", []):
                self.assertFalse(frame["path"].startswith(os.sep), frame["path"])
                self.assertNotIn("..", frame["path"])

    def test_an_absolute_path_in_a_message_is_reduced_to_the_workspace(self):
        case = self.cases["test_data_file_is_seeded"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("FileNotFoundError", case["message"])
        self.assertIn("'tasks.json'", case["message"])
        self.assertNotIn("lsdlc-", case["message"])

    def test_snippets_are_trimmed_to_160_characters(self):
        for case in self.tests["cases"]:
            for frame in case.get("frames", []):
                self.assertLessEqual(len(frame["snippet"]), 160)
                self.assertEqual(frame["snippet"], frame["snippet"].strip())
        # A source line that is genuinely longer than the limit, so the cap is
        # exercised and not merely satisfied by short fixtures.
        self.assertGreater(len(WIDE_LINE), 160)
        snippet = self.cases["test_wide_line_is_trimmed"]["frames"][0]["snippet"]
        self.assertEqual(snippet, WIDE_LINE[:160])


class PythonPassingSuiteTest(unittest.TestCase):
    def test_a_passing_suite_reports_ok_with_no_frames(self):
        result = execute_job(
            python_tests_job(
                {
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": MANAGER_PY,
                    "test_visible.py": (
                        "import unittest\n\n"
                        "from tasktrackr.manager import TaskManager\n\n\n"
                        "class TestAdd(unittest.TestCase):\n"
                        "    def test_add_assigns_the_first_id(self):\n"
                        '        self.assertEqual(TaskManager().add_task("a")["id"], 1)\n'
                    ),
                },
                ["test_visible.py"],
            )
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["exitKind"], "ok")
        self.assertEqual(result["stdout"], "")
        self.assertEqual(
            (result["tests"]["total"], result["tests"]["passed"], result["tests"]["failed"]),
            (1, 1, 0),
        )
        case = result["tests"]["cases"][0]
        self.assertEqual(case["name"], "TestAdd.test_add_assigns_the_first_id")
        self.assertNotIn("frames", case)


class HarnessCrashTest(unittest.TestCase):
    """A harness that dies before its result line is not a failing suite."""

    def test_no_result_line_is_an_error_with_tests_null(self):
        result = execute_job(
            python_tests_job(
                {
                    "test_visible.py": (
                        "import os\n"
                        "import unittest\n\n\n"
                        "class TestCrash(unittest.TestCase):\n"
                        "    def test_the_interpreter_dies_mid_suite(self):\n"
                        "        os._exit(0)\n"
                    )
                },
                ["test_visible.py"],
            )
        )
        self.assertEqual(result["exitKind"], "error")
        self.assertIsNone(result["tests"])
        self.assertFalse(result["ok"])

    def test_a_failing_suite_stays_exit_kind_ok(self):
        result = execute_job(
            python_tests_job(
                {
                    "test_visible.py": (
                        "import unittest\n\n\n"
                        "class TestFails(unittest.TestCase):\n"
                        "    def test_one_plus_one(self):\n"
                        "        self.assertEqual(1 + 1, 3)\n"
                    )
                },
                ["test_visible.py"],
            )
        )
        self.assertEqual(result["exitKind"], "ok")
        self.assertFalse(result["ok"])
        self.assertEqual(result["tests"]["failed"], 1)

    def test_a_printed_half_written_marker_does_not_stand_in_for_the_result(self):
        result = execute_job(
            python_tests_job(
                {
                    "test_visible.py": (
                        "import unittest\n\n\n"
                        "class TestNoisy(unittest.TestCase):\n"
                        "    def test_prints_a_truncated_marker(self):\n"
                        "        print('@@LSDLC_RESULT@@{\"total\": 99, \"passed\": 99')\n"
                    )
                },
                ["test_visible.py"],
            )
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["tests"]["total"], 1)
        self.assertEqual(result["stdout"], "")


class ResourceKillTest(unittest.TestCase):
    """A child that died on a limit says which limit, not just "it stopped".

    Both signals are raised outright rather than provoked: RLIMIT_AS is a soft
    fallback on macOS (it surfaces as MemoryError, not a kill) and burning the
    CPU rlimit would add twenty seconds to the suite. The runner reads the
    signal, so sending it is the same input either way.
    """

    def _job_that_signals_itself(self, signal_name):
        return python_tests_job(
            {
                "test_visible.py": (
                    "import os\n"
                    "import signal\n"
                    "import unittest\n\n\n"
                    "class TestKilled(unittest.TestCase):\n"
                    "    def test_the_child_hits_a_limit(self):\n"
                    f"        os.kill(os.getpid(), signal.{signal_name})\n"
                )
            },
            ["test_visible.py"],
        )

    def test_a_sigkill_is_reported_as_memory(self):
        result = execute_job(self._job_that_signals_itself("SIGKILL"))
        self.assertEqual(result["exitKind"], "memory")
        self.assertIsNone(result["tests"])
        self.assertFalse(result["ok"])

    def test_a_sigxcpu_is_reported_as_timeout(self):
        result = execute_job(self._job_that_signals_itself("SIGXCPU"))
        self.assertEqual(result["exitKind"], "timeout")
        self.assertIsNone(result["tests"])
        self.assertFalse(result["ok"])


@unittest.skipUnless(node_bin(), "no node binary on PATH")
class JavaScriptFramesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._node = os.environ.get("NODE_BIN")
        os.environ["NODE_BIN"] = node_bin()
        cls.result = execute_job(
            {
                "files": {
                    "tasktrackr/manager.js": MANAGER_JS,
                    "test_visible.js": TEST_VISIBLE_JS,
                },
                "mode": "tests",
                "testPaths": ["test_visible.js"],
                "language": "javascript",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        cls.cases = {case["name"]: case for case in cls.result["tests"]["cases"]}

    @classmethod
    def tearDownClass(cls):
        if cls._node is None:
            os.environ.pop("NODE_BIN", None)
        else:
            os.environ["NODE_BIN"] = cls._node

    def test_the_suite_ran(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertFalse(self.result["ok"])
        tests = self.result["tests"]
        self.assertEqual((tests["total"], tests["passed"], tests["failed"], tests["errored"]), (4, 1, 1, 2))

    def test_a_throw_inside_the_module_names_the_module_first(self):
        case = self.cases["completing twice is rejected"]
        self.assertEqual(case["status"], "errored")
        self.assertEqual(case["message"], "task 1 is already complete")
        frames = case["frames"]
        self.assertEqual(frames[0]["path"], "tasktrackr/manager.js")
        self.assertEqual(frames[0]["line"], line_of(MANAGER_JS, "already complete"))
        self.assertIn("already complete", frames[0]["snippet"])
        self.assertEqual(frames[1]["path"], "test_visible.js")
        self.assertEqual(frames[1]["line"], line_of(TEST_VISIBLE_JS, "// the second completion throws"))

    def test_an_assertion_failure_names_the_test_file(self):
        case = self.cases["title is normalised"]
        self.assertEqual(case["status"], "failed")
        frames = case["frames"]
        self.assertEqual(frames[0]["path"], "test_visible.js")
        self.assertEqual(frames[0]["line"], line_of(TEST_VISIBLE_JS, "'write report'"))
        self.assertIn("write report", frames[0]["snippet"])

    def test_the_harness_never_appears_in_a_frame(self):
        for case in self.result["tests"]["cases"]:
            for frame in case.get("frames", []):
                self.assertNotIn("_lsdlc_harness", frame["path"])
                self.assertFalse(frame["path"].startswith(os.sep), frame["path"])
        self.assertNotIn("lsdlc-", json.dumps(self.result["tests"]))

    def test_a_pass_has_a_duration_and_no_frames(self):
        case = self.cases["add assigns incrementing ids"]
        self.assertEqual(case["status"], "passed")
        self.assertNotIn("frames", case)
        self.assertIsInstance(case["durationMs"], int)

    def test_frames_are_capped_at_five_deepest_first(self):
        frames = self.cases["a deep call keeps five frames"]["frames"]
        self.assertEqual(len(frames), 5)
        self.assertEqual(frames[0]["path"], "tasktrackr/manager.js")
        self.assertEqual(frames[0]["snippet"], "if (depth === 0) throw new Error('bottom of the stack');")
        self.assertEqual(
            [frame["snippet"] for frame in frames[1:]],
            ["return this.dig(depth - 1);"] * 4,
        )

    def test_snippets_are_trimmed(self):
        for case in self.result["tests"]["cases"]:
            for frame in case.get("frames", []):
                self.assertLessEqual(len(frame["snippet"]), 160)
                self.assertEqual(frame["snippet"], frame["snippet"].strip())


@unittest.skipUnless(node_bin(), "no node binary on PATH")
class JavaScriptLoadErrorTest(unittest.TestCase):
    def test_a_file_that_cannot_load_is_an_errored_case(self):
        node = os.environ.get("NODE_BIN")
        os.environ["NODE_BIN"] = node_bin()
        try:
            result = execute_job(
                {
                    "files": {"test_visible.js": "const gone = require('./tasktrackr/missing');\n"},
                    "mode": "tests",
                    "testPaths": ["test_visible.js"],
                    "language": "javascript",
                    "timeoutSeconds": 20,
                    "memoryMb": 256,
                }
            )
        finally:
            if node is None:
                os.environ.pop("NODE_BIN", None)
            else:
                os.environ["NODE_BIN"] = node
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitKind"], "ok")
        self.assertEqual(result["tests"]["errored"], 1)
        case = result["tests"]["cases"][0]
        self.assertEqual(case["name"], "test_visible.js")
        self.assertEqual(case["status"], "errored")
        self.assertNotIn("lsdlc-", case["message"])
        self.assertNotIn("lsdlc-", result["stderr"])
        self.assertEqual(
            [frame["path"] for frame in case.get("frames", [])], ["test_visible.js"]
        )


class SmokeModeTest(unittest.TestCase):
    def test_a_smoke_run_still_reports_output_and_a_duration(self):
        result = execute_job(
            {
                "files": {"cli.py": "print('added [ ] #1 Write report')\n"},
                "mode": "smoke",
                "smokeCommands": [["python3", "cli.py"]],
                "expectInOutput": "added",
                "language": "python",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["exitKind"], "ok")
        self.assertIn("added [ ] #1 Write report", result["stdout"])
        self.assertNotIn("tests", result)
        self.assertIsInstance(result["durationMs"], int)


class ResultLineTest(unittest.TestCase):
    def test_only_a_complete_result_object_counts(self):
        marker = "@@LSDLC_RESULT@@"
        self.assertIsNone(parse_result_line("nothing to see"))
        self.assertIsNone(parse_result_line(marker + '{"total": 1'))
        self.assertIsNone(parse_result_line(marker + '"a bare string"'))
        self.assertIsNone(
            parse_result_line(marker + '{"total": 1, "passed": 1, "failed": 0, "errored": 0}')
        )
        payload = parse_result_line(
            "chatter\n" + marker + '{"total":0,"passed":0,"failed":0,"errored":0,"cases":[]}'
        )
        self.assertEqual(payload["total"], 0)

    def test_the_last_complete_line_wins(self):
        marker = "@@LSDLC_RESULT@@"
        stdout = "\n".join(
            [
                marker + '{"total":9,"passed":9,"failed":0,"errored":0,"cases":[]}',
                marker + '{"total":1,"passed":0,"failed":1,"errored":0,"cases":[]}',
            ]
        )
        self.assertEqual(parse_result_line(stdout)["failed"], 1)


class RedactionTest(unittest.TestCase):
    def test_both_forms_of_the_workspace_path_are_stripped(self):
        resolved = "/private/var/folders/qq/T/lsdlc-abc"
        symlinked = "/var/folders/qq/T/lsdlc-abc"
        roots = sorted({resolved, symlinked}, key=len, reverse=True)
        payload = {
            "stderr": f'File "{resolved}/cli.py", line 3',
            "cases": [{"message": f"No such file or directory: '{symlinked}/tasks.json'"}],
            "durationMs": 12,
            "tests": None,
        }
        redacted = redact_workspace(payload, roots)
        self.assertEqual(redacted["stderr"], 'File "cli.py", line 3')
        self.assertEqual(
            redacted["cases"][0]["message"], "No such file or directory: 'tasks.json'"
        )
        self.assertEqual(redacted["durationMs"], 12)
        self.assertIsNone(redacted["tests"])

    def test_the_bare_root_becomes_a_dot(self):
        self.assertEqual(redact_workspace("cwd is /tmp/lsdlc-1", ["/tmp/lsdlc-1"]), "cwd is .")

    def test_the_interpreter_path_becomes_the_command_word(self):
        # A failed smoke run prints the interpreter that failed. That path is
        # the host's home directory on a laptop and the image's on the server;
        # the learner has neither.
        message = f"{sys.executable}: can't open file '/tmp/lsdlc-1/cli.py'"
        self.assertEqual(
            redact_workspace(message, ["/tmp/lsdlc-1"]),
            "python3: can't open file 'cli.py'",
        )

    def test_the_pre_baked_layer_becomes_the_word_sandbox(self):
        # A pytest collection error inside flask, or a React stack through the
        # baked react-dom, otherwise prints an absolute path that is ours and
        # not the learner's, and a different one on every machine, so the same
        # failure reads differently on a laptop and in the container.
        message = f'File "{runtime_root()}/python/flask/app.py", line 12'
        self.assertEqual(
            redact_workspace(message, ["/tmp/lsdlc-1"]),
            'File "sandbox/python/flask/app.py", line 12',
        )

    def test_the_esbuild_binary_keeps_its_command_word(self):
        # Named before the tree it sits inside, or "esbuild: permission denied"
        # comes back as "sandbox/bin/esbuild: permission denied", still a path
        # the learner cannot use. Swap the two appends and this goes red.
        esbuild = runtime_esbuild()
        if esbuild is None:
            self.skipTest("no pre-baked runtime: run `node scripts/prebake.mjs build` first")
        self.assertEqual(
            redact_workspace(f"{esbuild}: permission denied", ["/tmp/lsdlc-1"]),
            "esbuild: permission denied",
        )


class StdinCliTest(unittest.TestCase):
    """The documented entry point: a job on stdin, one JSON object on stdout."""

    def test_the_cli_round_trips_a_job(self):
        job = python_tests_job(
            {
                "tasktrackr/__init__.py": "",
                "tasktrackr/manager.py": MANAGER_PY,
                "test_visible.py": TEST_VISIBLE_PY,
            },
            ["test_visible.py"],
        )
        proc = subprocess.run(
            [sys.executable, RUNNER],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        # execute_job stamps every answer with the supervisor's diagnostics and
        # the isolation it ran under, so both are part of the CLI's shape.
        self.assertEqual(
            sorted(result.keys()),
            ["diagnostics", "durationMs", "exitKind", "isolation", "ok", "stderr", "stdout", "tests"],
        )
        case = by_method(result["tests"])["test_complete_twice_is_rejected"]
        self.assertEqual(case["frames"][0]["path"], "tasktrackr/manager.py")


# ---------------------------------------------------------------------------
# Graded artefacts: the implementation a learner is scored against, the
# planted mutants and the hidden suite share a process with the learner's tests
# but must not share a filesystem with them.
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

# The suite a learner could hand in to find out which bug was planted rather
# than to catch it: import the implementation, then read it three ways.
GRADED_PROBE_PY = '''import os
import sys
import unittest

from tasktrackr.manager import TaskManager


class TestGraded(unittest.TestCase):
    def test_the_implementation_still_imports(self):
        self.assertEqual(TaskManager().add_task("a")["id"], 1)

    def test_reading_the_implementation_by_its_own_path(self):
        with open("tasktrackr/manager.py") as fh:
            fh.read()

    def test_reading_the_implementation_where_it_really_is(self):
        directories = [entry for entry in sys.path if "lsdlc-graded-" in entry]
        assert directories, "the graded directory was never on sys.path"
        for directory in directories:
            with open(os.path.join(directory, "tasktrackr", "manager.py")) as fh:
                fh.read()

    def test_reading_it_out_of_the_module(self):
        import tasktrackr.manager

        with open(tasktrackr.manager.__file__) as fh:
            fh.read()
'''


class GradedFilesTest(unittest.TestCase):
    """One suite that imports the graded implementation and then tries to read it."""

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            {
                "files": {"tests/test_probe.py": GRADED_PROBE_PY},
                "gradedFiles": {
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": GRADED_MANAGER_PY,
                },
                "mode": "tests",
                "testPaths": ["tests/test_probe.py"],
                "language": "python",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        cls.cases = by_method(cls.result["tests"])

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



class GradedTeardownTest(unittest.TestCase):
    def test_the_graded_directory_does_not_outlive_the_job(self):
        # Its own temp root, so the assertion is about the directories this job
        # made and not about whatever else the machine is running.
        home = tempfile.mkdtemp(prefix="lsdlc-teardown-")
        previous = tempfile.tempdir
        tempfile.tempdir = home
        try:
            execute_job(
                {
                    "files": {"tests/test_probe.py": GRADED_PROBE_PY},
                    "gradedFiles": {
                        "tasktrackr/__init__.py": "",
                        "tasktrackr/manager.py": GRADED_MANAGER_PY,
                    },
                    "mode": "tests",
                    "testPaths": ["tests/test_probe.py"],
                    "language": "python",
                    "timeoutSeconds": 20,
                    "memoryMb": 256,
                }
            )
        finally:
            tempfile.tempdir = previous
        try:
            self.assertEqual(os.listdir(home), [])
        finally:
            shutil.rmtree(home, ignore_errors=True)


class GradedShadowTest(unittest.TestCase):
    """A workspace copy of a graded file must not shadow the graded one."""

    def test_the_graded_implementation_wins(self):
        result = execute_job(
            {
                # the learner ships their own tasktrackr/manager.py beside their tests
                "files": {
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": GRADED_MANAGER_PY.replace(
                        "self._next_id = 1", "self._next_id = 99"
                    ),
                    "tests/test_probe.py": (
                        "import unittest\n\n"
                        "from tasktrackr.manager import TaskManager\n\n\n"
                        "class TestShadow(unittest.TestCase):\n"
                        "    def test_first_id(self):\n"
                        "        self.assertEqual(TaskManager().add_task('a')['id'], 1)\n"
                    ),
                },
                "gradedFiles": {
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": GRADED_MANAGER_PY,
                },
                "mode": "tests",
                "testPaths": ["tests/test_probe.py"],
                "language": "python",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


class GradedTestPathTest(unittest.TestCase):
    """A hidden suite can itself be graded: it runs, and it cannot be read."""

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            {
                "files": {
                    "tests/test_visible.py": (
                        "import unittest\n\n\n"
                        "class TestVisible(unittest.TestCase):\n"
                        "    def test_the_visible_suite_still_runs(self):\n"
                        "        pass\n\n"
                        "    def test_reading_the_hidden_suite(self):\n"
                        "        with open('tests/test_hidden.py') as fh:\n"
                        "            fh.read()\n"
                    )
                },
                "gradedFiles": {
                    "tasktrackr/__init__.py": "",
                    "tasktrackr/manager.py": GRADED_MANAGER_PY,
                    "tests/test_hidden.py": (
                        "import unittest\n\n"
                        "from tasktrackr.manager import TaskManager\n\n\n"
                        "class TestHidden(unittest.TestCase):\n"
                        "    def test_hidden_edge_case(self):\n"
                        "        self.assertEqual(TaskManager().add_task('SECRET')['title'], 'SECRET')\n"
                    ),
                },
                "mode": "tests",
                "testPaths": ["tests/test_visible.py", "tests/test_hidden.py"],
                "language": "python",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        cls.cases = by_method(cls.result["tests"])

    def test_both_suites_ran(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertEqual(self.cases["test_hidden_edge_case"]["status"], "passed")
        self.assertEqual(self.cases["test_the_visible_suite_still_runs"]["status"], "passed")

    def test_the_hidden_suite_cannot_be_read_by_the_visible_one(self):
        case = self.cases["test_reading_the_hidden_suite"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("FileNotFoundError", case["message"])

    def test_no_frame_names_the_hidden_suite(self):
        for case in self.result["tests"]["cases"]:
            for frame in case.get("frames", []):
                self.assertNotIn("test_hidden", frame["path"])


class GradedModeTest(unittest.TestCase):
    def test_graded_files_are_refused_outside_test_mode(self):
        # Only the test harnesses import and unlink them; anywhere else they
        # would silently be missing, which is worse than being refused.
        with self.assertRaises(ValueError):
            execute_job(
                {
                    "files": {"cli.py": "print('hi')\n"},
                    "gradedFiles": {"tasktrackr/manager.py": GRADED_MANAGER_PY},
                    "mode": "smoke",
                    "smokeCommands": [["python3", "cli.py"]],
                    "language": "python",
                }
            )


MANAGER_GRADED_JS = '''"use strict";
class TaskManager {
  constructor() { this.nextId = 1; }
  addTask(title) { return { id: this.nextId++, title: title, completed: false }; }
}
module.exports = { TaskManager };
'''

PROBE_GRADED_JS = '''const fs = require('fs');
const { TaskManager } = require('../taskmanager');

test('the implementation still requires', () => {
  assert.strictEqual(new TaskManager().addTask('a').id, 1);
});
test('reading the implementation by its own path', () => {
  fs.readFileSync('taskmanager.js', 'utf8');
});
test('reading it out of the module cache', () => {
  const entry = Object.keys(require.cache).find((k) => k.endsWith('taskmanager.js'));
  assert.ok(entry, 'the graded module was never loaded');
  fs.readFileSync(entry, 'utf8');
});
'''


@unittest.skipUnless(node_bin(), "no node binary on PATH")
class JavaScriptGradedFilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._node = os.environ.get("NODE_BIN")
        os.environ["NODE_BIN"] = node_bin()
        cls.result = execute_job(
            {
                "files": {"tests/test_probe.js": PROBE_GRADED_JS},
                "gradedFiles": {"taskmanager.js": MANAGER_GRADED_JS},
                "mode": "tests",
                "testPaths": ["tests/test_probe.js"],
                "language": "javascript",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        cls.cases = {case["name"]: case for case in cls.result["tests"]["cases"]}

    @classmethod
    def tearDownClass(cls):
        if cls._node is None:
            os.environ.pop("NODE_BIN", None)
        else:
            os.environ["NODE_BIN"] = cls._node

    def test_the_suite_ran_against_the_graded_implementation(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertEqual(self.cases["the implementation still requires"]["status"], "passed")

    def test_the_implementation_is_not_at_the_path_it_requires_from(self):
        case = self.cases["reading the implementation by its own path"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("ENOENT", case["message"])

    def test_the_cached_module_names_a_file_that_no_longer_exists(self):
        case = self.cases["reading it out of the module cache"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("ENOENT", case["message"])

    def test_the_graded_path_never_reaches_the_report(self):
        self.assertNotIn("lsdlc-graded-", json.dumps(self.result))


# The same seal under the fence's shape. On Linux the kernel ruleset makes the
# graded directory read-write but grants nothing on its parent, so deleting the
# directory ITSELF is refused (EACCES) while every file inside it can go. Node's
# fs.rmSync tries the directory first and gives up on that refusal without
# unlinking a single file, which left the whole answer key readable on every
# host with Landlock (CI, production) while a laptop's run stayed green. An
# unwritable parent gives the same refusal on any host, so the seal is proved
# here without a Landlock kernel.
@unittest.skipUnless(node_bin(), "no node binary on PATH")
@unittest.skipIf(os.geteuid() == 0, "root ignores directory modes")
class JavaScriptGradedFilesUnderTheFenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._node = os.environ.get("NODE_BIN")
        os.environ["NODE_BIN"] = node_bin()
        cls.parent = tempfile.mkdtemp(prefix="lsdlc-fence-parent-")
        real_mkdtemp = tempfile.mkdtemp

        def mkdtemp(*args, **kwargs):
            if kwargs.get("prefix") != "lsdlc-graded-":
                return real_mkdtemp(*args, **kwargs)
            made = real_mkdtemp(dir=cls.parent, **kwargs)
            os.chmod(cls.parent, 0o555)
            return made

        tempfile.mkdtemp = mkdtemp
        try:
            cls.result = execute_job(
                {
                    "files": {"tests/test_probe.js": PROBE_GRADED_JS},
                    "gradedFiles": {"taskmanager.js": MANAGER_GRADED_JS},
                    "mode": "tests",
                    "testPaths": ["tests/test_probe.js"],
                    "language": "javascript",
                    "timeoutSeconds": 20,
                    "memoryMb": 256,
                }
            )
        finally:
            tempfile.mkdtemp = real_mkdtemp
        cls.cases = {case["name"]: case for case in cls.result["tests"]["cases"]}

    @classmethod
    def tearDownClass(cls):
        os.chmod(cls.parent, 0o755)
        shutil.rmtree(cls.parent, ignore_errors=True)
        if cls._node is None:
            os.environ.pop("NODE_BIN", None)
        else:
            os.environ["NODE_BIN"] = cls._node

    def test_the_suite_still_ran_against_the_graded_implementation(self):
        self.assertEqual(self.result["exitKind"], "ok", self.result.get("stderr"))
        self.assertEqual(self.cases["the implementation still requires"]["status"], "passed")

    def test_the_cached_module_names_a_file_that_no_longer_exists(self):
        case = self.cases["reading it out of the module cache"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("ENOENT", case["message"])

    def test_the_implementation_is_not_at_the_path_it_requires_from(self):
        case = self.cases["reading the implementation by its own path"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("ENOENT", case["message"])


@unittest.skipUnless(node_bin(), "no node binary on PATH")
class JavaScriptGradedShadowTest(unittest.TestCase):
    def test_the_graded_implementation_wins(self):
        node = os.environ.get("NODE_BIN")
        os.environ["NODE_BIN"] = node_bin()
        try:
            result = execute_job(
                {
                    "files": {
                        "taskmanager.js": MANAGER_GRADED_JS.replace(
                            "this.nextId = 1", "this.nextId = 99"
                        ),
                        "tests/test_probe.js": (
                            "const { TaskManager } = require('../taskmanager');\n"
                            "test('first id', () => {\n"
                            "  assert.strictEqual(new TaskManager().addTask('a').id, 1);\n"
                            "});\n"
                        ),
                    },
                    "gradedFiles": {"taskmanager.js": MANAGER_GRADED_JS},
                    "mode": "tests",
                    "testPaths": ["tests/test_probe.js"],
                    "language": "javascript",
                    "timeoutSeconds": 20,
                    "memoryMb": 256,
                }
            )
        finally:
            if node is None:
                os.environ.pop("NODE_BIN", None)
            else:
                os.environ["NODE_BIN"] = node
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


# The run clock. The job carries an ISO date, the runner turns it
# into one environment variable, and the pack's own helper is the only thing
# that reads it. The allowlist in run_child is a security boundary, so these
# assert the key set as well as the value.
CLOCK_PROBE_PY = """import json
import os
import unittest


class TestClock(unittest.TestCase):
    def test_reports_the_environment(self):
        print("@@ENV@@" + json.dumps(sorted(os.environ)))
        print("@@NOW@@" + os.environ.get("LEARNSDLC_NOW", ""))


if __name__ == "__main__":
    unittest.main()
"""


def _probe(stdout, marker):
    for line in stdout.splitlines():
        if line.startswith(marker):
            return line[len(marker):]
    return None


class RunClockTest(unittest.TestCase):
    """One variable reaches the child, and only when the job pins a date."""

    def _run(self, job_extra):
        job = {
            "files": {"tests/test_clock.py": CLOCK_PROBE_PY},
            "mode": "tests",
            "testPaths": ["tests/test_clock.py"],
            "language": "python",
            "timeoutSeconds": 20,
            "memoryMb": 256,
        }
        job.update(job_extra)
        return execute_job(job)

    def test_a_pinned_clock_reaches_the_child_as_learnsdlc_now(self):
        result = self._run({"clock": "2026-03-01"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(_probe(result["stdout"], "@@NOW@@"), "2026-03-01")

    def test_a_job_with_no_clock_leaves_the_variable_unset(self):
        result = self._run({})
        self.assertTrue(result["ok"], result)
        self.assertEqual(_probe(result["stdout"], "@@NOW@@"), "")
        keys = json.loads(_probe(result["stdout"], "@@ENV@@"))
        self.assertNotIn("LEARNSDLC_NOW", keys)

    def test_a_malformed_clock_is_dropped_rather_than_raised(self):
        # A run is still a valid request to execute the learner's code, and the
        # clock is a parameter their code cannot see. Refusing the whole run
        # would turn a typo upstream into an outage.
        for bad in ["2026-3-1", "yesterday", "2026-03-01T09:00:00", "", None, 20260301]:
            result = self._run({"clock": bad})
            self.assertTrue(result["ok"], (bad, result))
            self.assertEqual(_probe(result["stdout"], "@@NOW@@"), "", bad)

    def test_the_environment_is_otherwise_byte_identical(self):
        without = json.loads(_probe(self._run({})["stdout"], "@@ENV@@"))
        with_clock = json.loads(_probe(self._run({"clock": "2026-03-01"})["stdout"], "@@ENV@@"))
        self.assertEqual(
            sorted(set(with_clock) - set(without)),
            ["LEARNSDLC_NOW"],
        )
        self.assertEqual(sorted(set(without) - set(with_clock)), [])
        # And the allowlist itself has not grown. The five keys run_child sets
        # are all there, nothing the parent holds has joined them, and the only
        # other names are the ones the interpreter adds for itself.
        self.assertEqual(
            sorted(set(without) & {"HOME", "PATH", "PYTHONDONTWRITEBYTECODE",
                                   "PYTHONHASHSEED", "TASKTRACKR_DATA"}),
            ["HOME", "PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED", "TASKTRACKR_DATA"],
        )
        os.environ["LSDLC_PARENT_SECRET"] = "must-not-leak"
        try:
            leaked = json.loads(_probe(self._run({"clock": "2026-03-01"})["stdout"], "@@ENV@@"))
        finally:
            os.environ.pop("LSDLC_PARENT_SECRET", None)
        self.assertNotIn("LSDLC_PARENT_SECRET", leaked)

    def test_a_smoke_run_sees_the_same_clock(self):
        result = execute_job(
            {
                "files": {"cli.py": "import os\nprint('now=' + os.environ.get('LEARNSDLC_NOW', 'machine'))\n"},
                "mode": "smoke",
                "smokeCommands": [["python3", "cli.py"]],
                "expectInOutput": "now=2026-03-01",
                "language": "python",
                "clock": "2026-03-01",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertIn("now=2026-03-01", result["stdout"])


# The pre-baked dependency layer: the libraries a learner's
# code imports are on disk before the first job arrives, because a graded run
# has no network and no package manager. When they are not, that has to read as
# a machine that is not set up, never as a learner whose code is broken.
# ---------------------------------------------------------------------------


class EmptyRuntimeMixin:
    """Point the runner at a directory with nothing baked in it."""

    def setUp(self):
        self.empty = tempfile.mkdtemp(prefix="lsdlc-no-runtime-")
        self.previous = os.environ.get("RUNNER_RUNTIME_DIR")
        os.environ["RUNNER_RUNTIME_DIR"] = self.empty

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("RUNNER_RUNTIME_DIR", None)
        else:
            os.environ["RUNNER_RUNTIME_DIR"] = self.previous
        shutil.rmtree(self.empty, ignore_errors=True)


class RuntimeAbsentTest(EmptyRuntimeMixin, unittest.TestCase):
    def test_the_three_lookups_answer_none_when_nothing_is_baked(self):
        self.assertIsNone(runtime_site_packages())
        self.assertIsNone(runtime_node_modules())
        self.assertIsNone(runtime_esbuild())

    def test_the_child_is_told_nothing_it_cannot_use(self):
        env = child_env("/tmp/does-not-matter")
        for key in ("LSDLC_PYLIB", "NODE_PATH", "ESBUILD_BIN"):
            self.assertNotIn(key, env)

    def test_a_pytest_job_names_the_command_that_fixes_it(self):
        # Not a raw ModuleNotFoundError: "No module named 'pytest'" reads to a
        # learner as their own import being wrong, and thirty of them would
        # spend the lab looking for it.
        result = execute_job(
            {
                "files": {"tests/test_one.py": "def test_one():\n    assert True\n"},
                "mode": "tests",
                "testPaths": ["tests"],
                "language": "python",
                "harness": "pytest",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitKind"], "error")
        self.assertIsNone(result["tests"])
        self.assertEqual(result["stderr"], PREBAKE_MISSING_MESSAGE)
        self.assertIn("npm run prebake", result["stderr"])

    def test_a_typescript_job_names_the_command_that_fixes_it(self):
        # Same reasoning as pytest: "Cannot find module 'jsdom'" reads to a
        # learner as a fault in the code they just wrote.
        result = execute_job(
            {
                "files": {"web/src/one.test.ts": "test('one', () => { assert.ok(true); });\n"},
                "mode": "tests",
                "testPaths": ["web/src/one.test.ts"],
                "language": "typescript",
                "transform": {"tool": "esbuild"},
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitKind"], "error")
        self.assertIsNone(result["tests"])
        self.assertEqual(result["stderr"], PREBAKE_MISSING_MESSAGE)

    def test_a_transform_without_esbuild_says_the_same_thing(self):
        result = execute_job(
            {
                "files": {"test_visible.js": "test('one', () => { assert.ok(true); });\n"},
                "mode": "tests",
                "testPaths": ["test_visible.js"],
                "language": "javascript",
                "transform": {"tool": "esbuild"},
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        self.assertEqual(result["stderr"], PREBAKE_MISSING_MESSAGE)

    def test_the_unittest_path_still_runs_without_a_baked_layer(self):
        # The stdlib is enough for unittest, so a machine with no pre-bake still
        # runs every pack whose tests are plain unittest.
        result = execute_job(
            python_tests_job(
                {
                    "tests/test_one.py": (
                        "import unittest\n\n\n"
                        "class TestOne(unittest.TestCase):\n"
                        "    def test_one(self):\n"
                        "        self.assertTrue(True)\n"
                    )
                },
                ["tests/test_one.py"],
            )
        )
        self.assertTrue(result["ok"], result)


class SmokeSeesThePreBakedLayerTest(unittest.TestCase):
    """The pack's own program may import what project.json declared.

    Phase 5's build check is `python3 api/main.py --selfcheck`, which builds the
    Flask app to count its routes: the only honest way to answer "does the API
    still build". The smoke child is not run with -I, so PYTHONPATH reaches it;
    the test children are, so the same variable is inert for them and they read
    LSDLC_PYLIB from inside their harness instead.
    """

    def setUp(self):
        if runtime_site_packages() is None:
            self.skipTest("no pre-baked runtime: run `node scripts/prebake.mjs build` first")

    def test_a_smoke_command_can_import_what_the_pack_declared(self):
        result = execute_job(
            {
                "files": {
                    "api/main.py": (
                        "import flask\n"
                        "from flask import Flask\n\n\n"
                        "def create_app():\n"
                        "    app = Flask(__name__)\n\n"
                        "    @app.get('/api/health')\n"
                        "    def health():\n"
                        "        return {'status': 'ok'}\n\n"
                        "    return app\n\n\n"
                        "if __name__ == '__main__':\n"
                        "    routes = len(create_app().url_map._rules)\n"
                        "    print('selfcheck: %d routes' % routes)\n"
                        "    print('flask from ' + flask.__file__)\n"
                    )
                },
                "mode": "smoke",
                "smokeCommands": [["python3", "api/main.py", "--selfcheck"]],
                "expectInOutput": "selfcheck: 2 routes",
                "language": "python",
                "timeoutSeconds": 30,
                "memoryMb": 256,
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertIn("selfcheck: 2 routes", result["stdout"])
        # The pre-baked one, not whatever the machine happens to have installed:
        # a developer laptop with a global Flask would otherwise pass this test
        # for the wrong reason and the container would fail in the lab. Asserted
        # through the redaction rather than around it, because the runner does
        # not publish the layer's absolute path: `sandbox/python/...` is the same
        # claim (this import came from the baked tree) in the form the learner
        # actually sees, and the second assertion is that the host path is gone.
        self.assertIn("flask from sandbox/python/flask/", result["stdout"])
        self.assertNotIn(runtime_root(), result["stdout"])

    def test_the_library_directory_travels_as_pythonpath(self):
        env = child_env("/tmp/does-not-matter")
        self.assertEqual(env["PYTHONPATH"], runtime_site_packages())

    def test_a_job_cannot_choose_pythonpath(self):
        with self.assertRaises(ValueError):
            child_env("/tmp/does-not-matter", {"PYTHONPATH": "/tmp/mine"})


class HarnessChoiceTest(unittest.TestCase):
    """Which harness runs a job, and which pairings are refused."""

    def test_a_python_job_with_no_harness_is_still_unittest(self):
        self.assertEqual(harness_for({"language": "python"}), "unittest")

    def test_a_javascript_job_with_no_harness_is_still_the_js_harness(self):
        self.assertEqual(harness_for({"language": "javascript"}), "js")

    def test_a_job_with_no_language_at_all_is_still_unittest(self):
        self.assertEqual(harness_for({}), "unittest")

    def test_python_can_ask_for_pytest(self):
        self.assertEqual(harness_for({"language": "python", "harness": "pytest"}), "pytest")

    def test_pytest_cannot_run_javascript(self):
        with self.assertRaises(ValueError) as caught:
            harness_for({"language": "javascript", "harness": "pytest"})
        self.assertIn("cannot run javascript", str(caught.exception))

    def test_an_unknown_harness_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            harness_for({"language": "python", "harness": "vitest"})
        self.assertIn("unknown harness", str(caught.exception))

    def test_a_typescript_job_runs_under_the_js_harness(self):
        # It is JavaScript by the time the child sees it: the parent compiles
        # it first, so one harness runs both languages.
        self.assertEqual(harness_for({"language": "typescript"}), "js")
        self.assertEqual(harness_for({"language": "typescript", "harness": "js"}), "js")

    def test_pytest_cannot_run_typescript_either(self):
        with self.assertRaises(ValueError) as caught:
            harness_for({"language": "typescript", "harness": "pytest"})
        self.assertIn("cannot run typescript", str(caught.exception))


class AddressSpaceRuleTest(unittest.TestCase):
    """Which language gets an RLIMIT_AS, and which one it would kill.

    An address-space rlimit is right for CPython and fatal for V8, which
    reserves multi-gigabyte virtual ranges at startup: node under RLIMIT_AS
    dies before it runs a line, and the run comes back with no result at all,
    which reads as "the runner died", not as "your code is wrong".
    """

    def test_python_is_the_only_language_that_gets_one(self):
        self.assertTrue(limits_address_space("python"))
        self.assertFalse(limits_address_space("javascript"))
        self.assertFalse(limits_address_space("typescript"))


class TransformToolTest(unittest.TestCase):
    """Content names a tool the runner knows, never an argv."""

    def test_an_unknown_transform_tool_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            execute_job(
                {
                    "files": {"web/src/one.test.ts": "test('one', () => {});\n"},
                    "mode": "tests",
                    "testPaths": ["web/src/one.test.ts"],
                    "language": "typescript",
                    "transform": {"tool": "swc"},
                    "timeoutSeconds": 20,
                    "memoryMb": 256,
                }
            )
        self.assertIn("unknown transform tool", str(caught.exception))


class ChildEnvironmentTest(unittest.TestCase):
    """The child's environment is an allowlist, and the runner owns most of it."""

    def test_the_workspace_gets_its_own_database_path(self):
        env = child_env("/tmp/workspace-x")
        self.assertEqual(env["TASKTRACKR_DB"], os.path.join("/tmp/workspace-x", "tasktrackr.db"))

    def test_a_job_cannot_choose_the_library_directory(self):
        # LSDLC_PYLIB names the directory every import in the child resolves
        # against. A job that could set it would choose the code that runs.
        with self.assertRaises(ValueError) as caught:
            child_env("/tmp/workspace-x", {"LSDLC_PYLIB": "/tmp/mine"})
        self.assertIn("LSDLC_PYLIB", str(caught.exception))

    def test_a_job_cannot_choose_the_path_either(self):
        with self.assertRaises(ValueError):
            child_env("/tmp/workspace-x", {"PATH": "/tmp/mine"})

    def test_the_clock_and_a_preview_database_are_still_allowed(self):
        env = child_env("/tmp/workspace-x", {
            "LEARNSDLC_NOW": "2026-03-01",
            "TASKTRACKR_DB": "data/preview.sqlite",
            "PORT": "51234",
        })
        self.assertEqual(env["LEARNSDLC_NOW"], "2026-03-01")
        self.assertEqual(env["TASKTRACKR_DB"], "data/preview.sqlite")
        self.assertEqual(env["PORT"], "51234")

    def test_nothing_of_the_parents_environment_leaks_in(self):
        os.environ["LSDLC_PARENT_SECRET"] = "not-for-the-child"
        try:
            env = child_env("/tmp/workspace-x")
        finally:
            os.environ.pop("LSDLC_PARENT_SECRET", None)
        self.assertNotIn("LSDLC_PARENT_SECRET", env)


FORKING_CHILD = (
    "import os, sys, time\n"
    "pid = os.fork()\n"
    "if pid == 0:\n"
    "    time.sleep(120)\n"
    "    sys.exit(0)\n"
    "with open('grandchild.txt', 'w') as fh:\n"
    "    fh.write(str(pid))\n"
    "sys.stdout.write('up\\n')\n"
    "sys.stdout.flush()\n"
    "time.sleep(120)\n"
)


def _alive(pid):
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError) as exc:
        return isinstance(exc, PermissionError)
    return True


class SpawnAndReapTest(unittest.TestCase):
    """spawn_child and reap_group, the two the preview supervisor builds on.

    run_child is one caller of them; a child that has to outlive a single
    request is the other. Both spawn through the same limits and the same
    setsid, so "kill the whole group" means the same thing either way.
    """

    def test_reap_group_takes_the_grandchild_with_it(self):
        workspace = tempfile.mkdtemp(prefix="lsdlc-reap-")
        proc = None
        grandchild = None
        # RLIMIT_NPROC counts every process the uid already owns, and /proc is
        # not there to count them on macOS, so the headroom becomes an absolute
        # cap of 64 and this child cannot fork at all on a developer machine.
        # The cap is not what is under test here; the group kill is.
        headroom = sandbox_runner.NPROC_HEADROOM
        sandbox_runner.NPROC_HEADROOM = 0
        try:
            proc = spawn_child([sys.executable, "-c", FORKING_CHILD], workspace, 256, 30)
            marker = os.path.join(workspace, "grandchild.txt")
            for _ in range(200):
                if os.path.exists(marker):
                    break
                time.sleep(0.05)
            self.assertTrue(os.path.exists(marker), "the child never forked")
            with open(marker) as handle:
                grandchild = int(handle.read().strip())
            self.assertTrue(_alive(grandchild))

            reap_group(proc.pid)
            proc.wait(timeout=10)
            for _ in range(100):
                if not _alive(grandchild):
                    break
                time.sleep(0.05)
            self.assertFalse(_alive(grandchild), "the grandchild outlived its group")
        finally:
            sandbox_runner.NPROC_HEADROOM = headroom
            if proc is not None and proc.poll() is None:
                reap_group(proc.pid)
                proc.wait(timeout=10)
            if proc is not None:
                for stream in (proc.stdout, proc.stderr):
                    if stream is not None: stream.close()
            if grandchild is not None and _alive(grandchild):
                try:
                    os.kill(grandchild, signal.SIGKILL)
                except OSError:
                    pass
            shutil.rmtree(workspace, ignore_errors=True)

    def test_reaping_a_pid_that_is_already_gone_is_not_an_error(self):
        workspace = tempfile.mkdtemp(prefix="lsdlc-reap-")
        try:
            proc = spawn_child([sys.executable, "-c", "pass"], workspace, 256, 30)
            proc.wait(timeout=10)
            reap_group(proc.pid)  # must not raise
            for stream in (proc.stdout, proc.stderr):
                if stream is not None: stream.close()
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    def test_the_descriptor_cap_is_a_parameter_and_still_a_cap(self):
        workspace = tempfile.mkdtemp(prefix="lsdlc-nofile-")
        try:
            script = (
                "import resource, sys\n"
                "sys.stdout.write(str(resource.getrlimit(resource.RLIMIT_NOFILE)[0]))\n"
            )
            proc = spawn_child([sys.executable, "-c", script], workspace, 256, 30, nofile=512)
            stdout, _stderr = proc.communicate(timeout=20)
            self.assertEqual(stdout.strip(), "512")

            proc = spawn_child([sys.executable, "-c", script], workspace, 256, 30)
            stdout, _stderr = proc.communicate(timeout=20)
            self.assertEqual(stdout.strip(), "128")
        finally:
            shutil.rmtree(workspace, ignore_errors=True)


class WallClockTimeoutTest(unittest.TestCase):
    """A run that never finishes comes back as a timeout, not as an exception.

    RLIMIT_CPU catches a spinning child; a sleeping one burns no CPU and is
    caught by the wall clock instead, which is the only path that calls
    reap_group. On macOS that path must survive the group's second sweep
    hitting a zombie, where the kernel answers EPERM rather than ESRCH.
    """

    def test_a_run_that_sleeps_past_its_deadline_is_reported_as_a_timeout(self):
        result = execute_job(
            {
                "files": {
                    "tests/test_slow.py": (
                        "import time\n"
                        "import unittest\n\n\n"
                        "class TestSlow(unittest.TestCase):\n"
                        "    def test_slow(self):\n"
                        "        time.sleep(30)\n"
                    )
                },
                "mode": "tests",
                "testPaths": ["tests/test_slow.py"],
                "language": "python",
                "timeoutSeconds": 2,
                "memoryMb": 256,
            }
        )
        self.assertEqual(result["exitKind"], "timeout")
        self.assertFalse(result["ok"])
        self.assertIsNone(result["tests"])


class RunIdStampTest(unittest.TestCase):
    def test_the_unittest_harness_stamps_the_run_too(self):
        result = execute_job(
            python_tests_job(
                {
                    "tests/test_one.py": (
                        "import unittest\n\n\n"
                        "class TestOne(unittest.TestCase):\n"
                        "    def test_one(self):\n"
                        "        self.assertTrue(True)\n"
                    )
                },
                ["tests/test_one.py"],
            )
            | {"runId": "api"}
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual([c["step"] for c in result["tests"]["cases"]], ["api"])

    def test_a_job_with_no_run_id_stamps_nothing(self):
        result = execute_job(
            python_tests_job(
                {
                    "tests/test_one.py": (
                        "import unittest\n\n\n"
                        "class TestOne(unittest.TestCase):\n"
                        "    def test_one(self):\n"
                        "        self.assertTrue(True)\n"
                    )
                },
                ["tests/test_one.py"],
            )
        )
        self.assertNotIn("step", result["tests"]["cases"][0])


# The fence. Every child is the same uid in one container with one /tmp, so a
# workspace's 0700 is no boundary; what keeps one learner's run out of
# another's is the kernel ruleset spawn_child builds (Landlock, where the
# kernel has it) and the file policy inside every bootstrap. These cases cover
# the runner's half: what the child is told, what the ruleset names, and (on a
# kernel that has Landlock) that a child with NO bootstrap at all is still
# refused by the kernel.
class FenceTest(unittest.TestCase):
    def test_the_child_gets_a_temp_directory_inside_its_workspace(self):
        env = child_env("/tmp/workspace-x")
        self.assertEqual(env["TMPDIR"], "/tmp/workspace-x/.lsdlc-tmp")

    def test_the_extra_roots_reach_the_policy_and_nothing_else_does(self):
        self.assertNotIn("LSDLC_FS_ROOTS", child_env("/tmp/workspace-x"))
        env = child_env("/tmp/workspace-x", extra_roots=["/tmp/lsdlc-graded-x"])
        self.assertEqual(env["LSDLC_FS_ROOTS"], "/tmp/lsdlc-graded-x")

    def test_a_job_cannot_choose_either(self):
        # Both name what the child may reach; a job that could set them would
        # name a sibling's workspace.
        for key in ("TMPDIR", "LSDLC_FS_ROOTS"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                child_env("/tmp/workspace-x", {key: "/tmp/lsdlc-other"})

    def test_spawn_child_creates_the_temp_directory(self):
        workspace = tempfile.mkdtemp(prefix="lsdlc-fence-")
        try:
            proc = spawn_child([sys.executable, "-c", "pass"], workspace, 256, 30)
            proc.communicate(timeout=30)
            self.assertTrue(os.path.isdir(os.path.join(workspace, sandbox_runner.CHILD_TMPDIR_NAME)))
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    def test_the_rights_grow_with_the_abi_and_never_shrink(self):
        first = sandbox_runner.landlock_rights(1)
        self.assertEqual(first, 0x1FFF)
        self.assertEqual(sandbox_runner.landlock_rights(2), first | sandbox_runner.LANDLOCK_ACCESS_FS_REFER)
        self.assertEqual(
            sandbox_runner.landlock_rights(3),
            first | sandbox_runner.LANDLOCK_ACCESS_FS_REFER | sandbox_runner.LANDLOCK_ACCESS_FS_TRUNCATE,
        )
        self.assertTrue(sandbox_runner.landlock_rights(5) & sandbox_runner.LANDLOCK_ACCESS_FS_IOCTL_DEV)
        self.assertFalse(sandbox_runner.landlock_rights(4) & sandbox_runner.LANDLOCK_ACCESS_FS_IOCTL_DEV)

    def test_the_ruleset_names_the_workspace_and_never_the_temp_directory(self):
        workspace = tempfile.mkdtemp(prefix="lsdlc-fence-")
        graded = tempfile.mkdtemp(prefix="lsdlc-graded-")
        try:
            rules = sandbox_runner.confinement_rules(workspace, [graded], programs=(sys.executable,))
            by_path = {path: (access, required) for path, access, required in rules}
            every = sandbox_runner.landlock_rights(max(sandbox_runner.landlock_abi(), 1))
            self.assertEqual(by_path[os.path.realpath(workspace)], (every, True))
            self.assertEqual(by_path[os.path.realpath(graded)], (every, True))
            # Read-only for the interpreter and the system, and nothing that
            # would let a rule reach a sibling: not /tmp, not the temp
            # directory the workspaces were made in, not a parent of either.
            tmp = os.path.realpath(tempfile.gettempdir())
            for path, (access, _required) in by_path.items():
                if path in (os.path.realpath(workspace), os.path.realpath(graded)):
                    continue
                self.assertFalse(tmp.startswith(path), f"{path} would reach /tmp")
                self.assertNotEqual(path, "/")
                self.assertFalse(access & ~(
                    sandbox_runner.FENCE_READ
                    | sandbox_runner.LANDLOCK_ACCESS_FS_WRITE_FILE
                    | sandbox_runner.LANDLOCK_ACCESS_FS_IOCTL_DEV
                ), f"{path} is more than read-only")
            self.assertIn(os.path.realpath(sys.prefix), by_path)
            self.assertIn(os.path.realpath("/dev/null"), by_path)
            self.assertNotIn("/dev", by_path)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
            shutil.rmtree(graded, ignore_errors=True)

    def test_the_workspace_is_a_required_rule(self):
        rules = sandbox_runner.confinement_rules("/tmp/lsdlc-does-not-exist", ["/tmp/lsdlc-graded-nope"])
        required = [path for path, _access, required in rules if required]
        self.assertEqual(
            required,
            [os.path.realpath("/tmp/lsdlc-does-not-exist"), os.path.realpath("/tmp/lsdlc-graded-nope")],
        )

    def test_the_note_says_which_fence_holds(self):
        note = sandbox_runner.confinement_note()
        self.assertTrue(note.startswith("confinement: "), note)
        if sandbox_runner.isolation_status()["mechanism"] == "single-job-microvm":
            self.assertIn("fresh microVM", note)
        elif sandbox_runner.landlock_abi():
            self.assertIn("Landlock ABI", note)
        else:
            self.assertIn("kernel isolation unsupported", note)
            self.assertIn("are refused", note)

    def test_the_ruleset_is_built_from_the_rules_and_applied_in_the_child(self):
        # The kernel calls, with the kernel taken out: a libc whose syscall
        # records what it was asked. This is the whole plumbing: the ruleset
        # is created with every right the ABI has, one rule is added per path
        # with an O_PATH descriptor, the child asks for no new privileges and
        # then restricts itself, and the parent closes the ruleset afterwards.
        calls = []

        class FakeLibc:
            def prctl(self, option, arg, *_rest):
                calls.append(("prctl", option.value, arg.value))
                return 0

            def syscall(self, number, *args):
                number = number.value
                if number == sandbox_runner.LANDLOCK_CREATE_RULESET:
                    attr = ctypes.cast(args[0], ctypes.POINTER(sandbox_runner._RulesetAttr)).contents
                    calls.append(("create", attr.handled_access_fs))
                    return ruleset
                if number == sandbox_runner.LANDLOCK_ADD_RULE:
                    rule = ctypes.cast(args[2], ctypes.POINTER(sandbox_runner._PathBeneathAttr)).contents
                    calls.append(("add", args[0].value, rule.allowed_access, os.fstat(rule.parent_fd).st_ino))
                    return 0
                if number == sandbox_runner.LANDLOCK_RESTRICT_SELF:
                    calls.append(("restrict", args[0].value))
                    return 0
                raise AssertionError(f"unexpected syscall {number}")

        # A real descriptor stands in for the ruleset, so the close after the
        # spawn is a real close too.
        ruleset = os.open(os.devnull, os.O_RDONLY)
        workspace = tempfile.mkdtemp(prefix="lsdlc-fence-")
        saved = dict(sandbox_runner._LANDLOCK), sandbox_runner._LIBC
        sandbox_runner._LANDLOCK.update(abi=3, note="test")
        sandbox_runner._LIBC = FakeLibc()
        try:
            fd = sandbox_runner.landlock_ruleset(workspace, programs=(sys.executable,))
            self.assertEqual(fd, ruleset)
            rules = sandbox_runner.confinement_rules(workspace, programs=(sys.executable,))
            self.assertEqual(calls[0], ("create", sandbox_runner.landlock_rights(3)))
            added = [c for c in calls if c[0] == "add"]
            self.assertEqual(len(added), len(rules))
            self.assertEqual(
                [(c[1], c[2], c[3]) for c in added],
                [(ruleset, access, os.stat(path).st_ino) for path, access, _required in rules],
            )
            # What the child does with it (the preexec itself sets rlimits on
            # the calling process, so it is not called here; the next case
            # proves it is wired): no new privileges, then the restriction.
            calls.clear()
            sandbox_runner.landlock_enforce(ruleset)
            self.assertEqual(
                calls, [("prctl", sandbox_runner.PR_SET_NO_NEW_PRIVS, 1), ("restrict", ruleset)]
            )
            # spawn_child closes the ruleset once the child is started.
            proc = spawn_child([sys.executable, "-c", "print('ran')"], workspace, 256, 30)
            stdout, _stderr = proc.communicate(timeout=30)
            self.assertEqual(stdout.strip(), "ran")
            with self.assertRaises(OSError):
                os.fstat(ruleset)
        finally:
            sandbox_runner._LANDLOCK.update(saved[0])
            sandbox_runner._LIBC = saved[1]
            shutil.rmtree(workspace, ignore_errors=True)

    def test_a_child_that_cannot_be_fenced_does_not_run(self):
        # The preexec raising is the parent seeing an error, never a child
        # running unfenced.
        class RefusingLibc:
            def prctl(self, *_args):
                return 0

            def syscall(self, number, *args):
                if number.value == sandbox_runner.LANDLOCK_CREATE_RULESET:
                    return os.open(os.devnull, os.O_RDONLY)
                if number.value == sandbox_runner.LANDLOCK_ADD_RULE:
                    return 0
                return -1

        workspace = tempfile.mkdtemp(prefix="lsdlc-fence-")
        saved = dict(sandbox_runner._LANDLOCK), sandbox_runner._LIBC
        sandbox_runner._LANDLOCK.update(abi=3, note="test")
        sandbox_runner._LIBC = RefusingLibc()
        try:
            with self.assertRaises(subprocess.SubprocessError):
                spawn_child([sys.executable, "-c", "print('ran')"], workspace, 256, 30)
        finally:
            sandbox_runner._LANDLOCK.update(saved[0])
            sandbox_runner._LIBC = saved[1]
            shutil.rmtree(workspace, ignore_errors=True)

    @unittest.skipUnless(sandbox_runner.landlock_abi(), "this kernel has no Landlock")
    def test_the_kernel_refuses_a_sibling_to_a_child_with_no_bootstrap(self):
        # A plain interpreter, no policy of its own: what it cannot read, the
        # kernel refused. This is the layer the Python guard stands in for
        # everywhere else.
        sibling = tempfile.mkdtemp(prefix="lsdlc-")
        workspace = tempfile.mkdtemp(prefix="lsdlc-")
        try:
            with open(os.path.join(sibling, "test_hidden.py"), "w", encoding="utf-8") as fh:
                fh.write("SECRET_HIDDEN_TEST\n")
            code, stdout, stderr, kind = sandbox_runner.run_child(
                [sys.executable, "-I", "-c",
                 "import os, sys\n"
                 "sib, ws = sys.argv[1], os.getcwd()\n"
                 "out = {}\n"
                 "for name, fn in (('list', lambda: os.listdir(sib)),"
                 " ('read', lambda: open(os.path.join(sib, 'test_hidden.py')).read()),"
                 " ('tmp', lambda: os.listdir(os.path.dirname(sib))),"
                 " ('own', lambda: open('mine.txt', 'w').write('x'))):\n"
                 "    try: out[name] = ('ok', str(fn())[:40])\n"
                 "    except OSError as err: out[name] = ('refused', err.errno)\n"
                 "print(out)",
                 sibling],
                workspace, 30, 256,
            )
            self.assertEqual((code, kind), (0, "ok"), stderr)
            self.assertNotIn("SECRET_HIDDEN_TEST", stdout)
            self.assertIn("'list': ('refused'", stdout)
            self.assertIn("'read': ('refused'", stdout)
            self.assertIn("'tmp': ('refused'", stdout)
            self.assertIn("'own': ('ok'", stdout)
        finally:
            shutil.rmtree(sibling, ignore_errors=True)
            shutil.rmtree(workspace, ignore_errors=True)



if __name__ == "__main__":
    unittest.main()
