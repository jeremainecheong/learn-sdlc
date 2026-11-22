"""Tests for the static analyzer: the existing rules and metrics, plus the
functions[]/imports[] structural index the later phases read.

Run: python3 -m unittest discover -s apps/api/runner -p 'test_analyzer.py'
"""

import json
import pathlib
import subprocess
import sys
import textwrap
import unittest

import analyzer

RUNNER_DIR = pathlib.Path(__file__).resolve().parent
CONTENT_DIR = RUNNER_DIR.parents[2] / "content"

JS_SAMPLE = """'use strict';

const { TaskManager, PRIORITIES } = require('./taskmanager');
import defaultExport, { helper as aid } from './helpers.js';
import * as util from 'node:util';

class Store {
  constructor() {
    this._items = new Map();
  }

  /** Add one item and return it. */
  addItem(item) {
    if (!item) throw new Error('empty');
    this._items.set(item.id, item);
    return item;
  }
}

function report(store) {
  return [...store._items.values()].filter((i) => i.open);
}

const shout = (text) => text.toUpperCase();
const quiet = text => text.toLowerCase();

module.exports = { Store, report, shout, quiet };
"""


def python_report(source, path="sample.py"):
    """analyze_python_file with collectors attached, the way main() calls it."""
    issues, functions, imports = [], [], []
    metrics = analyzer.analyze_python_file(path, textwrap.dedent(source), issues, functions, imports)
    return metrics, issues, functions, imports


def js_report(source, path="sample.js"):
    issues, functions, imports = [], [], []
    metrics = analyzer.analyze_js_file(path, source, issues, functions, imports)
    return metrics, issues, functions, imports


def run_analyzer(files, language):
    """Spawn analyzer.py exactly as SandboxService.analyze does: JSON on stdin."""
    job = {"files": files, "targets": sorted(files), "language": language}
    finished = subprocess.run(
        [sys.executable, str(RUNNER_DIR / "analyzer.py")],
        input=json.dumps(job), capture_output=True, text=True, timeout=20,
    )
    if finished.returncode != 0:
        raise AssertionError(f"analyzer exited {finished.returncode}: {finished.stderr}")
    return json.loads(finished.stdout)


def by_qualname(functions):
    return {fn["qualname"]: fn for fn in functions}


class PythonFunctionIndex(unittest.TestCase):
    SOURCE = """
        import json

        class Vault:
            def store(self, item):
                \"\"\"Keep the item.\"\"\"
                key = self.key_for(item)
                if key:
                    self.items[key] = json.dumps(item)
                    self.items[key] = self.items[key]
                return key

        def outer(values):
            def inner(value):
                return value + 1

            return [inner(v) for v in values]
        """

    def setUp(self):
        _, _, self.functions, _ = python_report(self.SOURCE, "vault.py")
        self.index = by_qualname(self.functions)

    def test_indexes_methods_and_nested_definitions_in_source_order(self):
        # A nested def follows its parent, so a reader of the ledger sees the
        # enclosing function first.
        self.assertEqual(
            [fn["qualname"] for fn in self.functions],
            ["Vault.store", "outer", "outer.inner"],
        )

    def test_records_name_path_and_span(self):
        store = self.index["Vault.store"]
        self.assertEqual(store["name"], "store")
        self.assertEqual(store["path"], "vault.py")
        self.assertEqual(store["line"], 5)
        self.assertEqual(store["endLine"], 11)

    def test_complexity_matches_the_existing_rule(self):
        node_scores = [fn["complexity"] for fn in self.functions]
        self.assertEqual(self.index["Vault.store"]["complexity"], 2)  # 1 + the if
        self.assertTrue(all(score >= 1 for score in node_scores))

    def test_calls_are_deduplicated_last_segment_names_in_first_use_order(self):
        self.assertEqual(self.index["Vault.store"]["calls"], ["key_for", "dumps"])
        self.assertEqual(self.index["outer"]["calls"], ["inner"])

    def test_body_hash_is_a_sha1_hex_digest(self):
        digest = self.index["outer.inner"]["bodyHash"]
        self.assertRegex(digest, r"^[0-9a-f]{40}$")

    def test_every_function_carries_the_full_field_set(self):
        for fn in self.functions:
            self.assertEqual(
                sorted(fn),
                ["bodyHash", "calls", "complexity", "endLine", "line", "name", "path", "qualname"],
            )


