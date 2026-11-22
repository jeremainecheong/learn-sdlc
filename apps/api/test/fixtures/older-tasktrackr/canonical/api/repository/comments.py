"""Comments on tasks: the rows behind the count a task row shows."""

from api.db import now, row, rows
from api.repository import tasks

COMMENT_SELECT = "SELECT id, task_id, author, body, created_at FROM comments"


def _to_comment(record):
    """One row as the Comment the contract publishes."""
    return {
        "id": record["id"],
        "task_id": record["task_id"],
        "author": record["author"],
        "body": record["body"],
        "created_at": record["created_at"],
    }


def list_comments(conn, task_id):
    """Every comment on a task, newest first. KeyError for an unknown task."""
    tasks.get_task(conn, task_id)
    found = rows(
        conn,
        COMMENT_SELECT + " WHERE task_id = ? ORDER BY created_at DESC, id DESC",
        (task_id,),
    )
    return [_to_comment(record) for record in found]


def add_comment(conn, task_id, author, body):
    """Add a comment and return it.

    Raises KeyError for an unknown task and ValueError when the author or the
    body is empty, because a comment with neither says nothing to the next
    person who reads the task.
    """
    tasks.get_task(conn, task_id)
    author = (author or "").strip()
    body = (body or "").strip()
    if not author or not body:
        raise ValueError("a comment needs an author and a body")
    created = conn.execute(
        "INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)",
        (task_id, author, body, now()),
    )
    conn.commit()
    return _to_comment(row(conn, COMMENT_SELECT + " WHERE id = ?", (created.lastrowid,)))


def count_for_task(conn, task_id):
    """How many comments a task carries."""
    return row(conn, "SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", (task_id,))["n"]
