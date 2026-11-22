"""A smoke of CR-2 — three questions the change has to answer.

This is the fast loop, not the grade. Run it as you work: the graders run a
longer change suite and the whole regression suite behind it, and the two
suites beside this one — test_lists_api.py and test_tasks_api.py — are the
regression suite you can run yourself. Run all of them before you submit.
"""

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


def test_the_task_carries_how_many_comments_it_has(client, task):
    client.post(f"/api/tasks/{task['id']}/comments", json={"author": "sam", "body": "one"})
    client.post(f"/api/tasks/{task['id']}/comments", json={"author": "ada", "body": "two"})
    assert client.get(f"/api/tasks/{task['id']}").get_json()["comment_count"] == 2


def test_reading_the_comments_of_an_unknown_task_is_a_404(client):
    response = client.get("/api/tasks/404/comments")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"