class PythonBodyHash(unittest.TestCase):
    def hash_of(self, source):
        _, _, functions, _ = python_report(source)
        return functions[0]["bodyHash"]

    def test_layout_docstrings_and_comments_are_not_a_change(self):
        original = """
            def decide(x):
                \"\"\"Decide.\"\"\"
                if x > 1:
                    return "high"
                return "low"
            """
        reformatted = """
            def decide(x):

                \"\"\"Rewritten prose, same behaviour.\"\"\"
                # explain the threshold
                if x > 1:
                        return "high"

                return "low"
            """
        self.assertEqual(self.hash_of(original), self.hash_of(reformatted))

    def test_a_changed_statement_changes_the_hash(self):
        before = """
            def decide(x):
                if x > 1:
                    return "high"
                return "low"
            """
        after = """
            def decide(x):
                if x > 2:
                    return "high"
                return "low"
            """
        self.assertNotEqual(self.hash_of(before), self.hash_of(after))

    def test_a_renamed_function_keeps_its_body_hash(self):
        # The maintenance impact report pairs functions by name; an unchanged body
        # must hash the same so a rename does not read as a behaviour change.
        self.assertEqual(
            self.hash_of("def a(x):\n    return x + 1\n"),
            self.hash_of("def b(x):\n    return x + 1\n"),
        )


class PythonImportIndex(unittest.TestCase):
    SOURCE = """
        import json
        import os.path as p
        from datetime import date, datetime as dt
        from .models import Task
        from ..pkg import *
        """

    def test_records_module_names_path_and_line(self):
        _, _, _, imports = python_report(self.SOURCE, "cli.py")
        self.assertEqual(imports, [
            {"module": "json", "names": [], "path": "cli.py", "line": 2},
            {"module": "os.path", "names": ["p"], "path": "cli.py", "line": 3},
            {"module": "datetime", "names": ["date", "dt"], "path": "cli.py", "line": 4},
            {"module": ".models", "names": ["Task"], "path": "cli.py", "line": 5},
            {"module": "..pkg", "names": ["*"], "path": "cli.py", "line": 6},
        ])

    def test_a_function_local_import_is_indexed_too(self):
        _, _, _, imports = python_report("def f():\n    import csv\n    return csv\n")
        self.assertEqual([entry["module"] for entry in imports], ["csv"])


class ExistingRulesUnchanged(unittest.TestCase):
    """The metrics block feeds feedback/checkers.ts scoreCodeQuality; the rules are
    asserted by content.spec.ts. Neither may drift when the index is added."""

    SOURCE = """
        import subprocess

        def wide(a, b):
            # TODO(learner) finish this
            raise NotImplementedError("todo")
        """

    def test_rules_and_metric_keys_survive(self):
        metrics, issues, _, _ = python_report(self.SOURCE, "wide.py")
        self.assertEqual(
            sorted({issue["rule"] for issue in issues}),
            ["banned-import", "missing-docstring", "not-implemented", "todo-remaining"],
        )
        self.assertEqual(metrics, {"functions": 1, "documented": 0, "todos": 1, "maxComplexity": 1})

    def test_collectors_are_optional(self):
        # analyze_python_file keeps its three-argument form for callers that only want issues.
        issues = []
        metrics = analyzer.analyze_python_file("wide.py", textwrap.dedent(self.SOURCE), issues)
        self.assertEqual(metrics["functions"], 1)
        self.assertTrue(issues)

    def test_a_syntax_error_reports_the_rule_and_no_index(self):
        metrics, issues, functions, imports = python_report("def broken(:\n    pass\n")
        self.assertEqual([issue["rule"] for issue in issues], ["syntax-error"])
        self.assertEqual(functions, [])
        self.assertEqual(imports, [])
        self.assertEqual(metrics["functions"], 0)

    def test_report_keys(self):
        report = run_analyzer({"a.py": "def f():\n    return 1\n"}, "python")
        self.assertEqual(sorted(report), ["functions", "imports", "issues", "metrics"])
        self.assertEqual(
            sorted(report["metrics"]),
            ["docstringCoverage", "files", "functions", "maxComplexity", "todosRemaining"],
        )


class Caps(unittest.TestCase):
    def test_at_most_200_functions_are_reported(self):
        source = "".join(f"def f{i}():\n    return {i}\n\n" for i in range(250))
        _, _, functions, _ = python_report(source)
        self.assertEqual(len(functions), analyzer.MAX_FUNCTIONS)
        self.assertEqual(functions[0]["name"], "f0")
        self.assertEqual(functions[-1]["name"], "f199")

    def test_at_most_200_imports_are_reported(self):
        source = "".join(f"import mod{i}\n" for i in range(250))
        _, _, _, imports = python_report(source)
        self.assertEqual(len(imports), analyzer.MAX_IMPORTS)

    def test_at_most_50_calls_per_function(self):
        body = "".join(f"    call{i}()\n" for i in range(80))
        _, _, functions, _ = python_report(f"def f():\n{body}")
        self.assertEqual(len(functions[0]["calls"]), analyzer.MAX_CALLS)

    def test_the_cap_holds_across_files(self):
        files = {f"m{i}.py": "".join(f"def g{j}():\n    return {j}\n\n" for j in range(60))
                 for i in range(5)}
        report = run_analyzer(files, "python")
        self.assertEqual(len(report["functions"]), analyzer.MAX_FUNCTIONS)


