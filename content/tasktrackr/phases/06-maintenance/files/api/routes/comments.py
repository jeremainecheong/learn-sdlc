"""The comment routes: the conversation attached to one task.

`api/main.py` already registers this blueprint, so the two routes CR-2 asks for
belong here and nowhere else. `api/routes/tasks.py` is the worked example: it
catches KeyError for a 404 and ValueError for a 400, and builds both with
`fail()`, so every error this API sends has one shape.
"""

from flask import Blueprint, jsonify, request

from api.db import connect
from api.errors import fail
from api.repository import comments

bp = Blueprint("comments", __name__)


# TODO(learner) CR-2: two routes, not implemented yet, exactly as the change
# request states them.
#
#   GET  /api/tasks/<int:task_id>/comments
#        200 with the comments, newest first
#        404 task_not_found  "No task has id {task_id}."
#
#   POST /api/tasks/<int:task_id>/comments   body {"author": ..., "body": ...}
#        201 with the comment that was made
#        400 invalid_comment  "A comment needs an author and a body."
#        404 task_not_found   "No task has id {task_id}."
#
# `request.get_json(silent=True) or {}` is how the other routes read a body
# without turning a missing one into a 500.
