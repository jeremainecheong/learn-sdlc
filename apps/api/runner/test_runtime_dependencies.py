"""Lockfile regressions. No network, install scripts or real packages are run."""

import copy
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime_dependencies as deps


class RuntimeDependencyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "locks"
        self.root.mkdir()
        self.manifest = {"python": {"version": "3.11", "packages": ["packaging==24.2"]},
                         "node": {"version": "22", "packages": {"react": "18.3.1"}}}
        self.package = {"name": "fixture", "version": "1.0.0", "private": True,
                        "dependencies": {"react": "18.3.1"}}
        self.lock = {"lockfileVersion": 3, "packages": {
            "": {"dependencies": {"react": "18.3.1"}},
            "node_modules/react": {"version": "18.3.1", "resolved": "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
                                   "integrity": "sha512-" + "A" * 86 + "=="}}}
        self.write()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self):
        (self.root / "python-requirements.txt").write_text("packaging==24.2 --hash=sha256:" + "a" * 64 + "\n")
        (self.root / "package.json").write_text(json.dumps(self.package))
        (self.root / "package-lock.json").write_text(json.dumps(self.lock))

    def test_transitive_lock_change_changes_provenance(self):
        before = deps.lock_fingerprints(self.manifest, self.root)
        self.lock["packages"]["node_modules/react"]["integrity"] = "sha512-" + "B" * 86 + "=="
        self.write()
        after = deps.lock_fingerprints(self.manifest, self.root)
        self.assertNotEqual(before["package-lock.json"], after["package-lock.json"])
        self.assertEqual(before["python-requirements.txt"], after["python-requirements.txt"])

    def test_changed_pack_refused_before_existing_layer_removed_or_installer_invoked(self):
        target = self.base / "runtime" / "python"
        target.mkdir(parents=True)
        (target / "keep").write_text("previous layer")
        self.manifest["python"]["packages"] = ["packaging==23.0"]
        with patch.object(deps.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "content pack pins"):
                deps.install_python(self.manifest, target, self.root)
            run.assert_not_called()
        self.assertEqual((target / "keep").read_text(), "previous layer")

    def test_unhashed_python_and_install_options_are_refused(self):
        for line in ["packaging==24.2", "--extra-index-url=https://example.com", "-e https://example.com/a",
                     "packaging>=24.2 --hash=sha256:" + "a" * 64]:
            with self.subTest(line=line):
                (self.root / "python-requirements.txt").write_text(line)
                with self.assertRaises(ValueError):
                    deps.read_locks(self.manifest, self.root)

    def test_duplicate_python_pin_is_refused(self):
        path = self.root / "python-requirements.txt"
        path.write_text(path.read_text() * 2)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            deps.read_locks(self.manifest, self.root)

    def test_linked_lockfile_is_refused(self):
        path = self.root / "package.json"
        real = self.root / "actual.json"
        path.rename(real)
        path.symlink_to(real)
        with self.assertRaisesRegex(ValueError, "linked"):
            deps.read_locks(self.manifest, self.root)

    def test_registry_integrity_links_and_unsafe_paths_are_refused(self):
        original = copy.deepcopy(self.lock)
        mutations = [{"resolved": "https://evil.example.com/react.tgz"}, {"integrity": "sha1-abcd"},
                     {"link": True}, {"resolved": "https://registry.npmjs.org/react.tgz?token=x"}]
        for change in mutations:
            with self.subTest(change=change):
                self.lock = copy.deepcopy(original)
                self.lock["packages"]["node_modules/react"].update(change)
                self.write()
                with self.assertRaises(ValueError):
                    deps.read_locks(self.manifest, self.root)
        self.lock = copy.deepcopy(original)
        self.lock["packages"]["node_modules/../../escape"] = self.lock["packages"]["node_modules/react"]
        self.write()
        with self.assertRaisesRegex(ValueError, "Unsafe path"):
            deps.read_locks(self.manifest, self.root)

    def test_install_scripts_and_overrides_in_manifest_are_refused(self):
        for key in ("scripts", "overrides", "devDependencies", "workspaces"):
            with self.subTest(key=key):
                self.package[key] = {"x": "1"}
                self.write()
                with self.assertRaisesRegex(ValueError, "unreviewed"):
                    deps.read_locks(self.manifest, self.root)
                del self.package[key]

    def test_node_root_and_direct_pin_mismatch_are_refused(self):
        self.lock["packages"]["node_modules/react"]["version"] = "18.2.0"
        self.write()
        with self.assertRaisesRegex(ValueError, "exact package"):
            deps.read_locks(self.manifest, self.root)

    def test_python_install_requires_hashes_and_disables_resolution(self):
        with patch.object(deps.subprocess, "run") as run, patch.object(deps, "verify_python", return_value={}) as verify:
            target = self.base / "runtime" / "python"
            deps.install_python(self.manifest, target, self.root)
            command = run.call_args.args[0]
            self.assertIn("--require-hashes", command)
            self.assertIn("--no-deps", command)
            self.assertIn("--isolated", command)
            self.assertIn("-I", command)
            self.assertIn(":all:", command)
            verify.assert_called_once()
            self.assertEqual(verify.call_args.args[0].parent, target.parent)
            self.assertEqual(verify.call_args.args[1], {"packaging": "24.2"})

    def test_node_uses_ci_no_scripts_and_ignores_inherited_registry_overrides(self):
        with patch.dict(deps.os.environ, {"npm_config_registry": "https://invalid.example", "NPM_CONFIG_IGNORE_SCRIPTS": "false"}):
            with patch.object(deps.subprocess, "run") as run, patch.object(deps, "verify_node", return_value={}):
                run.return_value = SimpleNamespace(stdout="v22.23.2\n")
                deps.install_node(self.manifest, self.base / "runtime" / "node", self.root,
                                  npm_command=["node", "/reviewed/npm-cli.js"])
                command = run.call_args.args[0]
                self.assertEqual(command[:3], ["node", "/reviewed/npm-cli.js", "ci"])
                self.assertIn("--ignore-scripts", command)
                self.assertNotIn("npm_config_registry", run.call_args.kwargs["env"])
                self.assertNotIn("NPM_CONFIG_IGNORE_SCRIPTS", run.call_args.kwargs["env"])

    def test_failed_install_preserves_existing_runtime_and_removes_staging(self):
        parent = self.base / "runtime"
        deps.prepare_runtime(parent)
        target = parent / "python"
        target.mkdir()
        (target / "keep").write_text("previous verified runtime")
        with patch.object(deps.subprocess, "run", side_effect=RuntimeError("controlled installer failure")):
            with self.assertRaises(RuntimeError):
                deps.install_python(self.manifest, target, self.root)
        self.assertEqual((target / "keep").read_text(), "previous verified runtime")
        self.assertEqual(list(parent.glob(".python-stage-*")), [])

    def test_unowned_nonempty_parent_and_linked_ancestor_cannot_be_claimed(self):
        unrelated = self.base / "unrelated"
        unrelated.mkdir()
        (unrelated / "keep").write_text("unrelated")
        with self.assertRaisesRegex(ValueError, "nonempty unrelated"):
            deps.prepare_runtime(unrelated)
        alias = self.base / "alias"
        alias.symlink_to(unrelated, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "linked ancestor"):
            deps.prepare_runtime(alias / "runtime")
        self.assertEqual((unrelated / "keep").read_text(), "unrelated")

    def test_runtime_target_name_blocks_unrelated_directory_removal(self):
        with self.assertRaisesRegex(ValueError, "named dependency"):
            with deps.staged_target(self.root, "python"):
                self.fail("An unrelated directory was accepted")
        self.assertTrue((self.root / "package.json").exists())

    def test_node_inventory_rejects_extra_and_linked_packages(self):
        target = self.base / "runtime" / "node"
        package = target / "node_modules/react/package.json"
        package.parent.mkdir(parents=True)
        package.write_text('{"version":"18.3.1"}')
        extra = target / "node_modules/unreviewed"
        extra.mkdir()
        (extra / "package.json").write_text('{"version":"1.0.0"}')
        with self.assertRaisesRegex(ValueError, "unreviewed"):
            deps.verify_node(target, self.lock)
        deps.shutil.rmtree(extra)
        extra.symlink_to(package.parent, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "linked"):
            deps.verify_node(target, self.lock)

    def test_wrong_node_major_fails_before_creating_target(self):
        target = self.base / "runtime" / "node"
        with patch.object(deps.subprocess, "run", return_value=SimpleNamespace(stdout="v24.0.0\n")):
            with self.assertRaisesRegex(ValueError, "Node.js 22"):
                deps.install_node(self.manifest, target, self.root)
        self.assertFalse(target.exists())

    def test_a_wrong_interpreter_is_refused_with_a_sentence_that_names_no_pack(self):
        # The layer serves every pack, so the refusal names the sandbox's
        # runtime and the version it needs.
        self.manifest["python"]["version"] = "3.10"
        with patch.object(deps.subprocess, "run") as run:
            with self.assertRaises(ValueError) as python:
                deps.install_python(self.manifest, self.base / "runtime" / "python", self.root)
            run.assert_not_called()
        self.assertEqual(str(python.exception), "Build the sandbox Python runtime with Python 3.11.")

        with patch.object(deps.subprocess, "run", return_value=SimpleNamespace(stdout="v24.0.0\n")):
            with self.assertRaises(ValueError) as node:
                deps.install_node(self.manifest, self.base / "runtime" / "node", self.root)
        self.assertEqual(str(node.exception), "Build the sandbox Node runtime with Node.js 22.")

        argv = ["runtime_dependencies.py", "verify-python", "--target", str(self.base / "runtime")]
        stdin = SimpleNamespace(read=lambda _size: json.dumps(self.manifest))
        with patch.object(sys, "argv", argv), patch.object(sys, "stdin", stdin), \
                patch.object(deps, "read_locks", return_value={}), \
                patch.object(deps, "verify_python") as verify:
            with self.assertRaises(ValueError) as verifying:
                deps.main()
            verify.assert_not_called()
        self.assertEqual(str(verifying.exception), "Verify the sandbox Python runtime with Python 3.11.")

    def test_bad_integrity_length_and_unpinned_transitive_version_are_refused(self):
        self.lock["packages"]["node_modules/react"]["integrity"] = "sha512-YWJj"
        self.write()
        with self.assertRaises(ValueError):
            deps.read_locks(self.manifest, self.root)
        self.lock["packages"]["node_modules/react"]["integrity"] = "sha512-" + "A" * 86 + "=="
        self.lock["packages"]["node_modules/react"]["version"] = "^18.3.1"
        self.write()
        with self.assertRaises(ValueError):
            deps.read_locks(self.manifest, self.root)

    def test_missing_platform_checksum_refuses_before_download(self):
        with patch.object(deps, "fetch_public") as fetch:
            with patch.object(deps.importlib.util, 'module_from_spec', return_value=SimpleNamespace(ESBUILD_CHECKSUMS={}, platform_key=lambda: 'unsupported')), patch.object(deps.importlib.util, 'spec_from_file_location', return_value=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))):
                with self.assertRaisesRegex(ValueError, "no reviewed checksum"):
                    deps.install_esbuild({**self.manifest, "tools": {"esbuild": "0.25.0"}}, self.root / "bin")
            fetch.assert_not_called()

    def test_incorrect_installed_transitive_version_fails(self):
        target = self.base / "runtime" / "node"
        path = target / "node_modules/react/package.json"
        path.parent.mkdir(parents=True)
        path.write_text('{"version":"18.2.0"}')
        with self.assertRaisesRegex(ValueError, "differs"):
            deps.verify_node(target, self.lock)

    def test_missing_python_transitive_distribution_fails(self):
        dist = SimpleNamespace(metadata={"Name": "packaging"}, version="24.2", requires=[])
        with patch.object(deps.importlib.metadata, "distributions", return_value=[dist]):
            with self.assertRaisesRegex(ValueError, "differ"):
                deps.verify_python(self.root, {"packaging": "24.2", "pygments": "2.21.0"})

    def test_unfulfilled_python_requirement_fails(self):
        dist = SimpleNamespace(metadata={"Name": "packaging"}, version="24.2", requires=["missing>=1"])
        with patch.object(deps.importlib.metadata, "distributions", return_value=[dist]):
            with self.assertRaisesRegex(ValueError, "does not satisfy"):
                deps.verify_python(self.root, {"packaging": "24.2"})

    def test_published_dependencies_are_readable_by_the_sandbox_uid(self):
        target = self.base / "runtime" / "python"
        with deps.staged_target(target, "python") as stage:
            package = stage / "example"
            package.mkdir(mode=0o700)
            module = package / "__init__.py"
            module.write_text("VALUE = 1\n")
            module.chmod(0o600)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((target / "example").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((target / "example/__init__.py").stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(self.base.stat().st_mode), 0o700)

    def test_published_executables_keep_execution_but_not_special_or_shared_write_bits(self):
        target = self.base / "runtime" / "bin"
        with deps.staged_target(target, "bin") as stage:
            binary = stage / "tool"
            binary.write_text("#!/bin/sh\nexit 0\n")
            binary.chmod(0o4777)
        self.assertEqual(stat.S_IMODE((target / "tool").stat().st_mode), 0o755)

    def test_published_npm_binary_links_must_resolve_inside_the_layer(self):
        target = self.base / "runtime" / "node"
        with deps.staged_target(target, "node") as stage:
            package = stage / "node_modules/example"
            package.mkdir(parents=True)
            (package / "cli.js").write_text("process.exit(0);\n")
            binaries = stage / "node_modules/.bin"
            binaries.mkdir()
            (binaries / "example").symlink_to("../example/cli.js")
        self.assertTrue((target / "node_modules/.bin/example").is_symlink())
        self.assertEqual((target / "node_modules/.bin/example").read_text(), "process.exit(0);\n")

    def test_unsafe_published_files_preserve_the_old_layer_and_external_permissions(self):
        target = self.base / "runtime" / "python"
        parent = deps.prepare_runtime(target.parent)
        target.mkdir()
        (target / "keep").write_text("prior layer")
        external = self.base / "private"
        external.write_text("private fixture")
        external.chmod(0o600)
        for kind in ("external-link", "directory-link", "hardlink", "fifo"):
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ValueError, "runtime publication"):
                    with deps.staged_target(target, "python") as stage:
                        entry = stage / "unsafe"
                        if kind == "external-link": entry.symlink_to(external)
                        elif kind == "directory-link": entry.symlink_to(parent, target_is_directory=True)
                        elif kind == "hardlink": os.link(external, entry)
                        else: os.mkfifo(entry)
                self.assertEqual((target / "keep").read_text(), "prior layer")
                self.assertEqual(stat.S_IMODE(external.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
