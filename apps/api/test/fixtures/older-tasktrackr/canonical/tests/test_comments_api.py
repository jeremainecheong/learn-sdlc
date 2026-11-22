"""The comment endpoints, and the count they put on a task."""

import pytest


@pytest.fixture
def task(make_task):
    return make_task("Renew the passport")


def test_a_comment_comes_back_with_its_author(client, task):
    response = client.post(
        f"/api/tasks/{task['id']}/comments",
        json={"author": "sam", "body": "The form needs a recent photo."},
    )
    assert response.status_code == 201
    created = response.get_json()
    assert created["author"] == "sam"
    assert created["body"] == "The form needs a recent photo."
    assert created["task_id"] == task["id"]
    assert created["created_at"]


def test_comments_come_back_newest_first(client, task):
    for body in ("first", "second", "third"):
        client.post(
            f"/api/tasks/{task['id']}/comments", json={"author": "sam", "body": body}
        )
    found = client.get(f"/api/tasks/{task['id']}/comments").get_json()
    assert [comment["body"] for comment in found] == ["third", "second", "first"]


def test_a_task_with_no_comments_has_none(client, task):
    assert client.get(f"/api/tasks/{task['id']}/comments").get_json() == []


def test_a_comment_needs_an_author_and_a_body(client, task):
    response = client.post(
        f"/api/tasks/{task['id']}/comments", json={"author": "sam", "body": "   "}
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_comment"


def test_commenting_on_an_unknown_task_is_a_404(client):
    response = client.post(
        "/api/tasks/404/comments", json={"author": "sam", "body": "hello"}
    )
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"


def test_reading_the_comments_of_an_unknown_task_is_a_404(client):
    response = client.get("/api/tasks/404/comments")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"


def test_the_task_carries_how_many_comments_it_has(client, task):
    client.post(f"/api/tasks/{task['id']}/comments", json={"author": "sam", "body": "one"})
    client.post(f"/api/tasks/{task['id']}/comments", json={"author": "ada", "body": "two"})
    assert client.get(f"/api/tasks/{task['id']}").get_json()["comment_count"] == 2


def test_deleting_a_task_takes_its_comments_with_it(client, task, app):
    client.post(f"/api/tasks/{task['id']}/comments", json={"author": "sam", "body": "one"})
    client.delete(f"/api/tasks/{task['id']}")

    with app.app_context():
        from api.db import connect

        left = connect().execute(
            "SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", (task["id"],)
        ).fetchone()["n"]
    assert left == 0
