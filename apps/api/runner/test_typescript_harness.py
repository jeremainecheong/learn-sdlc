"""Tests for the TypeScript side of the sandbox: esbuild, jsdom, await.

The front end's unit tests run in the sandbox's own DOM harness
(jsdom plus esbuild plus the JS_HARNESS test/assert API that already exists)
rather than vitest, because vitest inside the jail is a worker pool, a cache
directory and run-time plugin resolution, and every one of its failure modes
reaches a learner as "the runner died".

Three things have to hold for that to be worth doing, and each is asserted here
against a real child process:

1. a stack frame still names the .tsx the learner opened, at the line they
   wrote, with the source line beside it: the transform is per file and never
   bundled, and node is started with --enable-source-maps, exactly so;
2. a compile failure is a red row per diagnostic that clicks through to the
   line, and never a run that reads "0 tests passed";
3. the seal still holds when the graded implementation is TypeScript, which is
   the whole point of the graded directory being compiled too.

The pre-baked layer carries jsdom, React and Testing Library, so a machine that
has not run the pre-bake skips this file rather than failing it.
"""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sandbox_runner import (  # noqa: E402
    esbuild_cases,
    execute_job,
    runtime_esbuild,
    runtime_node_modules,
    source_line,
    transform_typescript,
)

# The child's PATH is scrubbed to these three directories, so a node outside
# them is invisible to the job unless NODE_BIN names it outright.
CHILD_PATH = "/usr/local/bin:/usr/bin:/bin"

_NODE_BEFORE = None


def node_bin():
    return shutil.which("node", path=CHILD_PATH) or shutil.which("node")


def setUpModule():
    """Skip, rather than fail, on a machine that is not set up.

    A fresh clone has not run `npm run prebake` yet, and a suite that fails
    before the machine is ready teaches nobody anything. CI bakes the layer
    before it runs this directory.
    """
    global _NODE_BEFORE
    if node_bin() is None:
        raise unittest.SkipTest("no node binary on PATH")
    if runtime_node_modules() is None or runtime_esbuild() is None:
        raise unittest.SkipTest(
            "no pre-baked runtime: run `node scripts/prebake.mjs build` first"
        )
    _NODE_BEFORE = os.environ.get("NODE_BIN")
    os.environ["NODE_BIN"] = node_bin()


def tearDownModule():
    if _NODE_BEFORE is None:
        os.environ.pop("NODE_BIN", None)
    else:
        os.environ["NODE_BIN"] = _NODE_BEFORE


