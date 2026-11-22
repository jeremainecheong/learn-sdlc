"""Offline immutable-asset cutover contracts; never invoke Docker or a service."""
import importlib.util
import json
import os
import stat
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("static_assets", Path(__file__).with_name("static_assets.py"))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
A, B, C = ("sha256:" + letter * 64 for letter in "abc")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.store = module.Store(self.base / "retained")

    def incoming(self, name, files):
        root = self.base / name
        root.mkdir()
        for path, body in files.items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        return module.assets(root)

    def test_old_document_assets_survive_two_actual_image_cutovers_then_expire(self):
        first = self.incoming("a", {"chunks/old-aaa.js": b"old", "media/shared.woff2": b"font"})
        second = self.incoming("b", {"chunks/new-bbb.js": b"new", "media/shared.woff2": b"font"})
        third = self.incoming("c", {"chunks/third-ccc.js": b"third"})
        self.store.prepare(A, first, B, second, now=10)
        self.store.reconcile(B, B, now=20)
        saved = self.store.read()
        self.assertEqual(saved["files"]["chunks/old-aaa.js"]["expiresAt"], 20 + module.GRACE)
        self.assertIsNone(saved["files"]["chunks/new-bbb.js"]["expiresAt"])
        self.store.prepare(B, second, C, third, now=30)
        self.store.reconcile(C, C, now=40)
        self.store.reconcile(C, now=20 + module.GRACE - 1)
        self.assertEqual(self.store.read()["files"]["chunks/old-aaa.js"]["source"].read_bytes(), b"old")
        self.store.reconcile(C, now=20 + module.GRACE)
        self.assertNotIn("chunks/old-aaa.js", self.store.read()["files"])
        self.assertIn("chunks/new-bbb.js", self.store.read()["files"])
        self.store.reconcile(C, now=40 + module.GRACE)
        self.assertEqual(set(self.store.read()["files"]), {"chunks/third-ccc.js"})

    def test_private_bootstrap_umask_keeps_manifest_private_and_build_assets_readable(self):
        source = self.incoming("a", {"chunks/entry.js": b"js"})
        previous = os.umask(0o077)
        try:
            self.store.prepare(None, {}, A, source, now=1)
            self.store.reconcile(A, A, now=2)
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE((self.store.root / "manifest.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.store.root / "public/_next/static/chunks").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.store.root / "public/_next/static/chunks/entry.js").stat().st_mode), 0o444)

    def test_failed_cutover_never_expires_assets_of_still_running_web(self):
        first = self.incoming("a", {"chunks/old-aaa.js": b"old"})
        second = self.incoming("b", {"chunks/new-bbb.js": b"new"})
        self.store.prepare(A, first, B, second, now=10)
        with self.assertRaisesRegex(RuntimeError, "not running"):
            self.store.reconcile(A, B, now=20)
        self.store.reconcile(A, now=10 + module.GRACE + 1)
        self.assertEqual(set(self.store.read()["files"]), {"chunks/old-aaa.js"})
        self.assertIsNone(self.store.read()["files"]["chunks/old-aaa.js"]["expiresAt"])
        self.assertIsNone(self.store.read()["pending"])

    def test_hourly_reconcile_finishes_interrupted_activation_only_for_exact_running_image(self):
        first = self.incoming("a", {"chunks/old.js": b"old"})
        second = self.incoming("b", {"chunks/new.js": b"new"})
        self.store.prepare(A, first, B, second, now=10)
        with self.assertRaisesRegex(RuntimeError, "no verified"):
            self.store.reconcile(C, now=15)
        self.store.reconcile(B, now=20)
        self.assertEqual(self.store.read()["activeImage"], B)
        self.assertEqual(self.store.read()["files"]["chunks/old.js"]["expiresAt"], 20 + module.GRACE)

    def test_conflicting_bytes_at_same_url_abort_before_changing_committed_manifest(self):
        first = self.incoming("a", {"chunks/hash.js": b"old"})
        self.store.prepare(A, first, A, first, now=10)
        before = (self.store.root / "manifest.json").read_bytes()
        second = self.incoming("b", {"chunks/hash.js": b"different"})
        with self.assertRaisesRegex(RuntimeError, "same immutable"):
            self.store.prepare(A, first, B, second, now=20)
        self.assertEqual((self.store.root / "manifest.json").read_bytes(), before)
        self.assertEqual(self.store.read()["files"]["chunks/hash.js"]["source"].read_bytes(), b"old")

    def test_never_retains_html_source_maps_env_or_application_data(self):
        source = self.incoming("assets", {"chunks/entry.js": b"js", "login.html": b"private html",
                                         "chunks/entry.js.map": b"source map", "api.env": b"secret",
                                         "state.json": b"private state"})
        self.assertEqual(set(source), {"chunks/entry.js"})
        self.store.prepare(None, {}, A, source, now=1)
        public = self.store.root / "public"
        self.assertEqual([p.relative_to(public).as_posix() for p in public.rglob("*") if p.is_file()], ["_next/static/chunks/entry.js"])

    def test_symlink_and_traversal_are_rejected(self):
        source = self.base / "linked"; source.mkdir()
        secret = self.base / "secret"; secret.write_bytes(b"private")
        (source / "entry.js").symlink_to(secret)
        with self.assertRaises(RuntimeError): module.assets(source)
        for path in ("../secret.js", "/secret.js", "a/../b.js", "a//b.js", "a\\b.js", ".env", "a/%2e%2e/b.js"):
            with self.subTest(path=path), self.assertRaises(RuntimeError): module.safe_path(path)

    def test_serving_root_symlink_is_rejected_before_creating_any_outside_directory(self):
        outside = self.base / "outside"; outside.mkdir()
        (self.store.root / "public").symlink_to(outside)
        source = self.incoming("a", {"chunks/entry.js": b"js"})
        with self.assertRaisesRegex(RuntimeError, "Unexpected link"):
            self.store.prepare(None, {}, A, source, now=1)
        self.assertEqual(list(outside.iterdir()), [])

    def test_capacity_disk_and_integrity_failures_preserve_previous_generation(self):
        first = self.incoming("a", {"chunks/old.js": b"old"})
        second = self.incoming("b", {"chunks/new.js": b"new"})
        self.store.prepare(A, first, A, first, now=1)
        before = (self.store.root / "manifest.json").read_bytes()
        with patch.object(module, "MAX_BYTES", 5), self.assertRaisesRegex(RuntimeError, "capacity"):
            self.store.prepare(A, first, B, second, now=2)
        with patch.object(module.shutil, "disk_usage", return_value=Mock(free=0)), self.assertRaisesRegex(RuntimeError, "disk space"):
            self.store.prepare(A, first, B, second, now=2)
        self.assertEqual((self.store.root / "manifest.json").read_bytes(), before)
        retained = self.store.read()["files"]["chunks/old.js"]["source"]
        retained.chmod(0o644); retained.write_bytes(b"bad")
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            self.store.reconcile(A, now=3)

    def test_failed_manifest_commit_preserves_active_assets_then_prune_cleans_partial_additions(self):
        first = self.incoming("a", {"chunks/old.js": b"old"})
        second = self.incoming("b", {"chunks/new.js": b"new"})
        self.store.prepare(A, first, A, first, now=1)
        before = (self.store.root / "manifest.json").read_bytes()
        with patch.object(module.os, "replace", side_effect=OSError("offline disk failure")), self.assertRaises(OSError):
            self.store.prepare(A, first, B, second, now=2)
        self.assertEqual((self.store.root / "manifest.json").read_bytes(), before)
        self.assertEqual(self.store.read()["files"]["chunks/old.js"]["source"].read_bytes(), b"old")
        staged = self.store.root / "public/_next/static/chunks/new.js"
        self.assertTrue(staged.exists(), "Crash-like interruption can leave safe staged asset bytes")
        self.store.reconcile(A, now=3)
        self.assertFalse(staged.exists(), "Prune must remove unreferenced additions without touching active bytes")
        self.assertEqual(self.store.read()["files"]["chunks/old.js"]["source"].read_bytes(), b"old")


class DockerBoundaryTests(unittest.TestCase):
    def test_running_identity_uses_exact_existing_container_and_compose_labels(self):
        labels = {"com.docker.compose.project": "learnsdlc-cloud-preview", "com.docker.compose.service": "web"}
        with patch.object(module, "docker", side_effect=["a" * 12, json.dumps(A) + "|true|" + json.dumps(labels)]) as command:
            self.assertEqual(module.running(), A)
        self.assertIn("name=^/learnsdlc-cloud-preview-web-1$", command.call_args_list[0].args)
        for raw in (json.dumps(A) + "|false|" + json.dumps(labels), json.dumps(A) + '|true|{}'):
            with patch.object(module, "docker", side_effect=["a" * 12, raw]), self.assertRaises(RuntimeError): module.running()
        with patch.object(module, "docker", return_value=""):
            self.assertIsNone(module.running())
        with patch.object(module, "docker", side_effect=RuntimeError("unavailable")), self.assertRaises(RuntimeError): module.running()

    def test_ambiguous_create_cleans_only_unique_stopped_export_name(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(module, "docker", side_effect=[RuntimeError("ambiguous"), ""]) as command:
                with self.assertRaisesRegex(RuntimeError, "ambiguous"): module.export(A, Path(directory))
        create, cleanup = [call.args for call in command.call_args_list]
        name = create[create.index("--name") + 1]
        self.assertTrue(name.startswith("learnsdlc-static-export-"))
        self.assertEqual(cleanup, ("rm", "-v", name))
        self.assertIn("--pull=never", create)
        self.assertEqual(create[-1], A)
        self.assertNotIn("start", create)

    def test_archive_links_and_wrong_root_never_escape_private_export(self):
        for kind, name in ((tarfile.SYMTYPE, "static/chunks/entry.js"), (tarfile.LNKTYPE, "static/chunks/entry.js"), (tarfile.REGTYPE, "../outside.js")):
            with tempfile.TemporaryDirectory() as directory:
                def start(*args, **kwargs):
                    with tarfile.open(fileobj=kwargs["stdout"], mode="w") as tar:
                        member = tarfile.TarInfo(name); member.type = kind; member.linkname = "../../private"
                        tar.addfile(member)
                    return Mock(poll=Mock(return_value=0), returncode=0)
                with patch.object(module, "docker", return_value=""), patch.object(module.subprocess, "Popen", side_effect=start):
                    with self.assertRaises(RuntimeError): module.export(A, Path(directory))


if __name__ == "__main__": unittest.main()
