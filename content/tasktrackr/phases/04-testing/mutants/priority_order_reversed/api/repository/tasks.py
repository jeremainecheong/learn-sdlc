"""Tasks: the rows, the filters, and the two rules the whole product turns on.

US-3 says a list comes back highest priority first and can be narrowed by
status, keyword and tag. US-4 says a task is overdue when it is still open and
its due date is strictly before the day being asked about. Both rules live in
SQL here, and the front end holds the second one again in TypeScript, because a
badge on a row must not need a round trip.
"""

from api.db import now, row, rows
from api.repository import lists

PRIORITIES = ("low", "medium", "high")
STATUSES = ("open", "done")

# The fields PATCH may change. The names in an UPDATE are built from this
# tuple and never from the request body, which is what keeps the statement
# below safe to assemble as a string.
UPDATABLE = ("title", "priority", "due_date", "status")

# Highest priority first. Ties are broken by id, so a list never reorders
# itself between two identical requests.
PRIORITY_ORDER = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END"

TASK_SELECT = """
    SELECT t.id, t.list_id, t.title, t.priority, t.due_date, t.status,
           t.created_at, t.completed_at,
           (SELECT COUNT(*) FROM comments c
             WHERE c.task_id = t.id)                         AS comment_count,
           (SELECT GROUP_CONCAT(name, ',') FROM (
               SELECT g.name AS name
                 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
                WHERE tt.task_id = t.id
                ORDER BY g.name
           ))                                                AS tag_names
      FROM tasks t
"""


def _to_task(record):
    """One row as the Task the contract publishes."""
    return {
        "id": record["id"],
        "list_id": record["list_id"],
        "title": record["title"],
        "priority": record["priority"],
        "due_date": record["due_date"],
        "status": record["status"],
        "created_at": record["created_at"],
        "completed_at": record["completed_at"],
        "tags": record["tag_names"].split(",") if record["tag_names"] else [],
        "comment_count": record["comment_count"],
    }


def get_task(conn, task_id):
    """One task. Raises KeyError when no task has that id."""
    record = row(conn, TASK_SELECT + " WHERE t.id = ?", (task_id,))
    if record is None:
        raise KeyError(task_id)
    return _to_task(record)


def list_tasks(conn, list_id, status="all", q=None, tag=None):
    """Tasks in one list, filtered and ordered (US-3).

    ``status`` is "all", "open" or "done" — anything else is a ValueError.
    ``q`` matches the title case-insensitively. ``tag`` matches an attached
    tag. Results are highest priority first, ties broken by ascending id.
    """
    if status not in ("all",) + STATUSES:
        raise ValueError('status must be "all", "open" or "done"')
    where = ["list_id = ?"]
    params = [list_id]
    if status != "all":
        where.append("status = ?")
        params.append(status)
    if q:
        where.append("title LIKE '%' || ? || '%' COLLATE NOCASE")
        params.append(q)
    if tag:
        where.append(
            "EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id "
            "WHERE tt.task_id = t.id AND g.name = ?)"
        )
        params.append(tag)
    sql = f"{TASK_SELECT} WHERE {' AND '.join(where)} ORDER BY {PRIORITY_ORDER} DESC, id"
    return [_to_task(record) for record in rows(conn, sql, params)]


def overdue_tasks(conn, today):
    """Open tasks strictly past their due date as of ``today`` (US-4).

    A task with no due date is never overdue, and a task due today is not
    overdue yet. Most overdue first, then higher priority, then id.

    ``today`` is an ISO date string and the column holds ISO date strings,
    which sort and compare correctly as text. That is why the column is TEXT,
    and why the day is an argument rather than something this function asks
    the operating system for.
    """
    sql = (
        f"{TASK_SELECT} WHERE status = 'open' AND due_date IS NOT NULL AND due_date < ? "
        f"ORDER BY due_date, {PRIORITY_ORDER}, id"
    )
    return [_to_task(record) for record in rows(conn, sql, (today,))]


def set_tags(conn, task_id, tags):
    """Attach exactly these tag names to a task, making any that are new."""
    conn.execute("DELETE FROM task_tags WHERE task_id = ?", (task_id,))
    for name in sorted({(tag or "").strip() for tag in tags} - {""}):
        conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        tag_id = row(conn, "SELECT id FROM tags WHERE name = ?", (name,))["id"]
        conn.execute(
            "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)",
            (task_id, tag_id),
        )


def create_task(conn, list_id, title, priority="medium", due_date=None, tags=None):
    """Add a task to a list and return it (US-1).

    Raises KeyError when the list does not exist, so a task can never be
    stranded on a list nobody can open.
    """
    lists.get_list(conn, list_id)
    created = conn.execute(
        "INSERT INTO tasks (list_id, title, priority, due_date, status, created_at) "
        "VALUES (?, ?, ?, ?, 'open', ?)",
        (list_id, title.strip(), priority, due_date, now()),
    )
    set_tags(conn, created.lastrowid, tags or [])
    conn.commit()
    return get_task(conn, created.lastrowid)


def update_task(conn, task_id, changes):
    """Change some of a task's fields and return it.

    Only the fields in UPDATABLE can be changed here. Setting the status also
    writes completed_at, so the two can never disagree about whether a task is
    finished.
    """
    get_task(conn, task_id)
    fields = {name: changes[name] for name in UPDATABLE if name in changes}
    if not fields:
        return get_task(conn, task_id)
    if "status" in fields:
        fields["completed_at"] = now() if fields["status"] == "done" else None
    assignments = ", ".join(f"{name} = ?" for name in fields)
    conn.execute(
        f"UPDATE tasks SET {assignments} WHERE id = ?", (*fields.values(), task_id)
    )
    conn.commit()
    return get_task(conn, task_id)


def complete_task(conn, task_id):
    """Mark a task done and return it (US-2).

    Completing a task that is already done changes nothing and returns it
    unchanged, so a double click is not an error.
    """
    task = get_task(conn, task_id)
    if task["status"] == "done":
        return task
    conn.execute(
        "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?",
        (now(), task_id),
    )
    conn.commit()
    return get_task(conn, task_id)


def reopen_task(conn, task_id):
    """Put a task back on the list and forget when it was finished."""
    task = get_task(conn, task_id)
    if task["status"] == "open":
        return task
    conn.execute(
        "UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?", (task_id,)
    )
    conn.commit()
    return get_task(conn, task_id)


def delete_task(conn, task_id):
    """Remove a task. Its tags and its comments go with it, through the schema."""
    get_task(conn, task_id)
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.commit()