def typescript_job(files, test_paths, **extra):
    job = {
        "files": files,
        "mode": "tests",
        "testPaths": test_paths,
        "language": "typescript",
        "transform": {"tool": "esbuild", "jsx": "automatic"},
        "timeoutSeconds": 20,
        "memoryMb": 512,
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


OVERDUE_TS = '''export function isOverdue(due: string | null, today: string): boolean {
  if (!due) return false;
  return due < today;
}
'''

TASK_ROW_TSX = '''import { isOverdue } from '../lib/overdue';

export type Task = { id: number; title: string; due: string | null };

export function TaskRow({ task, today }: { task: Task; today: string }) {
  if (task.title === 'boom') throw new Error('a component that throws');
  const late = isOverdue(task.due, today);
  return (
    <li data-testid={'task-' + task.id}>
      {task.title}
      {late ? <span data-testid="overdue-badge">late</span> : null}
    </li>
  );
}
'''

SUITE_TSX = '''import { render, screen } from '@testing-library/react';
import { TaskRow } from './components/TaskRow';

const LATE = { id: 1, title: 'write report', due: '2026-01-01' };
const ON_TIME = { id: 2, title: 'water the plants', due: '2026-03-01' };

test('a late task shows the badge', () => {
  render(<TaskRow task={LATE} today="2026-02-01" />);
  assert.ok(screen.getByTestId('overdue-badge'));
});

test('a task that is not late has no badge', () => {
  render(<TaskRow task={ON_TIME} today="2026-02-01" />);
  assert.equal(screen.queryAllByTestId('overdue-badge').length, 0);
});

test('a component that throws is an error', () => {
  render(<TaskRow task={{ id: 3, title: 'boom', due: null }} today="2026-02-01" />);
});

test('the badge is spelt right', () => {
  render(<TaskRow task={LATE} today="2026-02-01" />);
  assert.equal(screen.getByTestId('overdue-badge').textContent, 'overdue');
});

test('an awaited promise passes', async () => {
  const value = await Promise.resolve(3);
  assert.equal(value, 3);
});

test('a rejected assertion is still a failure', async () => {
  await Promise.resolve();
  assert.equal(isLate(), false);
});

test('a rejected error is an error', async () => {
  await Promise.reject(new Error('the API said no'));
});

test('an unstubbed fetch is refused', async () => {
  await fetch('/api/tasks');
});

test('a stubbed fetch answers from the map', async () => {
  const response = await fetch('/api/lists');
  const rows = await response.json();
  assert.equal(rows[0].name, 'Inbox');
});

test('an element that is not there is a failure', () => {
  render(<TaskRow task={ON_TIME} today="2026-02-01" />);
  screen.getByTestId('overdue-badge');
});

function isLate() {
  return true;
}
'''

DECLARED_ORDER = [
    'a late task shows the badge',
    'a task that is not late has no badge',
    'a component that throws is an error',
    'the badge is spelt right',
    'an awaited promise passes',
    'a rejected assertion is still a failure',
    'a rejected error is an error',
    'an unstubbed fetch is refused',
    'a stubbed fetch answers from the map',
    'an element that is not there is a failure',
]


class TypeScriptSuiteTest(unittest.TestCase):
    """One React suite, run once, asserted case by case.

    Each job is a process spawn, so the whole contract (jsdom, Testing
    Library, await, the fetch stub, the frames, the run stamp) is proved
    against a single run rather than nine.
    """

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            typescript_job(
                {
                    "web/src/lib/overdue.ts": OVERDUE_TS,
                    "web/src/components/TaskRow.tsx": TASK_ROW_TSX,
                    "web/src/acceptance.test.tsx": SUITE_TSX,
                },
                ["web/src/acceptance.test.tsx"],
                fetchStubs={"/api/lists": [{"id": 1, "name": "Inbox"}]},
                runId="web",
            )
        )
        cls.cases = by_name(cls.result["tests"])

    def test_the_suite_ran(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertFalse(self.result["ok"])
        tests = self.result["tests"]
        self.assertEqual(
            (tests["total"], tests["passed"], tests["failed"], tests["errored"]),
            (10, 4, 3, 3),
        )

    def test_a_react_component_renders_and_is_found_by_test_id(self):
        self.assertEqual(self.cases["a late task shows the badge"]["status"], "passed")

    def test_each_case_starts_from_a_clean_document(self):
        # Testing Library registers its cleanup through afterEach, which the
        # harness provides. Without it the second render leaves the first one
        # in the document and this case finds a badge that belongs to the
        # previous test.
        self.assertEqual(
            self.cases["a task that is not late has no badge"]["status"], "passed"
        )

    def test_a_component_that_throws_names_its_own_file(self):
        case = self.cases["a component that throws is an error"]
        self.assertEqual(case["status"], "errored")
        self.assertEqual(case["message"], "a component that throws")
        frame = case["frames"][0]
        # The .tsx, not the .js esbuild wrote beside it: the inline source map
        # and --enable-source-maps are what make this true.
        self.assertEqual(frame["path"], "web/src/components/TaskRow.tsx")
        self.assertEqual(frame["line"], line_of(TASK_ROW_TSX, "a component that throws"))
        self.assertIn("a component that throws", frame["snippet"])

    def test_an_assertion_in_the_test_file_is_a_failure_with_its_own_frame(self):
        case = self.cases["the badge is spelt right"]
        self.assertEqual(case["status"], "failed")
        frame = case["frames"][0]
        self.assertEqual(frame["path"], "web/src/acceptance.test.tsx")
        self.assertEqual(frame["line"], line_of(SUITE_TSX, "'overdue')"))

    def test_a_resolved_promise_passes(self):
        self.assertEqual(self.cases["an awaited promise passes"]["status"], "passed")

    def test_a_rejected_assertion_is_a_failure_not_an_error(self):
        case = self.cases["a rejected assertion is still a failure"]
        self.assertEqual(case["status"], "failed")
        self.assertEqual(
            case["frames"][0]["path"], "web/src/acceptance.test.tsx"
        )

    def test_a_rejected_error_is_an_error(self):
        case = self.cases["a rejected error is an error"]
        self.assertEqual(case["status"], "errored")
        self.assertEqual(case["message"], "the API said no")

    def test_an_unstubbed_fetch_carries_the_harness_sentence(self):
        case = self.cases["an unstubbed fetch is refused"]
        self.assertEqual(case["status"], "errored")
        self.assertEqual(
            case["message"],
            "this test made a network call; stub it or test the API layer directly",
        )

    def test_a_stubbed_fetch_answers_from_the_map(self):
        self.assertEqual(
            self.cases["a stubbed fetch answers from the map"]["status"], "passed"
        )

    def test_a_missing_element_is_a_failure_not_an_error(self):
        # Testing Library's own error is an assertion in every way that
        # matters, and the Python layer calls the same thing `failed`.
        case = self.cases["an element that is not there is a failure"]
        self.assertEqual(case["status"], "failed")
        self.assertIn("Unable to find an element", case["message"])

    def test_case_order_is_the_packs_order(self):
        # The kill matrix reads case order, so awaiting them one at a time is
        # not an optimisation to be reversed later.
        self.assertEqual(
            [case["name"] for case in self.result["tests"]["cases"]], DECLARED_ORDER
        )

    def test_every_case_carries_a_duration_and_the_run_that_made_it(self):
        for case in self.result["tests"]["cases"]:
            self.assertIsInstance(case["durationMs"], int)
            self.assertEqual(case["step"], "web")

    def test_nothing_leaks_a_host_path(self):
        payload = json.dumps(self.result)
        self.assertNotIn("lsdlc-", payload)
        self.assertNotIn(os.path.dirname(runtime_node_modules()), payload)
        for case in self.result["tests"]["cases"]:
            for frame in case.get("frames", []):
                self.assertFalse(frame["path"].startswith(os.sep), frame["path"])
                self.assertNotIn("node_modules", frame["path"])


class DeadlineTest(unittest.TestCase):
    """A promise that never settles is one errored case, not a dead run."""

    @classmethod
    def setUpClass(cls):
        started = time.monotonic()
        cls.result = execute_job(
            typescript_job(
                {
                    "web/src/hang.test.ts": (
                        "test('a promise that never settles', async () => {\n"
                        "  await new Promise(() => {});\n"
                        "});\n\n"
                        "test('the run carries on', () => {\n"
                        "  assert.equal(1, 1);\n"
                        "  setTimeout(() => {}, 30000);\n"
                        "});\n"
                    )
                },
                ["web/src/hang.test.ts"],
                timeoutSeconds=8,
            )
        )
        cls.elapsed = time.monotonic() - started
        cls.cases = by_name(cls.result["tests"])

    def test_the_hung_case_is_errored_with_a_sentence(self):
        case = self.cases["a promise that never settles"]
        self.assertEqual(case["status"], "errored")
        self.assertIn("did not finish within 2 seconds", case["message"])

    def test_the_run_still_emitted_its_result_line(self):
        # A quarter of the budget per case is what buys this: without the
        # deadline the wall clock kills the child and every case is lost, not
        # just the one that hung.
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertEqual(self.result["tests"]["total"], 2)

    def test_the_case_after_it_still_ran(self):
        self.assertEqual(self.cases["the run carries on"]["status"], "passed")

    def test_a_timer_the_test_left_behind_does_not_hold_the_run(self):
        # The second case leaves a 30 second timer pending. The run has to end
        # when the cases end, not when node's event loop finally empties.
        self.assertLess(self.elapsed, 8)


class CompileFailureTest(unittest.TestCase):
    """TypeScript that does not compile: an errored run AND a case per error."""

    BROKEN_TSX = "export function Broken() {\n  return <div>;\n}\n"
    BROKEN_TS = "export const gap = 1 <<< 2;\n"

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            typescript_job(
                {
                    "web/src/Broken.tsx": cls.BROKEN_TSX,
                    "web/src/lib/gap.ts": cls.BROKEN_TS,
                    "web/src/ok.test.ts": "test('never runs', () => { assert.ok(true); });\n",
                },
                ["web/src/ok.test.ts"],
                runId="web",
            )
        )

    def test_the_run_is_an_error_and_not_an_empty_pass(self):
        self.assertFalse(self.result["ok"])
        self.assertEqual(self.result["exitKind"], "error")

    def test_every_diagnostic_is_its_own_errored_case(self):
        tests = self.result["tests"]
        self.assertEqual(tests["passed"], 0)
        self.assertEqual(tests["errored"], tests["total"])
        self.assertGreaterEqual(tests["total"], 2)
        self.assertEqual(
            {case["name"] for case in tests["cases"]},
            {"web/src/Broken.tsx", "web/src/lib/gap.ts"},
        )

    def test_a_case_clicks_through_to_the_line(self):
        case = next(
            c for c in self.result["tests"]["cases"] if c["name"] == "web/src/lib/gap.ts"
        )
        frame = case["frames"][0]
        self.assertEqual(frame["path"], "web/src/lib/gap.ts")
        self.assertEqual(frame["line"], line_of(self.BROKEN_TS, "gap"))
        self.assertEqual(frame["snippet"], "export const gap = 1 <<< 2;")
        self.assertIn("Expected", case["message"])

    def test_the_diagnostics_are_also_the_runs_stderr(self):
        self.assertIn("[ERROR]", self.result["stderr"])
        self.assertNotIn("lsdlc-", self.result["stderr"])

    def test_a_compile_failure_still_carries_the_run_it_belongs_to(self):
        for case in self.result["tests"]["cases"]:
            self.assertEqual(case["step"], "web")


