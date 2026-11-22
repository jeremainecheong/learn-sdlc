import importlib.util
import hashlib
import json
import os
import shlex
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("guest_package", Path(__file__).with_name("package.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
install_spec = importlib.util.spec_from_file_location("guest_installer", Path(__file__).with_name("install_runtime.py"))
installer = importlib.util.module_from_spec(install_spec)
install_spec.loader.exec_module(installer)
runtime_spec = importlib.util.spec_from_file_location(
    "guest_runtime_dependencies", packager.ROOT / "apps/api/runner/runtime_dependencies.py")
runtime_dependencies = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime_dependencies)

LOCK_NAMES = ("python-requirements.txt", "package.json", "package-lock.json")


def fixture_sources(root):
    sources = {
        "infra/microvm/guest/Dockerfile": "FROM fixture\n",
        "infra/microvm/guest/gateway.py": "# fixture\n",
        "infra/microvm/guest/install_runtime.py": "# fixture\n",
    }
    project = json.loads((packager.ROOT / "content/tasktrackr/project.json").read_text())
    runtime = project["runtime"]
    lines = [f"python {runtime['python']['version']}", *sorted(runtime["python"]["packages"]),
             f"node {runtime['node']['version']}",
             *sorted(f"{name}@{version}" for name, version in runtime["node"]["packages"].items()),
             *sorted(f"tool:{name}@{version}" for name, version in runtime["node"]["tools"].items())]
    locks = {name: (packager.ROOT / "apps/api/runner/runtime-locks" / name).read_text() for name in LOCK_NAMES}
    manifest = {"python": runtime["python"], "node": {k: v for k, v in runtime["node"].items() if k != "tools"},
                "tools": runtime["node"]["tools"], "digest": hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest(),
                "dependencyLocks": {name: hashlib.sha256(raw.encode()).hexdigest() for name, raw in locks.items()}}
    sources.update({
        "content/tasktrackr/project.json": json.dumps(project),
        "apps/api/runner/runtime/manifest.json": json.dumps(manifest),
        **{f"apps/api/runner/runtime-locks/{name}": raw for name, raw in locks.items()},
        **{f"apps/api/runner/{name}": (packager.ROOT / f"apps/api/runner/{name}").read_text()
           for name in packager.RUNNER_SOURCES},
    })
    for name, body in sources.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)


def interpreters(dependencies):
    """A stand-in runtime_dependencies module that names the interpreters the guest checks for."""
    dependencies.REQUIRED_PYTHON = runtime_dependencies.REQUIRED_PYTHON
    dependencies.REQUIRED_PYTHON_VERSION = runtime_dependencies.REQUIRED_PYTHON_VERSION
    dependencies.REQUIRED_NODE_MAJOR = runtime_dependencies.REQUIRED_NODE_MAJOR
    return dependencies


class PackageTests(unittest.TestCase):
    def test_archive_is_deterministic_and_carries_no_local_runtime_or_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "one.zip"
            second = Path(directory) / "two.zip"
            one = packager.package(packager.ROOT, first)
            two = packager.package(packager.ROOT, second)
            self.assertEqual(one["sha256"], two["sha256"])
            with zipfile.ZipFile(first) as archive:
                names = archive.namelist()
                self.assertIn("Dockerfile", names)
                self.assertIn("apps/api/runner/runtime/manifest.json", names)
                self.assertIn("apps/api/runner/runtime_dependencies.py", names)
                self.assertIn("apps/api/runner/runtime_diagnostics.py", names)
                self.assertEqual(sorted(name for name in names if "/runtime-locks/" in name),
                                 sorted(f"apps/api/runner/runtime-locks/{name}" for name in LOCK_NAMES))
                self.assertFalse(any(".env" in name or "node_modules" in name or "__pycache__" in name for name in names))
                self.assertEqual([name for name in names if "/runtime/" in name], ["apps/api/runner/runtime/manifest.json"])
                self.assertTrue(all(not name.startswith("/") and ".." not in name.split("/") for name in names))

    def test_missing_source_fails_before_archive_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                packager.package(Path(directory), Path(directory) / "missing.zip")

    def test_only_explicit_lockfiles_are_packaged_with_their_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_sources(root)
            locks = root / "apps/api/runner/runtime-locks"
            (locks / ".npmrc").write_text("private-unreviewed-configuration")
            (root / "apps/api/runner/unreviewed.py").write_text("# unreviewed module\n")
            output = root / "source.zip"
            packager.package(root, output)
            with zipfile.ZipFile(output) as archive:
                self.assertNotIn("apps/api/runner/runtime-locks/.npmrc", archive.namelist())
                self.assertNotIn("apps/api/runner/unreviewed.py", archive.namelist())
                for name in LOCK_NAMES:
                    self.assertEqual(archive.read(f"apps/api/runner/runtime-locks/{name}"), (locks / name).read_bytes())

    def test_missing_or_linked_lockfile_is_refused_before_writing_archive(self):
        for linked in (False, True):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture_sources(root)
                lock = root / "apps/api/runner/runtime-locks/package-lock.json"
                lock.unlink()
                if linked:
                    lock.symlink_to(root / "apps/api/runner/runtime-locks/package.json")
                output = root / "refused.zip"
                with self.assertRaises(ValueError):
                    packager.package(root, output)
                self.assertFalse(output.exists())

    def test_stale_manifest_or_changed_lock_is_refused_before_archive_creation(self):
        for drift in ("digest", "pins", "fingerprints", "lock"):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture_sources(root)
                path = root / "apps/api/runner/runtime/manifest.json"
                manifest = json.loads(path.read_text())
                if drift == "digest":
                    manifest["digest"] = "f" * 64
                elif drift == "pins":
                    manifest["python"]["packages"][0] = "flask==3.0.3"
                elif drift == "fingerprints":
                    manifest["dependencyLocks"]["package-lock.json"] = "f" * 64
                else:
                    lock = root / "apps/api/runner/runtime-locks/package-lock.json"
                    lock.write_bytes(lock.read_bytes() + b"\n")
                path.write_text(json.dumps(manifest))
                output = root / "refused.zip"
                with self.assertRaises(ValueError):
                    packager.package(root, output)
                self.assertFalse(output.exists())


