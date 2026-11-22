"""The fixtures every API test uses.

The suite runs against Flask's own test client rather than a real socket. The
sandbox these tests run in has no network at all, and the test client goes
through the same routing, parsing, status codes and JSON bodies a browser
would, so a test here reads exactly like the request it stands for:

    response = client.post("/api/tasks/3/complete")
    assert response.status_code == 200
"""

import os
import sys

# The tests import the application by package name, so the project root has to
# be on the import path however pytest was started.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# A database that lives in memory: every test gets an empty one, and no test
# leaves a file behind. api/db.py's init_db applies schema.sql when the
# application is built.
os.environ["TASKTRACKR_DB"] = ":memory:"

import pytest  # noqa: E402

from api.main import create_app  # noqa: E402


@pytest.fixture
def app():
    """A fresh application, with an empty database, for one test."""
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture
def client(app):
    """The test client the whole suite talks through."""
    with app.test_client() as test_client:
        yield test_client


@pytest.fixture
def make_list(client):
    """Make a list through the API and return it."""

    def _make(name="Home"):
        return client.post("/api/lists", json={"name": name}).get_json()

    return _make


@pytest.fixture
def make_task(client, make_list):
    """Make a task through the API and return it, making a list if needed."""
    made = {}

    def _make(title="Pay the rent", list_id=None, **fields):
        if list_id is None:
            made.setdefault("list", make_list())
            list_id = made["list"]["id"]
        payload = {"title": title}
        payload.update(fields)
        return client.post(f"/api/lists/{list_id}/tasks", json=payload).get_json()

    return _make
