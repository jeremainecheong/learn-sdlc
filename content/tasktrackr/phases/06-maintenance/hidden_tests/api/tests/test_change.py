"""The change suite for CR-2: comments on a task, and the count on the row.

Sealed, so it runs under the unittest harness and builds its own application
rather than leaning on the pytest fixtures in tests/conftest.py. Six cases, one
per line of the change request.
"""

import os
import sys
import unittest

_ROOT = os.getcwd()
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# The whole suite runs against a database that lives in memory, so no case can
# see another's rows and nothing is left on disk.
os.environ["TASKTRACKR_DB"] = ":memory:"

from api.main import create_app  # noqa: E402


class CommentChange(unittest.TestCase):
    def setUp(self):
        app = create_app()
        app.config["TESTING"] = True
        self.app = app
        self.client = app.test_client()
        listing = self.client.post("/api/lists", json={"name": "Home"}).get_json()
        self.task = self.client.post(
            f"/api/lists/{listing['id']}/tasks", json={"title": "Renew the passport"}
        ).get_json()

    def comment(self, author="sam", body="The form needs a recent photo."):
        return self.client.post(
            f"/api/tasks/{self.task['id']}/comments", json={"author": author, "body": body}
        )

    def test_a_comment_is_stored_with_its_author_and_body(self):
        response = self.comment()
        self.assertEqual(response.status_code, 201)
        created = response.get_json()
        self.assertEqual(created["author"], "sam")
        self.assertEqual(created["body"], "The form needs a recent photo.")
        self.assertEqual(created["task_id"], self.task["id"])
        self.assertTrue(created["created_at"])
        self.assertTrue(created["id"])

    def test_comments_come_back_newest_first(self):
        for body in ("first", "second", "third"):
            self.comment(body=body)
        found = self.client.get(f"/api/tasks/{self.task['id']}/comments").get_json()
        self.assertEqual([c["body"] for c in found], ["third", "second", "first"])

    def test_commenting_on_an_unknown_task_is_a_404(self):
        response = self.client.post(
            "/api/tasks/4040/comments", json={"author": "sam", "body": "hello"}
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"]["code"], "task_not_found")

    def test_a_comment_needs_an_author_and_a_body(self):
        blank = self.comment(body="   ")
        self.assertEqual(blank.status_code, 400)
        self.assertEqual(blank.get_json()["error"]["code"], "invalid_comment")
        nameless = self.comment(author="")
        self.assertEqual(nameless.status_code, 400)
        self.assertEqual(nameless.get_json()["error"]["code"], "invalid_comment")

    def test_the_count_on_the_task_moves_with_its_comments(self):
        self.assertEqual(self.task["comment_count"], 0)
        self.comment(body="one")
        self.comment(author="ada", body="two")
        one = self.client.get(f"/api/tasks/{self.task['id']}").get_json()
        self.assertEqual(one["comment_count"], 2)
        listed = self.client.get(f"/api/lists/{self.task['list_id']}/tasks").get_json()
        self.assertEqual([t["comment_count"] for t in listed], [2])

    def test_deleting_a_task_takes_its_comments_with_it(self):
        self.assertEqual(self.comment(body="one").status_code, 201)
        self.assertEqual(
            len(self.client.get(f"/api/tasks/{self.task['id']}/comments").get_json()), 1
        )
        self.assertEqual(self.client.delete(f"/api/tasks/{self.task['id']}").status_code, 204)
        with self.app.app_context():
            from api.db import connect

            left = connect().execute(
                "SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", (self.task["id"],)
            ).fetchone()["n"]
        self.assertEqual(left, 0)


if __name__ == "__main__":
    unittest.main()