class NodeModulesIsNotTransformedTest(unittest.TestCase):
    """A dependency directory is not the learner's code and is not compiled."""

    def test_a_broken_dependency_does_not_fail_the_run(self):
        result = execute_job(
            typescript_job(
                {
                    "node_modules/left-pad/index.ts": "export const nope: number = ;\n",
                    "web/src/ok.test.ts": "test('the suite runs', () => { assert.ok(true); });\n",
                },
                ["web/src/ok.test.ts"],
            )
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


class ThrownOffTheStackTest(unittest.TestCase):
    """An exception raised outside the awaited chain fails one case, not the run.

    A React commit inside a jsdom event dispatch, or a callback in a timer, is
    on nobody's try/catch. Node's default handler would kill the child before
    the result line is printed, so one component that throws during an async
    update would come back as "0 tests passed", the failure the per-diagnostic
    compile cases exist to prevent, arriving by a different door.
    """

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            typescript_job(
                {
                    "web/src/derail.test.ts": (
                        "test('a timer throws while the case waits', async () => {\n"
                        "  setTimeout(() => { throw new Error('from a timer'); }, 5);\n"
                        "  await new Promise((resolve) => setTimeout(resolve, 200));\n"
                        "});\n\n"
                        "test('the run carries on', () => {\n"
                        "  assert.equal(1, 1);\n"
                        "});\n"
                    )
                },
                ["web/src/derail.test.ts"],
            )
        )
        cls.cases = by_name(cls.result["tests"])

    def test_the_run_still_reported_its_cases(self):
        self.assertEqual(self.result["exitKind"], "ok")
        self.assertEqual(self.result["tests"]["total"], 2)

    def test_the_case_that_was_running_carries_the_error(self):
        case = self.cases["a timer throws while the case waits"]
        self.assertEqual(case["status"], "errored")
        self.assertEqual(case["message"], "from a timer")

    def test_the_case_after_it_still_passed(self):
        self.assertEqual(self.cases["the run carries on"]["status"], "passed")

    def test_a_throw_from_a_finished_case_is_its_own_case(self):
        # Between two cases nothing is awaiting, so there is no case to blame:
        # it is recorded under its own name rather than pinned on whichever
        # test happened to run next.
        result = execute_job(
            typescript_job(
                {
                    "web/src/late.test.ts": (
                        "test('one, which leaves a throw behind', () => {\n"
                        "  setTimeout(() => { throw new Error('after the case'); }, 0);\n"
                        "  assert.equal(1, 1);\n"
                        "});\n\n"
                        "test('two', () => {\n"
                        "  assert.equal(2, 2);\n"
                        "});\n"
                    )
                },
                ["web/src/late.test.ts"],
            )
        )
        self.assertEqual(
            [(case["name"], case["status"]) for case in result["tests"]["cases"]],
            [
                ("one, which leaves a throw behind", "passed"),
                ("an error outside any test", "errored"),
                ("two", "passed"),
            ],
        )
        self.assertEqual(result["tests"]["cases"][1]["message"], "after the case")

    def test_a_throw_scheduled_before_any_case_is_still_somebodys(self):
        # It lands on whichever case is awaiting when it fires: here the
        # second, because the first never yields. The point is that it is
        # reported at all: the alternative is a dead child and no result line.
        result = execute_job(
            typescript_job(
                {
                    "web/src/loose.test.ts": (
                        "setTimeout(() => { throw new Error('nobody was running'); }, 5);\n\n"
                        "test('something to wait on', async () => {\n"
                        "  assert.equal(1, 1);\n"
                        "});\n\n"
                        "test('and something after it', async () => {\n"
                        "  await new Promise((resolve) => setTimeout(resolve, 100));\n"
                        "});\n"
                    )
                },
                ["web/src/loose.test.ts"],
            )
        )
        self.assertEqual(result["tests"]["total"], 2)
        errored = [case for case in result["tests"]["cases"] if case["status"] == "errored"]
        self.assertEqual(len(errored), 1)
        self.assertEqual(errored[0]["message"], "nobody was running")


