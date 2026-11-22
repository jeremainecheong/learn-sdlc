"""The list routes: everything under /api/lists."""

from flask import Blueprint, jsonify, request

from api.db import connect
from api.errors import fail
from api.repository import lists

bp = Blueprint("lists", __name__)


@bp.get("/api/lists")
def get_lists():
    """Every list, with how many tasks it holds and how many are still open."""
    return jsonify(lists.list_lists(connect())), 200


@bp.post("/api/lists")
def post_list():
    """Make a list."""
    payload = request.get_json(silent=True) or {}
    try:
        created = lists.create_list(connect(), payload.get("name"))
    except ValueError:
        return fail("invalid_name", "A list needs a name.", 400)
    except lists.DuplicateList:
        return fail("duplicate_list", "A list with that name already exists.", 409)
    return jsonify(created), 201
