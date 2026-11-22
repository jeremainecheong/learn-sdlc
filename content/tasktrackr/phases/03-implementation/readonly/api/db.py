"""The database: where it lives, how it is shaped, and who holds the connection.

TASKTRACKR_DB names the file, and defaults to ./tasktrackr.db beside the app.
The value ":memory:" is honoured, which is what the test suite uses.

An in-memory database exists only while a connection to it is open, so that one
connection is kept on the application instead of being closed after every
request. A file database gets a fresh connection per request, which is what a
threaded server needs.
"""

import os
import sqlite3
from datetime import datetime, timezone

from flask import current_app, g

MEMORY = ":memory:"
DEFAULT_DATABASE = "./tasktrackr.db"
SCHEMA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")


def database_path():
    """Where this deployment keeps its data."""
    return os.environ.get("TASKTRACKR_DB") or DEFAULT_DATABASE


def open_connection(path=None):
    """Open one connection, with the settings the whole application depends on."""
    path = path or database_path()
    if path != MEMORY:
        # A deployment can point TASKTRACKR_DB at data/preview.sqlite before
        # anything has made data/; sqlite will not create the directory itself.
        parent = os.path.dirname(os.path.abspath(path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
    # The in-memory connection is shared by every request, and the server serves
    # requests on more than one thread, so its thread check has to come off.
    conn = sqlite3.connect(path, check_same_thread=(path != MEMORY))
    conn.row_factory = sqlite3.Row
    # sqlite does not enforce foreign keys unless it is asked to, once per
    # connection. Without this, deleting a task would leave its comments behind.
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def connect():
    """The connection for the request being served."""
    if "db" in g:
        return g.db
    path = database_path()
    if path == MEMORY:
        conn = current_app.extensions.get("tasktrackr_db")
        if conn is None:
            conn = open_connection(path)
            current_app.extensions["tasktrackr_db"] = conn
        g.db = conn
        g.db_is_ours = False
    else:
        g.db = open_connection(path)
        g.db_is_ours = True
    return g.db


def close_connection(_exception=None):
    """Close this request's connection, unless it is the shared in-memory one."""
    conn = g.pop("db", None)
    if conn is not None and g.pop("db_is_ours", False):
        conn.close()


def table_names(conn):
    """The tables this application defines, without sqlite's own bookkeeping."""
    found = conn.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [record["name"] for record in found]


def init_db(conn=None):
    """Apply schema.sql to an empty database and return the table count.

    Safe to call twice: a database that already has a tasks table is left
    alone, which is what makes starting the app on existing data harmless.
    """
    conn = conn or connect()
    if "tasks" not in table_names(conn):
        with open(SCHEMA_FILE, "r", encoding="utf-8") as handle:
            conn.executescript(handle.read())
        conn.commit()
    return len(table_names(conn))


def now():
    """The timestamp every row is stamped with: UTC, to the second."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rows(conn, sql, params=()):
    """Every row a query returns."""
    return conn.execute(sql, params).fetchall()


def row(conn, sql, params=()):
    """The first row a query returns, or None."""
    return conn.execute(sql, params).fetchone()
