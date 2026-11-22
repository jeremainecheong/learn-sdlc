"""Tests for the pre-baked dependency layer: the allowlist and the script.

A graded run has no network and no package manager, so every library a learner's
code imports has to be on disk before the first job arrives. Two things keep
that honest, and both are tested here: `runtime_manifest.py`, which says what
may be baked at all, and `scripts/prebake.mjs`, which bakes it and then checks
that what is here is what the packs asked for.

Wrong answers this suite exists to catch: a pack quietly adding a dependency by
editing content; a machine whose layer was built before a version moved; an
esbuild binary that is not the one we reviewed; and a missing layer reported as
anything other than the sentence naming the command that fixes it.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runtime_manifest  # noqa: E402
import sandbox_runner  # noqa: E402

RUNNER_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(RUNNER_DIR, "..", "..", ".."))
PREBAKE = os.path.join(REPO_ROOT, "scripts", "prebake.mjs")

# The runtime block the one pack declares in its project.json. Written here so
# the script can be driven without a pack on disk, and so a change to the pack's
# pins shows up as a failing test rather than as a surprise in a lab.
FIXTURE_RUNTIME = {
    "python": {
        "version": "3.11",
        "packages": [
            "flask==3.1.3", "werkzeug==3.1.8", "jinja2==3.1.6", "itsdangerous==2.2.0",
            "click==8.3.3", "markupsafe==2.1.5", "blinker==1.9.0",
            "pytest==9.0.3", "pluggy==1.5.0", "iniconfig==2.0.0", "packaging==24.2",
            "pygments==2.21.0",
        ],
    },
    "node": {
        "version": "22",
        "packages": {
            "react": "18.3.1", "react-dom": "18.3.1", "react-router-dom": "7.18.2",
            "jsdom": "25.0.1",
            "@testing-library/react": "16.1.0", "@testing-library/dom": "10.4.0",
        },
        "tools": {"esbuild": "0.25.0"},
    },
}


def node_bin():
    return shutil.which("node")


def write_pack(root, runtime):
    """A content directory with one pack in it, for PREBAKE_CONTENT_DIR."""
    pack = os.path.join(root, "tasktrackr")
    os.makedirs(pack, exist_ok=True)
    with open(os.path.join(pack, "project.json"), "w", encoding="utf-8") as fh:
        json.dump({"slug": "tasktrackr", "runtime": runtime}, fh)
    return root


def prebake(command, content_dir, runtime_dir=None):
    env = dict(os.environ)
    env["PREBAKE_CONTENT_DIR"] = content_dir
    if runtime_dir is not None:
        env["RUNNER_RUNTIME_DIR"] = runtime_dir
    return subprocess.run(
        [node_bin(), PREBAKE, command],
        capture_output=True, text=True, timeout=120, env=env, cwd=REPO_ROOT,
    )


class AllowlistTest(unittest.TestCase):
    """What a pack may declare, and the sentence it gets when it may not."""

    def test_every_package_the_pack_declares_is_on_the_allowlist(self):
        for spec in FIXTURE_RUNTIME["python"]["packages"]:
            self.assertIsNone(runtime_manifest.check_python_spec(spec), spec)
        for name, version in FIXTURE_RUNTIME["node"]["packages"].items():
            self.assertIsNone(runtime_manifest.check_node_package(name, version), name)
        for name, version in FIXTURE_RUNTIME["node"]["tools"].items():
            self.assertIsNone(runtime_manifest.check_tool(name, version), name)

    def test_a_package_that_is_not_on_the_allowlist_is_refused_by_name(self):
        # Adding a dependency to the sandbox is a code change with a review.
        # This is the one place the pack is not the authority, and the message
        # has to say where the decision lives.
        problem = runtime_manifest.check_python_spec("requests==2.32.3")
        self.assertIn("requests", problem)
        self.assertIn("ALLOWED_PYTHON", problem)
        self.assertIn("runtime_manifest.py", problem)

    def test_an_unpinned_python_package_is_refused(self):
        problem = runtime_manifest.check_python_spec("flask>=3.0")
        self.assertIn("name==version", problem)

    def test_a_node_range_is_refused_and_the_message_shows_the_shape(self):
        problem = runtime_manifest.check_node_package("react", "^18.3.1")
        self.assertIn("18.3.1", problem)
        self.assertIn("not an exact version", problem)

    def test_a_tool_with_no_reviewed_checksum_is_refused(self):
        unreviewed = str(max(int(version.split('.')[0]) for version in
                             runtime_manifest.ESBUILD_CHECKSUMS) + 1) + ".0.0"
        problem = runtime_manifest.check_tool("esbuild", unreviewed)
        self.assertIn("no reviewed checksum", problem)
        self.assertIn("ESBUILD_CHECKSUMS", problem)

    def test_a_tool_that_is_not_a_tool_is_refused(self):
        problem = runtime_manifest.check_tool("curl", "8.0.0")
        self.assertIn("ALLOWED_TOOLS", problem)

    def test_the_reviewed_checksums_cover_the_three_platforms_we_support(self):
        for checksums in runtime_manifest.ESBUILD_CHECKSUMS.values():
            for platform in ("darwin-arm64", "linux-x64", "linux-arm64"):
                self.assertRegex(checksums[platform], r"^[0-9a-f]{64}$")

    def test_fixture_pins_match_the_current_content_contract(self):
        with open(os.path.join(REPO_ROOT, "content", "tasktrackr", "project.json")) as source:
            self.assertEqual(json.load(source)["runtime"], FIXTURE_RUNTIME)


class RuntimeRootTest(unittest.TestCase):
    """The runner and the allowlist module must agree where the layer lives.

    sandbox_runner writes the rule out again rather than importing it, because
    the Lambda package is two files. That is a defensible duplication only while
    something checks it.
    """

    def test_the_two_modules_resolve_the_same_default_root(self):
        previous = os.environ.pop("RUNNER_RUNTIME_DIR", None)
        try:
            self.assertEqual(sandbox_runner.runtime_root(), runtime_manifest.runtime_root())
        finally:
            if previous is not None:
                os.environ["RUNNER_RUNTIME_DIR"] = previous

    def test_both_honour_the_override(self):
        previous = os.environ.get("RUNNER_RUNTIME_DIR")
        os.environ["RUNNER_RUNTIME_DIR"] = "/tmp/somewhere-else"
        try:
            self.assertEqual(sandbox_runner.runtime_root(), "/tmp/somewhere-else")
            self.assertEqual(runtime_manifest.runtime_root(), "/tmp/somewhere-else")
        finally:
            if previous is None:
                os.environ.pop("RUNNER_RUNTIME_DIR", None)
            else:
                os.environ["RUNNER_RUNTIME_DIR"] = previous


class DigestTest(unittest.TestCase):
    """The two ends compute the same digest, or the digest means nothing."""

    def setUp(self):
        if not node_bin():
            self.skipTest("node is not on PATH")

    def test_the_script_and_the_module_agree(self):
        content = tempfile.mkdtemp(prefix="lsdlc-content-")
        try:
            write_pack(content, FIXTURE_RUNTIME)
            result = prebake("print", content)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), runtime_manifest.digest(FIXTURE_RUNTIME))
        finally:
            shutil.rmtree(content, ignore_errors=True)

    def test_moving_one_pin_moves_the_digest(self):
        moved = json.loads(json.dumps(FIXTURE_RUNTIME))
        moved["node"]["packages"]["react"] = "18.3.0"
        self.assertNotEqual(
            runtime_manifest.digest(FIXTURE_RUNTIME), runtime_manifest.digest(moved)
        )

    def test_the_order_the_pack_lists_packages_in_does_not_matter(self):
        shuffled = json.loads(json.dumps(FIXTURE_RUNTIME))
        shuffled["python"]["packages"] = list(reversed(shuffled["python"]["packages"]))
        self.assertEqual(
            runtime_manifest.digest(FIXTURE_RUNTIME), runtime_manifest.digest(shuffled)
        )


class CommandLineTest(unittest.TestCase):
    """`runtime_manifest.py` answers `print` and refuses any other command."""

    def run_module(self, *args):
        return subprocess.run(
            [sys.executable, "-I", os.path.join(RUNNER_DIR, "runtime_manifest.py"), *args],
            capture_output=True, text=True, timeout=60,
        )

    def test_print_and_no_command_both_print_the_allowlists(self):
        for args in ((), ("print",)):
            with self.subTest(args=args):
                result = self.run_module(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["python"], sorted(runtime_manifest.ALLOWED_PYTHON))

    def test_an_unknown_command_fails_with_the_usage_instead_of_printing(self):
        # A caller that asks for a check this module does not offer must stop,
        # not read the allowlists as a pass.
        for args in (("check-esbuild", "/no/such/binary"), ("prnit",), ("print", "extra")):
            with self.subTest(args=args):
                result = self.run_module(*args)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertEqual(result.stdout, "")
                self.assertIn("usage: runtime_manifest.py [print]", result.stderr)


class PrebakeBuildRefusalTest(unittest.TestCase):
    """A pack cannot add a dependency to the sandbox by editing content."""

    def setUp(self):
        if not node_bin():
            self.skipTest("node is not on PATH")
        self.content = tempfile.mkdtemp(prefix="lsdlc-content-")
        self.runtime = tempfile.mkdtemp(prefix="lsdlc-runtime-")

    def tearDown(self):
        shutil.rmtree(self.content, ignore_errors=True)
        shutil.rmtree(self.runtime, ignore_errors=True)

    def test_a_package_off_the_allowlist_is_refused_before_anything_is_installed(self):
        runtime = json.loads(json.dumps(FIXTURE_RUNTIME))
        runtime["python"]["packages"].append("requests==2.32.3")
        write_pack(self.content, runtime)
        result = prebake("build", self.content, self.runtime)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("requests", result.stderr)
        self.assertIn("ALLOWED_PYTHON", result.stderr)
        self.assertEqual(os.listdir(self.runtime), [])

    def test_an_unpinned_node_package_is_refused(self):
        runtime = json.loads(json.dumps(FIXTURE_RUNTIME))
        runtime["node"]["packages"]["react"] = "^18.3.1"
        write_pack(self.content, runtime)
        result = prebake("build", self.content, self.runtime)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("react", result.stderr)
        self.assertIn("not an exact version", result.stderr)

    def test_nothing_to_bake_is_not_a_failure(self):
        # A pack that has not adopted the runtime block is not a defect, and a
        # fresh clone must not fail its setup script over one.
        os.makedirs(os.path.join(self.content, "tasktrackr"), exist_ok=True)
        with open(os.path.join(self.content, "tasktrackr", "project.json"), "w") as fh:
            json.dump({"slug": "tasktrackr"}, fh)
        result = prebake("build", self.content, self.runtime)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nothing to pre-bake", result.stdout)


class PrebakeVerifyTest:
    """Shared setup: a fixture pack that matches whatever is really baked."""

    def setUp(self):
        if not node_bin():
            self.skipTest("node is not on PATH")
        if sandbox_runner.runtime_site_packages() is None:
            self.skipTest("no pre-baked runtime: run `node scripts/prebake.mjs build` first")
        self.content = tempfile.mkdtemp(prefix="lsdlc-content-")
        write_pack(self.content, FIXTURE_RUNTIME)
        self.scratch = tempfile.mkdtemp(prefix="lsdlc-runtime-")

    def tearDown(self):
        shutil.rmtree(self.content, ignore_errors=True)
        shutil.rmtree(self.scratch, ignore_errors=True)


class PrebakeVerifyPassesTest(PrebakeVerifyTest, unittest.TestCase):
    def test_a_layer_that_matches_the_packs_verifies(self):
        result = prebake("verify", self.content)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("matches the packs", result.stdout)


class PrebakeVerifyFailuresTest(PrebakeVerifyTest, unittest.TestCase):
    """Each way the layer can be wrong gets its own sentence."""

    def test_no_layer_at_all_names_the_command_that_builds_one(self):
        result = prebake("verify", self.content, self.scratch)
        self.assertEqual(result.returncode, 1)
        self.assertIn(sandbox_runner.PREBAKE_MISSING_MESSAGE, result.stderr)

    def test_a_drifted_pin_is_reported_as_stale_with_both_digests(self):
        drifted = json.loads(json.dumps(FIXTURE_RUNTIME))
        drifted["node"]["packages"]["react"] = "18.3.0"
        write_pack(self.content, drifted)
        result = prebake("verify", self.content)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("stale", result.stderr)
        self.assertIn(runtime_manifest.digest(drifted), result.stderr)
        self.assertIn("npm run prebake", result.stderr)

    def test_a_missing_package_is_named(self):
        # The manifest says the layer was built; the directory says otherwise.
        # Which package is missing is the whole content of the message.
        shutil.copyfile(
            runtime_manifest.manifest_path(),
            os.path.join(self.scratch, "manifest.json"),
        )
        result = prebake("verify", self.content, self.scratch)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("flask==3.1.3", result.stderr)
        self.assertIn("npm run prebake", result.stderr)

    def test_an_esbuild_binary_we_did_not_review_is_refused(self):
        real = runtime_manifest.runtime_root()
        shutil.copyfile(
            runtime_manifest.manifest_path(), os.path.join(self.scratch, "manifest.json")
        )
        # Symlinks rather than copies: the Python and Node trees are 40 MB and
        # this test is about the one file it replaces.
        os.symlink(runtime_manifest.python_dir(real), os.path.join(self.scratch, "python"))
        os.symlink(os.path.join(real, "node"), os.path.join(self.scratch, "node"))
        os.makedirs(os.path.join(self.scratch, "bin"))
        with open(os.path.join(self.scratch, "bin", "esbuild"), "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        result = prebake("verify", self.content, self.scratch)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("not the binary we reviewed", result.stderr)
        self.assertIn(
            runtime_manifest.ESBUILD_CHECKSUMS[FIXTURE_RUNTIME["node"]["tools"]["esbuild"]][runtime_manifest.platform_key()],
            result.stderr,
        )


if __name__ == "__main__":
    unittest.main()