class DirectoryTestPathTest(unittest.TestCase):
    """A testPath may name a directory, and the web run's does.

    The front-end run is given `testPaths: ["web/src"]`, and node
    cannot require a directory. Each suite has to run exactly once, whatever the
    transform left beside it.
    """

    @classmethod
    def setUpClass(cls):
        cls.result = execute_job(
            typescript_job(
                {
                    "web/src/lib/overdue.ts": OVERDUE_TS,
                    "web/src/lib/overdue.test.ts": (
                        "import { isOverdue } from './overdue';\n\n"
                        "test('yesterday is overdue', () => {\n"
                        "  assert.equal(isOverdue('2026-01-01', '2026-02-01'), true);\n"
                        "});\n"
                    ),
                    "web/src/components/Badge.test.tsx": (
                        "import { render, screen } from '@testing-library/react';\n\n"
                        "test('the badge renders', () => {\n"
                        "  render(<span data-testid=\"badge\">late</span>);\n"
                        "  assert.ok(screen.getByTestId('badge'));\n"
                        "});\n"
                    ),
                    "web/src/node_modules/left-pad/index.test.js": (
                        "test('a dependency suite is not the learners', () => { assert.ok(false); });\n"
                    ),
                },
                ["web/src"],
            )
        )

    def test_every_suite_under_the_directory_ran(self):
        self.assertTrue(self.result["ok"], self.result)
        self.assertEqual(self.result["tests"]["passed"], 2)

    def test_each_suite_ran_exactly_once(self):
        # After the transform a suite exists as both .test.tsx and the .test.js
        # compiled from it; requiring both would run every case twice.
        names = [case["name"] for case in self.result["tests"]["cases"]]
        self.assertEqual(len(names), len(set(names)))

    def test_the_order_is_stable_and_alphabetical(self):
        self.assertEqual(
            [case["name"] for case in self.result["tests"]["cases"]],
            ["the badge renders", "yesterday is overdue"],
        )

    def test_a_dependency_directory_is_not_walked(self):
        self.assertEqual(self.result["tests"]["total"], 2)

    def test_a_suite_that_will_not_load_is_named_once_and_by_its_source(self):
        # The compiled sibling is not a second suite. Node's module cache hides
        # that for a suite that loads; one that throws is not cached, so
        # requiring both would report the same broken file twice, once under a
        # name the learner does not have.
        result = execute_job(
            typescript_job(
                {
                    "web/src/broken.test.ts": (
                        "import { nope } from './missing';\n\n"
                        "test('never gets here', () => { assert.ok(nope); });\n"
                    )
                },
                ["web/src"],
            )
        )
        self.assertEqual(result["tests"]["errored"], 1)
        self.assertEqual(
            [case["name"] for case in result["tests"]["cases"]], ["web/src/broken.test.ts"]
        )


