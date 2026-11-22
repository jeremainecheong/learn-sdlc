"""Exact persisted ownership using fake providers; no external execution."""
import copy
import json
import tempfile
import sqlite3
from pathlib import Path
import time
import unittest
from unittest.mock import patch
import uuid

from bridge import Bridge, Config, Refusal
from cloud import Unavailable
from operation_trace import parse_trace, safe_diagnostics, InvalidTrace
from registry import Registry
from test_bridge import Cloud, Guest, IMAGE, EGRESS, INGRESS, JOB, PREVIEW, RESULT
from test_bridge import Config  # unpaced, so these cases prove only what they pin


class TraceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "registry.sqlite"
        self.registry = Registry(self.path)
        self.cloud, self.guest = Cloud(), Guest()
        # Explicit limits (a job limit of 2, a cleanup limit of 1), so these cases keep proving that configuration
        # whatever the code defaults are.
        self.bridge = Bridge(Config("ap-southeast-1", IMAGE, "1", INGRESS, EGRESS, boot_seconds=1, job_limit=2, cleanup_limit=1),
                             self.registry, self.cloud, self.guest)
        self.trace = {"attemptId": str(uuid.uuid4()), "kind": "run", "ownerId": str(uuid.uuid4()), "stepId": "frontend"}

    def tearDown(self):
        for _ in range(100):
            if not self.bridge.active and not self.bridge.cleanup_slots.busy(): break
            time.sleep(.005)
        self.registry.close()
        self.temp.cleanup()

    def row(self):
        return dict(self.registry.db.execute("SELECT * FROM operations WHERE api_trace_id=?", (self.trace["attemptId"],)).fetchone())

    def test_mapping_is_committed_before_launch_and_survives_restart_and_failure(self):
        def lost(parameters):
            row = self.row()
            self.assertEqual(row["api_owner_id"], self.trace["ownerId"])
            self.assertEqual(row["api_step_id"], "frontend")
            self.assertEqual(row["id"], parameters["clientToken"])
            raise Unavailable("source and secrets must not appear")
        with patch.object(self.cloud, "launch", side_effect=lost), patch.object(self.bridge, "cleanup_one"):
            with self.assertRaises(Unavailable): self.bridge.execute(JOB, self.trace)
        row = self.row()
        self.registry.close()
        self.registry = Registry(self.path)
        self.bridge.registry = self.registry
        self.assertEqual(self.row()["id"], row["id"])
        with self.assertRaises(Refusal) as duplicate: self.bridge.execute(JOB, self.trace)
        self.assertEqual(duplicate.exception.status, 409)
        self.assertEqual(self.registry.db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 1)

    def test_timeout_and_malformed_results_keep_exact_vm_and_source_safe_diagnostics(self):
        for malformed in (False, True):
            with self.subTest(malformed=malformed), patch.object(self.bridge, "cleanup_one"):
                self.trace["attemptId"] = str(uuid.uuid4())
                self.guest.result = {**copy.deepcopy(RESULT), "ok": False, "exitKind": "timeout",
                    "operationId": "learner-spoof", "diagnostics": {"version": 1,
                    "cpuUserMs": 123, "peakRssBytes": 456, "environment": "secret-canary",
                    "stages": [{"stage": "timeout", "atMs": 15001, "argv": "hidden-source"}]}}
                if malformed: self.guest.result["tests"]["total"] = -1
                if malformed:
                    with self.assertRaises(Unavailable): self.bridge.execute(JOB, self.trace)
                else:
                    answer = self.bridge.execute(JOB, self.trace)
                    self.assertEqual(answer["exitKind"], "timeout")
                    self.assertNotIn("operationId", answer)
                    self.assertNotIn("diagnostics", answer)
                row = self.row()
                self.assertEqual(row["vm_id"], "mvm-" + row["id"])
                self.assertNotIn("secret-canary", row["diagnostics_json"])
                self.assertNotIn("hidden-source", row["diagnostics_json"])
                self.assertEqual(json.loads(row["diagnostics_json"])["cpuUserMs"], 123)
                self.assertEqual(row["cleanup"], 1)

    def test_source_identity_fields_cannot_create_an_owner(self):
        with patch.object(self.bridge, "cleanup_one"):
            self.bridge.execute({**JOB, "trace": self.trace, "api_owner_id": self.trace["ownerId"]})
        row = dict(self.registry.db.execute("SELECT * FROM operations").fetchone())
        self.assertIsNone(row["api_owner_id"])
        self.assertIsNone(row["api_trace_id"])

    def test_preview_mapping_precedes_background_start_and_guest_never_receives_trace(self):
        self.trace.update(kind="preview", ownerId="a" * 24, stepId="app")
        answer = self.bridge.start(PREVIEW, self.trace)
        for _ in range(100):
            if not self.bridge.active: break
            time.sleep(.005)
        row = self.row()
        self.assertEqual(answer["id"], row["id"])
        self.assertEqual(row["api_owner_id"], "a" * 24)
        self.assertEqual(row["vm_id"], "mvm-" + row["id"])
        for route, _, body in self.guest.calls:
            if body:
                self.assertNotIn(self.trace["attemptId"].encode(), body)
                self.assertNotIn(self.trace["ownerId"].encode(), body)

    def test_header_validation_is_bounded_and_purpose_specific(self):
        self.assertEqual(parse_trace(json.dumps(self.trace), "job"), self.trace)
        for value in ("x" * 513, "[]", json.dumps({**self.trace, "kind": "preview"}),
                      json.dumps({**self.trace, "ownerId": "learner@example.test"}),
                      json.dumps({**self.trace, "stepId": "../../private"}),
                      json.dumps({**self.trace, "extra": "ignored?"})):
            with self.assertRaises(InvalidTrace): parse_trace(value, "job")

    def test_missing_owner_is_not_cleanup_and_late_arrival_is_recovered_after_restart(self):
        self.trace.update(kind="preview", ownerId="b" * 24, stepId="app")
        lookup = {"kind": "preview", "ownerId": self.trace["ownerId"]}
        self.assertEqual(self.bridge.lookup_owner(lookup), {"found": False, "cleanupConfirmed": False})
        answer = self.bridge.start(PREVIEW, self.trace)
        for _ in range(100):
            if not self.bridge.active: break
            time.sleep(.005)
        self.registry.close()
        self.registry = Registry(self.path)
        self.bridge.registry = self.registry
        self.assertEqual(self.bridge.lookup_owner(lookup), {"found": True, "runnerId": answer["id"], "cleanupConfirmed": False})
        with patch.object(self.bridge, "cleanup_one"):
            stopped = self.bridge.app("stop", {"id": answer["id"]})
        self.assertEqual(stopped["status"], "stopped")
        self.assertFalse(stopped["cleanupConfirmed"])
        self.bridge.cleanup_one(answer["id"])
        self.assertTrue(self.bridge.lookup_owner(lookup)["cleanupConfirmed"])
        self.assertTrue(self.bridge.app("status", {"id": answer["id"]})["cleanupConfirmed"])

    def test_ambiguous_owner_lookup_never_selects_a_latest_operation(self):
        self.trace.update(kind="preview", ownerId="c" * 24, stepId="app")
        for _ in range(2):
            self.trace["attemptId"] = str(uuid.uuid4())
            self.bridge.start(PREVIEW, self.trace)
            for _ in range(100):
                if not self.bridge.active: break
                time.sleep(.005)
        with self.assertRaises(Refusal) as ambiguous:
            self.bridge.lookup_owner({"kind": "preview", "ownerId": self.trace["ownerId"]})
        self.assertEqual(ambiguous.exception.status, 409)
        for owner in ("../../private", "x" * 1000, "learner@example.test"):
            with self.assertRaises(Refusal): self.bridge.lookup_owner({"kind": "preview", "ownerId": owner})

    def test_failed_or_expired_unconfirmed_operation_is_not_cleanup_confirmation(self):
        self.trace.update(kind="preview", ownerId="d" * 24, stepId="app")
        with patch.object(self.bridge, "_start_worker"):
            answer = self.bridge.start(PREVIEW, self.trace)
        self.bridge._released(answer["id"])
        self.registry.update(answer["id"], state="expired-unconfirmed", failure="preview failed", cleanup=1, cleanup_outcome="expired-unconfirmed")
        view = self.bridge.app("status", {"id": answer["id"]})
        self.assertEqual(view["status"], "failed")
        self.assertFalse(view["cleanupConfirmed"])

    def test_diagnostic_allowlist_bounds_malformed_and_nonfinite_fields(self):
        result = safe_diagnostics({"version": 1, "samples": True, "cpuUserMs": float("nan"),
                                  "stages": [{"stage": "timeout", "atMs": 1}] * 100,
                                  "cgroup": {"scope": "forged", "oomDelta": -1}})
        self.assertNotIn("samples", result)
        self.assertNotIn("cpuUserMs", result)
        self.assertEqual(len(result["stages"]), 16)
        self.assertNotIn("cgroup", result)

    def test_additive_migration_is_atomic_and_legacy_rows_and_writers_remain_usable(self):
        # Simulate a pre-trace registry, including an existing operation row.
        with patch.object(self.bridge, "cleanup_one"):
            self.bridge.execute(JOB)
        self.registry.close()
        legacy = sqlite3.connect(self.path)
        legacy.execute("DROP INDEX operations_api_trace")
        legacy.execute("DROP INDEX operations_api_owner")
        for name in ("api_trace_id", "api_owner_kind", "api_owner_id", "api_step_id", "diagnostics_json"):
            legacy.execute("ALTER TABLE operations DROP COLUMN " + name)
        legacy.commit()
        old_columns = [row[1] for row in legacy.execute("PRAGMA table_info(operations)")]
        old_rows = legacy.execute("SELECT * FROM operations").fetchall()
        legacy.close()
        upgrade = Registry._upgrade
        def failing(registry):
            upgrade(registry)
            raise sqlite3.OperationalError("injected migration interruption")
        with patch.object(Registry, "_upgrade", failing), self.assertRaises(sqlite3.OperationalError):
            Registry(self.path)
        legacy = sqlite3.connect(self.path)
        self.assertEqual([row[1] for row in legacy.execute("PRAGMA table_info(operations)")], old_columns)
        self.assertEqual(legacy.execute("SELECT * FROM operations").fetchall(), old_rows)
        legacy.close()
        # Reopening also proves the failed constructor released its flock.
        self.registry = Registry(self.path)
        self.bridge.registry = self.registry
        projection = ",".join(old_columns)
        self.assertEqual([tuple(row) for row in self.registry.db.execute("SELECT " + projection + " FROM operations")], old_rows)
        # Same explicit-column write the old controller uses still succeeds.
        with self.registry.transaction():
            self.registry.db.execute("UPDATE operations SET last_seen=last_seen+1 WHERE id=?", (old_rows[0][0],))
        self.assertEqual(self.registry.get(old_rows[0][0])["api_trace_id"], None)


class StageListTests(unittest.TestCase):
    def test_the_controller_keeps_exactly_the_stages_the_runner_reports(self):
        # The controller ships without the runner's source, so it keeps its own copy of the stage names; a stage
        # the runner adds would otherwise be dropped from every diagnostic without an error.
        import importlib.util
        source = Path(__file__).resolve().parents[3] / "apps" / "api" / "runner" / "runtime_diagnostics.py"
        spec = importlib.util.spec_from_file_location("runner_runtime_diagnostics", source)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        import operation_trace
        self.assertEqual(set(operation_trace.STAGES), set(runner.STAGES))


if __name__ == "__main__": unittest.main()
