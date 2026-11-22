"""The comment routes: the conversation attached to one task."""

from flask import Blueprint, jsonify, request

from api.db import connect
from api.errors import fail
from api.repository import comments

bp = Blueprint("comments", __name__)


@bp.get("/api/tasks/<int:task_id>/comments")
def get_task_comments(task_id):
    """Every comment on a task, newest first."""
    try:
        return jsonify(comments.list_comments(connect(), task_id)), 200
    except KeyError:
        return fail("task_not_found", f"No task has id {task_id}.", 404)


@bp.post("/api/tasks/<int:task_id>/comments")
def post_task_comment(task_id):
    """Leave a comment on a task."""
    payload = request.get_json(silent=True) or {}
    try:
        created = comments.add_comment(
            connect(), task_id, payload.get("author"), payload.get("body")
        )
    except KeyError:
        return fail("task_not_found", f"No task has id {task_id}.", 404)
    except ValueError:
        return fail("invalid_comment", "A comment needs an author and a body.", 400)
    return jsonify(created), 201
