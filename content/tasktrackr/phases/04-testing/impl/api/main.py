"""TaskTrackr's API: the application factory, and the two ways to start it.

    python3 api/main.py              serve the API on PORT, 8000 by default
    python3 api/main.py --selfcheck  check this deployment and print one line

The same file runs under the development server, inside the container and in
the live preview, because all three do the same thing: read PORT and listen.
"""

import os
import sys
from pathlib import Path

# Run as a script, python puts api/ on the import path and not the project
# root, so `import api.db` would fail. Imported as a module — by the tests, or
# by a WSGI server — the root is already there and this does nothing.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask, jsonify  # noqa: E402  (after the path fix above)

from api.db import close_connection, init_db  # noqa: E402
from api.errors import register_error_handlers  # noqa: E402
from api.routes import comments, lists, tasks  # noqa: E402

VERSION = "2.0.0"


def create_app():
    """Build the application: the schema, the error shape and the three blueprints."""
    app = Flask(__name__)

    @app.get("/api/health")
    def health():
        """What a healthcheck asks. The one route that touches no data."""
        return jsonify({"status": "ok", "version": VERSION}), 200

    app.register_blueprint(lists.bp)
    app.register_blueprint(tasks.bp)
    app.register_blueprint(comments.bp)
    register_error_handlers(app)
    app.teardown_appcontext(close_connection)
    with app.app_context():
        init_db()
    return app


def main(argv):
    """Start the server, or run the selfcheck and stop."""
    if "--selfcheck" in argv:
        from ops.selfcheck import selfcheck

        return selfcheck()
    app = create_app()
    # Loopback by default: the app belongs to one person on one machine unless
    # a deployment says otherwise, and api/Dockerfile sets HOST=0.0.0.0 for the
    # container, where nothing outside could reach it any other way.
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
