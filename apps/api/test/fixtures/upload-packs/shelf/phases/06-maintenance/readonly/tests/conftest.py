"""The fixtures every API test uses.

The suite talks to the application through Flask's own test client rather
than a socket, so a test reads exactly like the request it stands for:

    response = client.post("/api/books/3/lend", json={"borrower": "Ade"})
    assert response.status_code == 200
"""

import os
import sys

# The tests import the application by package name, so the project root has to
# be on the import path however pytest was started.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from api.main import create_app  # noqa: E402


@pytest.fixture
def client():
    """A fresh application, with an empty shelf, for one test."""
    application = create_app()
    application.config["TESTING"] = True
    with application.test_client() as test_client:
        yield test_client


@pytest.fixture
def add_book(client):
    """Put a book on the shelf through the API and return what the API said."""

    def add(title="The Left Hand of Darkness", author="Ursula K. Le Guin", year=1969):
        response = client.post("/api/books", json={"title": title, "author": author, "year": year})
        assert response.status_code == 201, response.get_json()
        return response.get_json()

    return add
