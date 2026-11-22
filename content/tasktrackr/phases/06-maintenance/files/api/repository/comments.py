"""Comments on tasks: the rows behind the count a task row shows.

CR-2 asks for the two operations below. The table already exists — read
`api/schema.sql` — and `count_for_task` is here, finished, because it shows you
the shape of the query the count needs.

Nothing else in this file is new: `COMMENT_SELECT` names the columns the
contract publishes, and `_to_comment` turns one row into the Comment the front
end reads. Write the two gaps and leave the rest alone.
"""

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
    """Every comment on a task, newest first. KeyError for an unknown task.

    Newest first means `ORDER BY created_at DESC, id DESC`: the timestamps are
    only accurate to the second, so two comments left in the same second would
    come back in an order nobody can predict without the id.
    """
    # TODO(learner) CR-2: read the comments on one task.
    # `tasks.get_task(conn, task_id)` raises KeyError for an unknown task, and
    # calling it first is what makes the route able to answer 404.
    raise NotImplementedError("CR-2: list_comments is yours to write.")


def add_comment(conn, task_id, author, body):
    """Add a comment and return it.

    Raises KeyError for an unknown task and ValueError when the author or the
    body is empty, because a comment with neither says nothing to the next
    person who reads the task. Whitespace alone is empty.
    """
    # TODO(learner) CR-2: store one comment and return it.
    # `now()` is the timestamp every row in this application is stamped with.
    # `conn.execute(...)` gives you `lastrowid`; commit, then read the row back
    # through COMMENT_SELECT so the caller gets the same shape list_comments
    # returns.
    raise NotImplementedError("CR-2: add_comment is yours to write.")


def count_for_task(conn, task_id):
    """How many comments a task carries."""
    return row(conn, "SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", (task_id,))["n"]