class TransformIsImpliedByTheLanguageTest(unittest.TestCase):
    """A typescript run compiles whether or not the job spells the transform out.

    The pack declares `transform` and the loader validates it, but TypeScript
    cannot reach node uncompiled: a run that names the language and forgets the
    key is an authoring slip, and the only possible reading of it is the right
    one.
    """

    def test_a_job_with_no_transform_key_still_compiles(self):
        result = execute_job(
            {
                "files": {
                    "web/src/lib/overdue.ts": OVERDUE_TS,
                    "web/src/overdue.test.ts": (
                        "import { isOverdue } from './lib/overdue';\n\n"
                        "test('yesterday is overdue', () => {\n"
                        "  assert.equal(isOverdue('2026-01-01', '2026-02-01'), true);\n"
                        "});\n"
                    ),
                },
                "mode": "tests",
                "testPaths": ["web/src/overdue.test.ts"],
                "language": "typescript",
                "timeoutSeconds": 20,
                "memoryMb": 512,
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


class TransformOnDiskTest(unittest.TestCase):
    """transform_typescript on its own, without a child process."""

    def setUp(self):
        self.workspace = tempfile.mkdtemp(prefix="lsdlc-transform-")
        self.addCleanup(shutil.rmtree, self.workspace, True)

    def write(self, rel, text):
        path = os.path.join(self.workspace, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def test_a_workspace_with_no_typescript_is_left_alone(self):
        self.write("web/src/main.js", "module.exports = 1;\n")
        self.assertIsNone(transform_typescript(self.workspace))
        self.assertEqual(os.listdir(os.path.join(self.workspace, "web/src")), ["main.js"])

    def test_the_source_stays_beside_the_compiled_file(self):
        self.write("web/src/lib/overdue.ts", OVERDUE_TS)
        self.assertIsNone(transform_typescript(self.workspace))
        listing = sorted(os.listdir(os.path.join(self.workspace, "web/src/lib")))
        self.assertEqual(listing, ["overdue.js", "overdue.ts"])
        # The frames read their snippet off the original, so it has to survive.
        self.assertEqual(source_line(os.path.join(self.workspace, "web/src/lib/overdue.ts"), 2),
                         "if (!due) return false;")

    def test_a_failure_comes_back_as_diagnostics(self):
        self.write("web/src/lib/gap.ts", "export const gap = 1 <<< 2;\n")
        diagnostics = transform_typescript(self.workspace)
        self.assertIsNotNone(diagnostics)
        self.assertIn("[ERROR]", diagnostics)
        self.assertIn("web/src/lib/gap.ts:1:", diagnostics)


class EsbuildCasesTest(unittest.TestCase):
    """The diagnostic parser, on esbuild's own output shape."""

    TWO_LOCATIONS = (
        '✘ [ERROR] Unexpected end of file before a closing "div" tag\n'
        "\n"
        "    web/src/Broken.tsx:4:0:\n"
        "      4 │ \n"
        "        ╵ </div>\n"
        "\n"
        "  The opening \"div\" tag is here:\n"
        "\n"
        "    web/src/Broken.tsx:2:10:\n"
        "      2 │   return <div>;\n"
    )

    def test_a_diagnostic_with_two_locations_is_one_case(self):
        cases = esbuild_cases(self.TWO_LOCATIONS, "/nowhere")
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]["frames"], [{"path": "web/src/Broken.tsx", "line": 4}])
        self.assertEqual(cases[0]["status"], "errored")

    def test_a_diagnostic_with_no_location_is_still_a_case(self):
        cases = esbuild_cases("✘ [ERROR] Could not resolve \"react\"\n", "/nowhere")
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]["name"], "esbuild")
        self.assertNotIn("frames", cases[0])

    def test_the_snippet_comes_from_the_file_it_names(self):
        workspace = tempfile.mkdtemp(prefix="lsdlc-diag-")
        self.addCleanup(shutil.rmtree, workspace, True)
        os.makedirs(os.path.join(workspace, "web/src"))
        with open(os.path.join(workspace, "web/src/Broken.tsx"), "w", encoding="utf-8") as fh:
            fh.write("export function Broken() {\n  return <div>;\n}\n")
        cases = esbuild_cases(
            '✘ [ERROR] Expected ">" but found ";"\n\n    web/src/Broken.tsx:2:15:\n',
            workspace,
        )
        self.assertEqual(cases[0]["frames"][0]["snippet"], "return <div>;")

    def test_nothing_at_all_is_no_cases(self):
        self.assertEqual(esbuild_cases("", "/nowhere"), [])
        self.assertEqual(esbuild_cases(None, "/nowhere"), [])


