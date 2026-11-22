"""Lists: the rows, and every query that touches them.

The repository layer knows about SQL and knows nothing about HTTP. It raises
KeyError for a row that is not there and ValueError for an argument the domain
refuses; api/routes turns those into the status codes the contract names.
"""

import sqlite3

from api.db import now, row, rows

LIST_SELECT = """
    SELECT l.id, l.name, l.created_at,
           (SELECT COUNT(*) FROM tasks t
             WHERE t.list_id = l.id)                        AS task_count,
           (SELECT COUNT(*) FROM tasks t
             WHERE t.list_id = l.id AND t.status = 'open')   AS open_count
      FROM lists l
"""


class DuplicateList(Exception):
    """A list with that name already exists."""


def _to_list(record):
    """One row as the TaskList the contract publishes."""
    return {
        "id": record["id"],
        "name": record["name"],
        "created_at": record["created_at"],
        "task_count": record["task_count"],
        "open_count": record["open_count"],
    }


def list_lists(conn):
    """Every list in the order they were made, each with its two counts."""
    return [_to_list(record) for record in rows(conn, LIST_SELECT + " ORDER BY l.id")]


def get_list(conn, list_id):
    """One list. Raises KeyError when no list has that id."""
    record = row(conn, LIST_SELECT + " WHERE l.id = ?", (list_id,))
    if record is None:
        raise KeyError(list_id)
    return _to_list(record)


def create_list(conn, name):
    """Add a list and return it.

    Raises ValueError for an empty name and DuplicateList for one that is
    taken. The duplicate is caught from the UNIQUE constraint rather than from
    a SELECT first, so two requests arriving together cannot both win.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("a list needs a name")
    try:
        created = conn.execute(
            "INSERT INTO lists (name, created_at) VALUES (?, ?)", (name, now())
        )
    except sqlite3.IntegrityError as clash:
        raise DuplicateList(name) from clash
    conn.commit()
    return get_list(conn, created.lastrowid)
