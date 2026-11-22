"""Every error this API answers with is built here, in one place.

One shape, so a front end can rely on it without reading the routes:

    {"error": {"code": "task_not_found", "message": "No task has id 7."}}

The code is for the program, the message is for the person, and the status is
the one HTTP already has a word for.
"""

from flask import jsonify


def fail(code, message, status):
    """The error envelope, ready to be returned from a route."""
    return jsonify({"error": {"code": code, "message": message}}), status


def register_error_handlers(app):
    """Answer the framework's own errors in the same shape as ours.

    Without this, a request to an address no route claims comes back as
    Werkzeug's HTML page, and a front end that only ever parses JSON breaks on
    the one response it did not expect.
    """

    @app.errorhandler(400)
    def _bad_request(_exception):
        return fail("invalid_request", "The request body is not valid JSON.", 400)

    @app.errorhandler(404)
    def _not_found(_exception):
        return fail("not_found", "There is nothing at that address.", 404)

    @app.errorhandler(405)
    def _method_not_allowed(_exception):
        return fail(
            "method_not_allowed", "That address does not answer to this method.", 405
        )

    @app.errorhandler(500)
    def _server_error(_exception):
        return fail("server_error", "Something went wrong inside the API.", 500)
