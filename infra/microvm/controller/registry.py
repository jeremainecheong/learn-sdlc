"""Private, durable operation registry. One bridge process owns a database file."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import uuid


class Full(Exception):
    pass


class DuplicateTrace(Exception):
    """A transport retry must never allocate a second instance."""
    pass


class Registry:
    def __init__(self, path):
        self.path = Path(path).absolute()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path.parent.chmod(0o700)
        self.file_lock = open(str(self.path) + ".lock", "a+b")
        os.chmod(self.file_lock.name, 0o600)
        try:
            fcntl.flock(self.file_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.file_lock.close()
            raise
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.path.chmod(0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY, purpose TEXT NOT NULL, source_hash TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1, client_token TEXT NOT NULL UNIQUE,
            control_token TEXT NOT NULL, launch_json TEXT NOT NULL,
            vm_id TEXT, endpoint TEXT, guest_id TEXT,
            state TEXT NOT NULL, cleanup INTEGER NOT NULL DEFAULT 0,
            launch_attempts INTEGER NOT NULL DEFAULT 0,
            created REAL NOT NULL, expires REAL NOT NULL, last_seen REAL NOT NULL,
            failure TEXT, result_ok INTEGER
          );
        """)
        # Upgrade as one transaction, including indexes. A failed upgrade can
        # reopen using the old controller without a partial schema change.
        try:
            with self.transaction():
                self._upgrade()
        except BaseException:
            self.db.close()
            self.file_lock.close()
            raise
        for suffix in ("-wal", "-shm"):
            candidate = Path(str(self.path) + suffix)
            if candidate.exists(): candidate.chmod(0o600)

    def _upgrade(self):
        # All fields are nullable/defaulted additions; old controller writers
        # can continue using their explicit INSERT column lists after rollback.
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(operations)")}
        for name, definition in {
            "cleanup_attempts": "INTEGER NOT NULL DEFAULT 0",
            "missing_since": "REAL",
            "missing_count": "INTEGER NOT NULL DEFAULT 0",
            "last_error_code": "TEXT",
            "last_error_stage": "TEXT",
            "last_error_at": "REAL",
            "initial_attempts": "INTEGER NOT NULL DEFAULT 0",
            "cleanup_error_code": "TEXT",
            "cleanup_error_at": "REAL",
            "cleanup_outcome": "TEXT",
            "api_trace_id": "TEXT",
            "api_owner_kind": "TEXT",
            "api_owner_id": "TEXT",
            "api_step_id": "TEXT",
            "diagnostics_json": "TEXT",
        }.items():
            if name not in columns:
                self.db.execute("ALTER TABLE operations ADD COLUMN " + name + " " + definition)
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS operations_api_trace ON operations(api_trace_id) WHERE api_trace_id IS NOT NULL")
        self.db.execute("CREATE INDEX IF NOT EXISTS operations_api_owner ON operations(api_owner_kind,api_owner_id,api_step_id)")
    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            else:
                self.db.execute("COMMIT")

    def create(self, purpose, source_hash, limit, launch_builder, now=None, trace=None):
        now = time.time() if now is None else now
        operation = str(uuid.uuid4())
        secret = secrets.token_hex(32)
        parameters = launch_builder(operation, secret)
        with self.transaction():
            if trace and self.db.execute("SELECT 1 FROM operations WHERE api_trace_id=?", (trace["attemptId"],)).fetchone():
                raise DuplicateTrace()
            count = self.db.execute("SELECT COUNT(*) FROM operations WHERE purpose=? AND state NOT IN ('terminated','expired-unconfirmed')", (purpose,)).fetchone()[0]
            if count >= limit:
                raise Full()
            self.db.execute("""INSERT INTO operations
                (id,purpose,source_hash,client_token,control_token,launch_json,state,created,expires,last_seen,
                 api_trace_id,api_owner_kind,api_owner_id,api_step_id)
                VALUES (?,?,?,?,?,?,'creating',?,?,?,?,?,?,?)""",
                (operation, purpose, source_hash, operation, secret,
                 json.dumps(parameters, sort_keys=True), now,
                 now + parameters["maximumDurationInSeconds"] + 60, now,
                 *((trace[key] for key in ("attemptId", "kind", "ownerId", "stepId")) if trace else (None,) * 4)))
        return self.get(operation)

    def get(self, operation):
        with self.lock:
            row = self.db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
            return dict(row) if row else None

    def owner_operations(self, kind, owner_id):
        # Two rows are enough to prove ambiguity; never silently select latest.
        with self.lock:
            return [dict(row) for row in self.db.execute(
                "SELECT * FROM operations WHERE api_owner_kind=? AND api_owner_id=? LIMIT 2", (kind, owner_id))]

    def update(self, operation, **fields):
        permitted = {"vm_id", "endpoint", "guest_id", "state", "cleanup", "launch_attempts",
                     "expires", "last_seen", "failure", "result_ok", "cleanup_attempts",
                     "missing_since", "missing_count", "last_error_code", "last_error_stage",
                     "last_error_at", "initial_attempts", "cleanup_error_code",
                     "cleanup_error_at", "cleanup_outcome", "diagnostics_json"}
        if not fields or not fields.keys() <= permitted:
            raise ValueError("invalid registry update")
        with self.transaction():
            self.db.execute("UPDATE operations SET " + ",".join(key + "=?" for key in fields) + " WHERE id=?",
                            (*fields.values(), operation))
        return self.get(operation)

    def active(self):
        with self.lock:
            return [dict(row) for row in self.db.execute("SELECT * FROM operations WHERE state NOT IN ('terminated','expired-unconfirmed')")]

    def stats(self):
        with self.lock:
            counts = {purpose: self.db.execute("SELECT COUNT(*) FROM operations WHERE purpose=? AND state NOT IN ('terminated','expired-unconfirmed')", (purpose,)).fetchone()[0]
                      for purpose in ("job", "preview")}
            counts["expiredUnconfirmed"] = self.db.execute("SELECT COUNT(*) FROM operations WHERE state='expired-unconfirmed'").fetchone()[0]
            return counts

    def close(self):
        self.db.close()
        self.file_lock.close()
