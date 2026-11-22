"""The shelf API: a small Flask application over an in-memory shelf.

Start it with `python3 api/main.py` (the port comes from PORT, 8000 when it is
unset), or check a deployment without starting anything with
`python3 api/main.py --selfcheck`.

Every error has one shape: {"error": {"code": ..., "message": ...}}.
"""

# seal marker: SHELF-SEALED-IMPL-9B6D (the implementation the reference suite is graded against)

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from flask import Flask, jsonify, request  # noqa: E402

from api.shelf import Shelf  # noqa: E402

CONFIG_PATH = os.path.join(ROOT, "deploy", "shelf.json")


def fail(status, code, message):
    """The one error envelope every route answers with."""
    return jsonify({"error": {"code": code, "message": message}}), status


def create_app(shelf=None):
    """Build the application around one shelf (a fresh, empty one by default)."""
    app = Flask(__name__)
    store = shelf if shelf is not None else Shelf()

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    @app.get("/api/books")
    def list_books():
        return jsonify(store.books(author=request.args.get("author")))

    @app.post("/api/books")
    def add_book():
        body = request.get_json(silent=True) or {}
        try:
            book = store.add(body.get("title"), body.get("author"), body.get("year"))
        except ValueError as err:
            return fail(400, "invalid_book", str(err))
        return jsonify(book), 201

    @app.get("/api/books/<int:book_id>")
    def get_book(book_id):
        try:
            return jsonify(store.get(book_id))
        except KeyError:
            return fail(404, "book_not_found", f"no book has the id {book_id}")

    @app.post("/api/books/<int:book_id>/lend")
    def lend_book(book_id):
        body = request.get_json(silent=True) or {}
        try:
            return jsonify(store.lend(book_id, body.get("borrower")))
        except KeyError:
            return fail(404, "book_not_found", f"no book has the id {book_id}")
        except ValueError as err:
            return fail(409, "cannot_lend", str(err))

    @app.post("/api/books/<int:book_id>/return")
    def return_book(book_id):
        try:
            return jsonify(store.give_back(book_id))
        except KeyError:
            return fail(404, "book_not_found", f"no book has the id {book_id}")
        except ValueError as err:
            return fail(409, "not_on_loan", str(err))

    return app


def selfcheck(config_path=CONFIG_PATH):
    """Print one line an operator can read; non-zero when the deployment is wrong."""
    app = create_app()
    routes = sorted({rule.rule for rule in app.url_map.iter_rules() if rule.rule.startswith("/api/")})
    try:
        with open(config_path, encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError) as err:
        print(f"shelf selfcheck: cannot read {config_path}: {err}", file=sys.stderr)
        return 1
    port = config.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        print(f"shelf selfcheck: port {port!r} in deploy/shelf.json is not a port anyone can reach", file=sys.stderr)
        return 1
    if config.get("storage") != "memory":
        print(f"shelf selfcheck: storage {config.get('storage')!r} is not one this build supports", file=sys.stderr)
        return 1
    print(f"shelf selfcheck: {len(routes)} routes, config ok, port {port}")
    return 0


if __name__ == "__main__":
    if "--selfcheck" in sys.argv[1:]:
        sys.exit(selfcheck())
    create_app().run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")))