class JavaScriptIndex(unittest.TestCase):
    def setUp(self):
        _, _, self.functions, self.imports = js_report(JS_SAMPLE, "store.js")
        self.index = by_qualname(self.functions)

    def test_indexes_declarations_methods_and_arrows_in_source_order(self):
        self.assertEqual(
            [fn["qualname"] for fn in self.functions],
            ["Store.constructor", "Store.addItem", "report", "shout", "quiet"],
        )

    def test_qualifies_methods_with_their_class(self):
        method = self.index["Store.addItem"]
        self.assertEqual(method["name"], "addItem")
        self.assertEqual(method["path"], "store.js")
        self.assertEqual(method["line"], 13)
        self.assertEqual(method["endLine"], 17)

    def test_records_calls_and_complexity(self):
        self.assertEqual(self.index["Store.addItem"]["calls"], ["Error", "set"])
        self.assertEqual(self.index["Store.addItem"]["complexity"], 2)  # 1 + the if
        self.assertEqual(self.index["report"]["calls"], ["values", "filter"])

    def test_concise_and_parenthesised_arrows_both_get_a_body(self):
        self.assertEqual(self.index["shout"]["calls"], ["toUpperCase"])
        self.assertEqual(self.index["quiet"]["calls"], ["toLowerCase"])

    def test_body_hash_ignores_comments_and_layout(self):
        spaced = JS_SAMPLE.replace(
            "    if (!item) throw new Error('empty');",
            "\n    // guard first\n    if (!item)   throw new Error('empty');\n",
        )
        _, _, functions, _ = js_report(spaced, "store.js")
        self.assertEqual(
            by_qualname(functions)["Store.addItem"]["bodyHash"],
            self.index["Store.addItem"]["bodyHash"],
        )

    def test_a_changed_body_changes_the_hash(self):
        edited = JS_SAMPLE.replace("throw new Error('empty')", "throw new Error('missing')")
        _, _, functions, _ = js_report(edited, "store.js")
        self.assertNotEqual(
            by_qualname(functions)["Store.addItem"]["bodyHash"],
            self.index["Store.addItem"]["bodyHash"],
        )

    def test_indexes_require_and_esm_imports(self):
        self.assertEqual(self.imports, [
            {"module": "./taskmanager", "names": ["TaskManager", "PRIORITIES"],
             "path": "store.js", "line": 3},
            {"module": "./helpers.js", "names": ["defaultExport", "aid"],
             "path": "store.js", "line": 4},
            {"module": "node:util", "names": ["util"], "path": "store.js", "line": 5},
        ])

    def test_control_flow_is_not_mistaken_for_a_function(self):
        source = ("function run(items) {\n"
                  "  if (items.length) {\n"
                  "    for (const item of items) console.log(item);\n"
                  "  }\n"
                  "  switch (items.length) {\n"
                  "    case 0:\n"
                  "      return 0;\n"
                  "  }\n"
                  "  try { run([]); } catch (err) { return -1; }\n"
                  "  return items.length;\n"
                  "}\n"
                  "run(process.argv);\n")
        _, _, functions, _ = js_report(source)
        self.assertEqual([fn["qualname"] for fn in functions], ["run"])

    def test_a_brace_in_a_string_does_not_unbalance_the_body(self):
        source = "function shape() {\n  return '} not the end {';\n}\nconst after = (x) => x;\n"
        _, _, functions, _ = js_report(source)
        self.assertEqual([fn["qualname"] for fn in functions], ["shape", "after"])
        self.assertEqual(functions[0]["endLine"], 3)

    def test_js_metrics_keep_their_existing_shape(self):
        metrics, _, _, _ = js_report(JS_SAMPLE)
        self.assertEqual(sorted(metrics), ["documented", "functions", "maxComplexity", "todos"])
        self.assertEqual(metrics["documented"], metrics["functions"])


