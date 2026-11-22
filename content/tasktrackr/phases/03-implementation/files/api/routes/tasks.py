"""The task routes: the tasks inside a list, and everything under /api/tasks.

The routes are the only place that knows about HTTP. They read the request,
refuse what the contract refuses, call the repository, and turn its KeyError
and ValueError into the codes shared/contract/api.json publishes.
"""

from datetime import date

from flask import Blueprint, jsonify, request

from api.db import connect
from api.errors import fail
from api.repository import lists, tasks

bp = Blueprint("tasks", __name__)


class _Invalid(Exception):
    """A field the contract refuses, carrying the code it is refused under."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _title(value):
    if not isinstance(value, str) or not value.strip():
        raise _Invalid("invalid_title", "A task needs a title.")
    return value.strip()


def _priority(value):
    if value not in tasks.PRIORITIES:
        raise _Invalid(
            "invalid_priority", 'priority must be "low", "medium" or "high".'
        )
    return value


def _due_date(value):
    if value is None or value == "":
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as bad:
        raise _Invalid(
            "invalid_due_date", 'due_date must be an ISO date, like "2026-03-14".'
        ) from bad


def _status(value):
    if value not in tasks.STATUSES:
        raise _Invalid("invalid_status", 'status must be "open" or "done".')
    return value


def _tags(value):
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(tag, str) for tag in value):
        raise _Invalid("invalid_tags", "tags must be a list of names.")
    return value


@bp.get("/api/lists/<int:list_id>/tasks")
def get_list_tasks(list_id):
    """The tasks in one list, narrowed by status, keyword and tag (US-3)."""
    conn = connect()
    try:
        lists.get_list(conn, list_id)
    except KeyError:
        return fail("list_not_found", f"No list has id {list_id}.", 404)
    try:
        found = tasks.list_tasks(
            conn,
            list_id,
            status=request.args.get("status", "all"),
            q=request.args.get("q"),
            tag=request.args.get("tag"),
        )
    except ValueError:
        return fail("invalid_status", 'status must be "all", "open" or "done".', 400)
    return jsonify(found), 200


@bp.post("/api/lists/<int:list_id>/tasks")
def post_list_task(list_id):
    """Add a task to a list (US-1)."""
    payload = request.get_json(silent=True) or {}
    try:
        title = _title(payload.get("title"))
        priority = _priority(payload.get("priority", "medium"))
        due_date = _due_date(payload.get("due_date"))
        tag_names = _tags(payload.get("tags"))
    except _Invalid as refused:
        return fail(refused.code, refused.message, 400)
    try:
        created = tasks.create_task(
            connect(), list_id, title, priority, due_date, tag_names
        )
    except KeyError:
        return fail("list_not_found", f"No list has id {list_id}.", 404)
    return jsonify(created), 201


@bp.get("/api/tasks/overdue")
def get_overdue_tasks():
    """The overdue report (US-4).

    The day is a required query parameter. A report that asked the machine
    what day it is would be a different report tomorrow, and could not be
    tested at all.
    """
    today = request.args.get("today")
    try:
        today = date.fromisoformat(today or "").isoformat()
    except ValueError:
        return fail(
            "invalid_date", 'today must be an ISO date, like "2026-03-14".', 400
        )
    return jsonify(tasks.overdue_tasks(connect(), today)), 200


@bp.get("/api/tasks/<int:task_id>")
def get_task(task_id):
    """One task, with its tags and how many comments it carries."""
    try:
        return jsonify(tasks.get_task(connect(), task_id)), 200
    except KeyError:
        return fail("task_not_found", f"No task has id {task_id}.", 404)


@bp.patch("/api/tasks/<int:task_id>")
def patch_task(task_id):
    """Change a task's title, priority, due date or status."""
    payload = request.get_json(silent=True) or {}
    changes = {}
    try:
        if "title" in payload:
            changes["title"] = _title(payload["title"])
        if "priority" in payload:
            changes["priority"] = _priority(payload["priority"])
        if "due_date" in payload:
            changes["due_date"] = _due_date(payload["due_date"])
        if "status" in payload:
            changes["status"] = _status(payload["status"])
    except _Invalid as refused:
        return fail(refused.code, refused.message, 400)
    try:
        return jsonify(tasks.update_task(connect(), task_id, changes)), 200
    except KeyError:
        return fail("task_not_found", f"No task has id {task_id}.", 404)


@bp.post("/api/tasks/<int:task_id>/complete")
def complete_task(task_id):
    """Mark a task done and return it (US-2).

    404 with code "task_not_found" when no task has that id. Completing an
    already-done task is a no-op that returns it unchanged.
    """
    # TODO(learner): implement to the US-2 contract. repository.tasks has a
    # helper that already raises for an unknown id, and errors.py has the one
    # function that builds the 404 envelope.
    raise NotImplementedError("complete_task is not implemented yet")


@bp.post("/api/tasks/<int:task_id>/reopen")
def reopen_task(task_id):
    """Put a task back on the list."""
    try:
        return jsonify(tasks.reopen_task(connect(), task_id)), 200
    except KeyError:
        return fail("task_not_found", f"No task has id {task_id}.", 404)


@bp.delete("/api/tasks/<int:task_id>")
def delete_task(task_id):
    """Remove a task, its tags and its comments."""
    try:
        tasks.delete_task(connect(), task_id)
    except KeyError:
        return fail("task_not_found", f"No task has id {task_id}.", 404)
    return "", 204