IMPL_TS = OVERDUE_TS
MUTANT_TS = OVERDUE_TS.replace("due < today", "due <= today")

SEAL_SUITE_TS = '''import { isOverdue } from './lib/overdue';
import * as fs from 'fs';

test('a task due yesterday is overdue', () => {
  assert.equal(isOverdue('2026-01-01', '2026-02-01'), true);
});

test('a task due today is not overdue', () => {
  assert.equal(isOverdue('2026-02-01', '2026-02-01'), false);
});

test('the implementation is not on disk', () => {
  for (const p of ['web/src/lib/overdue.ts', 'web/src/lib/overdue.js']) {
    assert.throws(() => fs.readFileSync(p, 'utf8'));
  }
});
'''


class DomSealTest(unittest.TestCase):
    """The seal, ported to the TypeScript path: GradedFiles and GradedShadow.

    A graded implementation written in TypeScript has to be compiled with the
    workspace, because the seal maps the workspace path a graded file WOULD
    have had onto the copy outside it and node resolves an extensionless import
    to `.js`. Leave the reference as TypeScript and the map never matches: the
    suite silently imports the learner's own file, the reference passes, and
    every mutant survives. That is a scoring hole, not a missing feature, which
    is why it is asserted three ways.
    """

    def run_against(self, implementation, extra_files=None):
        files = {"web/src/suite.test.ts": SEAL_SUITE_TS}
        files.update(extra_files or {})
        return execute_job(
            typescript_job(
                files,
                ["web/src/suite.test.ts"],
                gradedFiles={"web/src/lib/overdue.ts": implementation},
            )
        )

    def test_the_suite_runs_against_the_graded_implementation(self):
        result = self.run_against(IMPL_TS)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 3)

    def test_a_mutant_dies(self):
        result = self.run_against(MUTANT_TS)
        self.assertFalse(result["ok"])
        self.assertEqual(result["tests"]["failed"], 1)
        self.assertEqual(
            by_name(result["tests"])["a task due today is not overdue"]["status"], "failed"
        )

    def test_a_workspace_file_of_the_same_name_does_not_shadow_it(self):
        # The learner's own copy compiles to the same relative path. The graded
        # one still has to win, or a phase would grade the learner's code
        # against itself.
        shadow = "export function isOverdue(): boolean {\n  return false;\n}\n"
        result = self.run_against(
            MUTANT_TS, {"web/src/lib/overdue.ts": shadow}
        )
        cases = by_name(result["tests"])
        self.assertEqual(cases["a task due today is not overdue"]["status"], "failed")

    def test_the_graded_path_never_reaches_the_report(self):
        result = self.run_against(IMPL_TS)
        self.assertNotIn("lsdlc-graded", json.dumps(result))

    def test_the_graded_directory_does_not_outlive_the_job(self):
        before = {
            name for name in os.listdir(tempfile.gettempdir())
            if name.startswith("lsdlc-graded-")
        }
        self.run_against(IMPL_TS)
        after = {
            name for name in os.listdir(tempfile.gettempdir())
            if name.startswith("lsdlc-graded-")
        }
        self.assertEqual(after - before, set())