@unittest.skipUnless(CONTENT_DIR.is_dir(), "content packs are not part of the runner image")
class CanonicalContent(unittest.TestCase):
    """The index over the canonical solution, through the real invocation."""

    def report_for(self, project, language, suffix):
        base = CONTENT_DIR / project / "canonical"
        files = {str(p.relative_to(base)): p.read_text() for p in sorted(base.rglob("*" + suffix))}
        self.assertTrue(files, f"no {suffix} sources under {base}")
        return run_analyzer(files, language)

    def test_tasktrackr_python_index(self):
        # The canonical solution is a Flask application. The qualnames, the
        # path and the import edge below are the application's own; the
        # assertions check that the index names what the maintenance impact
        # report looks up, and that every entry carries a path, a line and a
        # body hash.
        report = self.report_for("tasktrackr", "python", ".py")
        index = by_qualname(report["functions"])
        self.assertEqual(report["metrics"]["functions"], len(report["functions"]))
        for qualname in ("create_app", "list_tasks", "overdue_tasks", "init_db"):
            self.assertIn(qualname, index)
        create_app = index["create_app"]
        self.assertEqual(create_app["path"], "api/main.py")
        self.assertEqual(create_app["line"], 29)
        self.assertIn("init_db", create_app["calls"])
        self.assertRegex(create_app["bodyHash"], r"^[0-9a-f]{40}$")
        # A two-package application defines the same name in two modules
        # (`get_task` is a repository function and a route), so the index has to
        # carry one entry per module. `by_qualname` keys on the qualname alone
        # and keeps only the last, which is why this reads the list itself.
        paths = sorted(fn["path"] for fn in report["functions"] if fn["qualname"] == "get_task")
        self.assertEqual(paths, ["api/repository/tasks.py", "api/routes/tasks.py"])
        self.assertIn(
            {"module": "api.db", "names": ["connect"],
             "path": "api/routes/tasks.py", "line": 12},
            report["imports"],
        )

    def test_a_mutant_changes_exactly_one_body_hash(self):
        # What the maintenance impact report needs: each testing-phase mutant edits one
        # function, so exactly one bodyHash may move against the reference solution.
        #
        # A mutant overlays its own path inside the canonical application, so
        # the reference is the canonical file AT THAT SAME PATH. A mutant
        # directory holding no .py is a front-end mutant, and the analyzer
        # skips TypeScript by extension, so it is counted and skipped rather than parsed as
        # Python, but `checked` is asserted, or a rename would silently make
        # this loop examine nothing at all.
        canonical = CONTENT_DIR / "tasktrackr" / "canonical"
        mutants = CONTENT_DIR / "tasktrackr" / "phases" / "04-testing" / "mutants"
        checked = 0
        skipped = []
        for mutant in sorted(p for p in mutants.iterdir() if p.is_dir()):
            sources = sorted(mutant.rglob("*.py"))
            if not sources:
                skipped.append(mutant.name)
                continue
            for path in sources:
                rel = path.relative_to(mutant)
                reference = {fn["qualname"]: fn["bodyHash"]
                             for fn in run_analyzer(
                                 {str(rel): (canonical / rel).read_text()}, "python")["functions"]}
                self.assertTrue(reference, f"no functions indexed for {rel}")
                mutated = {fn["qualname"]: fn["bodyHash"]
                           for fn in run_analyzer(
                               {str(rel): path.read_text()}, "python")["functions"]}
                with self.subTest(mutant=mutant.name, source=str(rel)):
                    self.assertEqual(sorted(reference), sorted(mutated))
                    moved = [name for name in reference if reference[name] != mutated[name]]
                    self.assertEqual(len(moved), 1, f"{mutant.name} moved {moved}")
                checked += 1
        self.assertEqual(checked, 6, f"python mutants checked: {checked}")
        self.assertEqual(skipped, ["badge_ignores_completion", "filters_drop_the_search"])

    def test_the_index_is_stable_across_runs(self):
        first = self.report_for("tasktrackr", "python", ".py")
        second = self.report_for("tasktrackr", "python", ".py")
        self.assertEqual(first["functions"], second["functions"])
        self.assertEqual(first["imports"], second["imports"])