class InstallerTests(unittest.TestCase):
    def test_legacy_bake_refuses_stale_metadata_before_installing(self):
        dockerfile = (packager.ROOT / "infra/runner.Dockerfile").read_text()
        line = next(line for line in dockerfile.splitlines() if "PYTHONPATH=/runner python3 -c" in line)
        command = shlex.split(line.rstrip().removesuffix("\\"))
        source = command[command.index("-c") + 1]
        for drift in ("digest", "fingerprints"):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                manifest = {"python": {"packages": []}, "node": {"packages": {}}, "tools": {},
                            "digest": "a" * 64, "dependencyLocks": {}}
                if drift == "digest":
                    manifest["digest"] = "b" * 64
                else:
                    manifest["dependencyLocks"] = {"wrong": "b" * 64}
                path = Path(directory) / "manifest.json"
                original = json.dumps(manifest)
                path.write_text(original)
                dependencies = MagicMock()
                def require(condition, message):
                    if not condition:
                        raise ValueError(message)
                dependencies.require.side_effect = require
                dependencies.lock_fingerprints.return_value = {}
                validator = MagicMock()
                validator.digest.return_value = "a" * 64
                previous = Path.cwd()
                try:
                    os.chdir(directory)
                    with patch.dict(sys.modules, {"runtime_dependencies": dependencies, "runtime_manifest": validator}):
                        with self.assertRaisesRegex(ValueError, "Runtime manifest"):
                            exec(compile(source, "legacy-image-build-preflight", "exec"), {})
                finally:
                    os.chdir(previous)
                dependencies.prepare_runtime.assert_not_called()
                dependencies.install_python.assert_not_called()
                dependencies.install_node.assert_not_called()
                dependencies.install_esbuild.assert_not_called()
                self.assertEqual(path.read_text(), original)

    def test_guest_uses_shared_lock_installers_and_records_fingerprints(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir()
            manifest = {"python": {"packages": ["pytest==9.0.3"]},
                        "node": {"packages": {"react": "18.3.1"}},
                        "tools": {"esbuild": "0.25.0"}, "digest": "a" * 64}
            (runtime / "manifest.json").write_text(json.dumps(manifest))
            validator = MagicMock()
            validator.check_python_spec.return_value = None
            validator.check_node_package.return_value = None
            validator.check_tool.return_value = None
            validator.digest.return_value = manifest["digest"]
            dependencies = interpreters(MagicMock())
            hashes = {name: "b" * 64 for name in LOCK_NAMES}
            manifest["dependencyLocks"] = hashes
            (runtime / "manifest.json").write_text(json.dumps(manifest))
            dependencies.lock_fingerprints.return_value = hashes

            with patch.dict(sys.modules, {"runtime_manifest": validator, "runtime_dependencies": dependencies}), \
                 patch.object(sys, "path", list(sys.path)), \
                 patch.object(sys, "version_info", (3, 11, 0)), \
                 patch.object(installer.platform, "machine", return_value="aarch64"), \
                 patch.object(installer.subprocess, "check_output", return_value="v22.0.0\n"), \
                 patch.object(installer.subprocess, "run") as commands:
                installer.main(runtime)
            dependencies.prepare_runtime.assert_called_once_with(runtime)
            dependencies.install_python.assert_called_once_with(manifest, runtime / "python")
            dependencies.install_node.assert_called_once_with(manifest, runtime / "node")
            dependencies.install_esbuild.assert_called_once_with(manifest, runtime / "bin")
            self.assertEqual(dependencies.lock_fingerprints.call_count, 2)
            saved = json.loads((runtime / "manifest.json").read_text())
            self.assertEqual(saved["dependencyLocks"], hashes)
            self.assertEqual(saved["platform"], "linux-arm64")
            commands.assert_not_called()

    def test_shared_installer_failure_does_not_claim_a_successful_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            manifest = {"python": {"packages": []}, "node": {"packages": {}},
                        "tools": {}, "digest": "a" * 64, "dependencyLocks": {}}
            original = json.dumps(manifest)
            (runtime / "manifest.json").write_text(original)
            validator = MagicMock()
            validator.digest.return_value = manifest["digest"]
            dependencies = interpreters(MagicMock())
            dependencies.lock_fingerprints.return_value = {}
            dependencies.install_python.side_effect = ValueError("lock mismatch")
            with patch.dict(sys.modules, {"runtime_manifest": validator, "runtime_dependencies": dependencies}), \
                 patch.object(sys, "path", list(sys.path)), \
                 patch.object(sys, "version_info", (3, 11, 0)), \
                 patch.object(installer.platform, "machine", return_value="aarch64"), \
                 patch.object(installer.subprocess, "check_output", return_value="v22.0.0\n"), \
                 patch.object(installer.subprocess, "run") as commands:
                with self.assertRaisesRegex(ValueError, "lock mismatch"):
                    installer.main(runtime)
            dependencies.install_node.assert_not_called()
            dependencies.install_esbuild.assert_not_called()
            dependencies.lock_fingerprints.assert_called_once_with(manifest)
            commands.assert_not_called()
            self.assertEqual((runtime / "manifest.json").read_text(), original)


if __name__ == "__main__":
    unittest.main()