class AddressSpaceTest(unittest.TestCase):
    """A TypeScript run at the laptop profile's memory still runs.

    RLIMIT_AS is skipped for every node child, and this is the consequence
    rather than the rule: under an address-space cap of 256 MB, node reserves
    its code range, dies before the harness prints anything, and the run comes
    back with no result line at all. On macOS the rlimit is refused by the
    kernel, so this case is honest only in the container and in CI, which is
    exactly where RUN_MEMORY_MB=256 is a documented profile.
    """

    def test_a_run_at_256_mb_still_reports_its_cases(self):
        result = execute_job(
            typescript_job(
                {
                    "web/src/small.test.tsx": (
                        "import { render, screen } from '@testing-library/react';\n\n"
                        "test('a component renders inside the cap', () => {\n"
                        "  render(<p data-testid=\"here\">here</p>);\n"
                        "  assert.ok(screen.getByTestId('here'));\n"
                        "});\n"
                    )
                },
                ["web/src/small.test.tsx"],
                memoryMb=256,
            )
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


class PlainJavaScriptIsUnchangedTest(unittest.TestCase):
    """The JavaScript path keeps its own shape: no DOM, no transform.

    The await loop is the harness's, not TypeScript's, so a plain JavaScript
    pack gets it too; the jsdom window is not, because a pack that never asked
    for a DOM should not pay for one and should not be able to depend on it by
    accident.
    """

    def test_an_async_test_passes_without_a_dom(self):
        result = execute_job(
            {
                "files": {
                    "test_visible.js": (
                        "test('the document is not defined', () => {\n"
                        "  assert.equal(typeof document, 'undefined');\n"
                        "});\n\n"
                        "test('an awaited promise still passes', async () => {\n"
                        "  assert.equal(await Promise.resolve(2), 2);\n"
                        "});\n"
                    )
                },
                "mode": "tests",
                "testPaths": ["test_visible.js"],
                "language": "javascript",
                "timeoutSeconds": 20,
                "memoryMb": 256,
            }
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 2)


@unittest.skipIf(runtime_esbuild() is None or runtime_node_modules() is None,
                 "the pre-baked layer is not built; run npm run prebake")
class GradedSuiteImportsTheWorkspaceTest(unittest.TestCase):
    """A sealed suite is the graded artefact on a code phase, and it imports the
    learner's own file.

    The seal resolves a workspace path onto the graded copy; it must also
    resolve the other way round, or a graded suite requiring `./lib/overdue`
    relatively throws inside the seal (before any test runs), and the whole
    run comes back with `tests: None`: no cases to read and nothing to click.
    """

    def test_a_graded_suite_can_import_the_workspace_relatively(self):
        result = execute_job(typescript_job(
            {"web/src/lib/overdue.ts": IMPL_TS},
            ["web/src/suite.hidden.test.ts"],
            gradedFiles={
                "web/src/suite.hidden.test.ts":
                    "import { isOverdue } from './lib/overdue';\n"
                    "test('due today is not overdue', () => {\n"
                    "  assert.equal(isOverdue('2026-03-14', '2026-03-14'), false);\n"
                    "});\n"
            },
        ))
        self.assertIsNotNone(result["tests"], f"the run printed no result line at all: {result}")
        self.assertEqual(result["tests"]["passed"], 1, result)

    def test_a_graded_suite_still_gets_the_graded_copy_of_a_graded_neighbour(self):
        """The half the mapping must not break: graded beats workspace, always.

        Without the ordering inside that resolution (graded map first, real
        resolver second), a graded file importing a graded sibling would be sent
        back to the workspace, where the learner's own file is, and every mutant
        would be graded against the learner's code instead of the reference.
        """
        result = execute_job(typescript_job(
            {"web/src/lib/overdue.ts": MUTANT_TS},
            ["web/src/suite.hidden.test.ts"],
            gradedFiles={
                "web/src/lib/overdue.ts": IMPL_TS,
                "web/src/suite.hidden.test.ts":
                    "import { isOverdue } from './lib/overdue';\n"
                    "test('due today is not overdue', () => {\n"
                    "  assert.equal(isOverdue('2026-03-14', '2026-03-14'), false);\n"
                    "});\n"
            },
        ))
        self.assertIsNotNone(result["tests"], result)
        self.assertEqual(result["tests"]["passed"], 1, result)


if __name__ == "__main__":
    unittest.main()


class ATransportWithoutNodeTest(unittest.TestCase):
    """The Lambda shape: the pre-baked Python tree is here, node is not.

    scripts/localstack-lambda.sh packages a python3.11 function with no node in
    it, so a JavaScript job there has nothing to run on. It is answered before
    anything is spawned (`unavailable`, no verdict, a sentence that names the
    limit), because a spawn that raises FileNotFoundError would come back as a
    failed run with no cases, and the grader would read "the front-end suite
    failed" about a learner whose code never ran.
    """

    def setUp(self):
        self._node = os.environ.get("NODE_BIN")
        os.environ["NODE_BIN"] = "/nonexistent/lambda-has-no/node"

    def tearDown(self):
        if self._node is None:
            os.environ.pop("NODE_BIN", None)
        else:
            os.environ["NODE_BIN"] = self._node

    def test_a_javascript_job_is_unavailable_and_says_why(self):
        result = execute_job(typescript_job(
            {"x.test.ts": "test('ok', () => { assert.ok(true); });"}, ["x.test.ts"],
        ))
        self.assertEqual(result["exitKind"], "unavailable")
        self.assertFalse(result["ok"])
        self.assertIsNone(result["tests"])
        self.assertIn("cannot run JavaScript", result["stderr"])
        self.assertIn("RUNNER_MODE=local or socket", result["stderr"])

    def test_the_lambda_handler_returns_the_same_envelope(self):
        import lambda_handler  # noqa: WPS433 (the two-file package under test)
        result = lambda_handler.handler(typescript_job(
            {"x.test.ts": "test('ok', () => { assert.ok(true); });"}, ["x.test.ts"],
        ), None)
        self.assertEqual(result["exitKind"], "unavailable")
        self.assertIsNone(result["tests"])

    def test_a_python_job_still_runs_on_that_transport(self):
        result = execute_job({
            "files": {"tests/test_x.py": (
                "import unittest\n"
                "class T(unittest.TestCase):\n"
                "    def test_ok(self):\n"
                "        self.assertEqual(1 + 1, 2)\n"
            )},
            "mode": "tests", "testPaths": ["tests/test_x.py"],
            "timeoutSeconds": 10, "memoryMb": 128,
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["tests"]["passed"], 1)


class AssertionsOnDomNodesTest(unittest.TestCase):
    """A DOM assertion that fails is a failed case, not a dead process.

    node's assert describes both operands by inspecting them to depth 1000; a
    node that React has rendered carries its fiber, and the fiber reaches the
    whole tree, so the description never finishes and the child grows by a
    gigabyte a second until the kernel kills it (`exitKind: "memory"`, no
    cases). The harness answers the four shallow comparisons itself when a DOM
    node is involved, with node's own predicate and node's own AssertionError.
    """

    SUITE = '''import { render, screen } from '@testing-library/react';
import { TaskRow } from './components/TaskRow';

test('a late task wears the badge (a wrong expectation, on purpose)', () => {
  render(<TaskRow task={{ id: 1, title: 'rent', due: '2026-01-01' }} today="2026-01-04" />);
  assert.strictEqual(screen.queryByTestId('overdue-badge'), null);
});

test('a task without a due date has no badge', () => {
  render(<TaskRow task={{ id: 2, title: 'walk', due: null }} today="2026-01-04" />);
  assert.strictEqual(screen.queryByTestId('overdue-badge'), null);
});

test('the same node is itself', () => {
  render(<TaskRow task={{ id: 3, title: 'read', due: '2026-01-01' }} today="2026-01-04" />);
  const badge = screen.getByTestId('overdue-badge');
  assert.strictEqual(badge, screen.getByTestId('overdue-badge'));
  assert.notStrictEqual(badge, screen.getByTestId('task-3'));
});
'''

    def test_a_failing_dom_comparison_is_a_failed_case_with_a_short_message(self):
        result = execute_job(typescript_job({
            "src/lib/overdue.ts": OVERDUE_TS,
            "src/components/TaskRow.tsx": TASK_ROW_TSX,
            "src/badge.test.tsx": self.SUITE,
        }, ["src/badge.test.tsx"], timeoutSeconds=20, memoryMb=256))
        self.assertIsNotNone(result["tests"], result)
        cases = by_name(result["tests"])
        wrong = cases["a late task wears the badge (a wrong expectation, on purpose)"]
        self.assertEqual(wrong["status"], "failed", wrong)
        self.assertIn('<span data-testid="overdue-badge"> late is null', wrong["message"])
        self.assertLess(len(wrong["message"]), 300)
        self.assertEqual(cases["a task without a due date has no badge"]["status"], "passed")
        self.assertEqual(cases["the same node is itself"]["status"], "passed")
        self.assertEqual(result["tests"]["failed"], 1)
        self.assertEqual(result["tests"]["passed"], 2)