class JavaScriptProjectIndex(unittest.TestCase):
    """The same index over a JavaScript project, through the real invocation.

    The repository holds one reference pack, and its front end is TypeScript,
    which the analyzer skips by extension. The analyzer's JavaScript path is
    still live (a pack may ship JavaScript), so its coverage comes from a
    project written here.
    """

    FILES = {
        "taskmanager.js": """'use strict';

/** Owns the tasks and every operation on them. */
class TaskManager {
  constructor() {
    this._tasks = new Map();
    this._nextId = 1;
  }

  /** Create a task, assign the next id and return it. */
  addTask(title, { priority = 'medium', dueDate = null } = {}) {
    const task = { id: this._nextId, title, priority, dueDate, completed: false };
    this._tasks.set(task.id, task);
    this._nextId += 1;
    return task;
  }

  /** The tasks matching every filter given, in insertion order. */
  filterTasks({ priority = null, completed = null } = {}) {
    return [...this._tasks.values()].filter(
      (t) => (priority === null || t.priority === priority)
        && (completed === null || t.completed === completed),
    );
  }

  /** The open tasks due strictly before `today`. */
  overdueTasks(today) {
    return this.filterTasks({ completed: false }).filter((t) => t.dueDate && t.dueDate < today);
  }
}

module.exports = { TaskManager };
""",
        "cli.js": """'use strict';

const { TaskManager } = require('./taskmanager');

/** Minimal command line over an in-memory TaskManager. */
function main(argv) {
  const mgr = new TaskManager();
  const [command, ...rest] = argv;
  if (command === 'add') {
    const task = mgr.addTask(rest.join(' ') || 'Untitled', { priority: 'high' });
    console.log(`added #${task.id} ${task.title}`);
    return 0;
  }
  return 1;
}

module.exports = { main };
""",
    }

    def test_javascript_index(self):
        report = run_analyzer(self.FILES, "javascript")
        index = by_qualname(report["functions"])
        for qualname in ("TaskManager.addTask", "TaskManager.filterTasks",
                         "TaskManager.overdueTasks", "main"):
            self.assertIn(qualname, index)
        self.assertEqual(index["TaskManager.addTask"]["path"], "taskmanager.js")
        self.assertIn("filterTasks", index["TaskManager.overdueTasks"]["calls"])
        self.assertIn("addTask", index["main"]["calls"])
        self.assertEqual(
            [entry["module"] for entry in report["imports"]], ["./taskmanager"],
        )


class TargetsInTwoLanguages(unittest.TestCase):
    """One job, two languages: the parser is chosen per file, not per job.

    A full-stack phase has editable targets on both sides of the contract, and
    they arrive in one analyze job. Before this the job's single `language`
    picked one parser for all of them, so a TypeScript target went to Python's
    ast, came back as a syntax error, and cost the learner the whole
    code_quality weight for a file the analyzer simply cannot read.
    """

    FILES = {
        "api/repository/tasks.py": (
            '"""Tasks, as rows."""\n'
            "\n"
            "\n"
            "def overdue(rows, today):\n"
            '    """Open tasks whose due date is strictly before today."""\n'
            "    return [r for r in rows if r['due'] and r['due'] < today]\n"
        ),
        # Valid TypeScript, and not valid Python: a type annotation on a
        # parameter list is a syntax error to ast, which is the whole point.
        "web/src/lib/overdue.ts": (
            "export function isOverdue(task: { due: string | null }, today: string): boolean {\n"
            "  return task.due !== null && task.due < today;\n"
            "}\n"
        ),
        "web/src/legacy/report.js": (
            "'use strict';\n"
            "\n"
            "/** The report, before it was rewritten in TypeScript. */\n"
            "function buildReport(tasks) {\n"
            "  return tasks.filter((t) => t.due);\n"
            "}\n"
            "\n"
            "module.exports = { buildReport };\n"
        ),
    }

    @classmethod
    def setUpClass(cls):
        cls.report = run_analyzer(cls.FILES, "python")

    def test_the_typescript_target_is_not_reported_as_a_syntax_error(self):
        for issue in self.report["issues"]:
            self.assertNotEqual(issue["rule"], "syntax-error", issue)
            self.assertNotEqual(issue["path"], "web/src/lib/overdue.ts", issue)

    def test_the_javascript_target_is_read_by_the_javascript_parser(self):
        # Python's ast would have refused the arrow function; the JS parser
        # indexes it, which is how we know which one ran.
        index = by_qualname(self.report["functions"])
        self.assertIn("buildReport", index)
        self.assertEqual(index["buildReport"]["path"], "web/src/legacy/report.js")

    def test_the_python_target_is_still_read_by_the_python_parser(self):
        index = by_qualname(self.report["functions"])
        self.assertIn("overdue", index)
        self.assertEqual(index["overdue"]["path"], "api/repository/tasks.py")

    def test_files_counts_what_was_analysable(self):
        # Three targets, two the analyzer has a parser for. The count is what
        # the code_quality score is divided by, so counting a file we skipped
        # would quietly dilute every score.
        self.assertEqual(self.report["metrics"]["files"], 2)


if __name__ == "__main__":
    unittest.main()
