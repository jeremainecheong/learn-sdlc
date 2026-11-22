"""The regression suite: everything the API already did, after CR-2.

These are the behaviours phases 1 to 4 specified, implemented and proved, in
the sealed harness. They are the same behaviours the two suites in your own
workspace cover — tests/test_lists_api.py and tests/test_tasks_api.py — so if
you run those before you submit, nothing here is a surprise.

Most of them ask how many tasks came back, and that is deliberate. The count a
task carries is read out of the task query, and a query that reaches for it the
wrong way changes how many rows the task query returns. Every screen in the
application reads that query.
"""

import os
import sys
import unittest

_ROOT = os.getcwd()
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

os.environ["TASKTRACKR_DB"] = ":memory:"

from api.main import create_app  # noqa: E402


class ApiCase(unittest.TestCase):
    """One application, one empty in-memory database, per test."""

    def setUp(self):
        app = create_app()
        app.config["TESTING"] = True
        self.app = app
        self.client = app.test_client()

    def make_list(self, name="Home"):
        return self.client.post("/api/lists", json={"name": name}).get_json()

    def add(self, list_id, title, **fields):
        payload = {"title": title}
        payload.update(fields)
        return self.client.post(f"/api/lists/{list_id}/tasks", json=payload).get_json()

    def titles(self, response):
        return [task["title"] for task in response.get_json()]


class ListsRegression(ApiCase):
    def test_health_still_reports_the_version(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok", "version": "2.0.0"})

    def test_a_new_list_still_comes_back_with_its_counts(self):
        response = self.client.post("/api/lists", json={"name": "Home"})
        self.assertEqual(response.status_code, 201)
        created = response.get_json()
        self.assertEqual(created["name"], "Home")
        self.assertEqual(created["task_count"], 0)
        self.assertEqual(created["open_count"], 0)

    def test_a_list_without_a_name_is_still_refused(self):
        response = self.client.post("/api/lists", json={"name": "  "})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "invalid_name")

    def test_a_duplicate_list_name_is_still_a_409(self):
        self.make_list("Home")
        response = self.client.post("/api/lists", json={"name": "Home"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error"]["code"], "duplicate_list")

    def test_the_counts_on_a_list_still_move_with_its_tasks(self):
        home = self.make_list()
        first = self.add(home["id"], "Pay the rent")
        self.add(home["id"], "Water the plants")
        self.client.post(f"/api/tasks/{first['id']}/complete")
        found = self.client.get("/api/lists").get_json()
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["task_count"], 2)
        self.assertEqual(found[0]["open_count"], 1)


class TaskRegression(ApiCase):
    def setUp(self):
        super().setUp()
        self.home = self.make_list()

    def test_a_new_task_still_starts_open_with_no_tags(self):
        created = self.add(self.home["id"], "Pay the rent")
        self.assertEqual(created["priority"], "medium")
        self.assertEqual(created["status"], "open")
        self.assertIsNone(created["due_date"])
        self.assertIsNone(created["completed_at"])
        self.assertEqual(created["tags"], [])

    def test_a_task_still_keeps_its_priority_due_date_and_sorted_tags(self):
        created = self.add(
            self.home["id"],
            "Renew the passport",
            priority="high",
            due_date="2026-03-14",
            tags=["travel", "admin"],
        )
        self.assertEqual(created["priority"], "high")
        self.assertEqual(created["due_date"], "2026-03-14")
        self.assertEqual(created["tags"], ["admin", "travel"])

    def test_a_task_on_an_unknown_list_is_still_a_404(self):
        response = self.client.post("/api/lists/4040/tasks", json={"title": "Nowhere"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"]["code"], "list_not_found")

    def test_an_unknown_priority_is_still_a_400(self):
        response = self.client.post(
            f"/api/lists/{self.home['id']}/tasks",
            json={"title": "Pay the rent", "priority": "urgent"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "invalid_priority")

    def test_an_unknown_task_is_still_a_404(self):
        response = self.client.get("/api/tasks/4040")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"]["code"], "task_not_found")

    def test_completing_and_reopening_a_task_still_works(self):
        task = self.add(self.home["id"], "Ship it")
        done = self.client.post(f"/api/tasks/{task['id']}/complete").get_json()
        self.assertEqual(done["status"], "done")
        self.assertTrue(done["completed_at"])
        again = self.client.post(f"/api/tasks/{task['id']}/reopen").get_json()
        self.assertEqual(again["status"], "open")
        self.assertIsNone(again["completed_at"])

    def test_patching_a_task_still_changes_only_what_it_names(self):
        task = self.add(self.home["id"], "Pay the rent", priority="low")
        patched = self.client.patch(
            f"/api/tasks/{task['id']}", json={"priority": "high"}
        ).get_json()
        self.assertEqual(patched["priority"], "high")
        self.assertEqual(patched["title"], "Pay the rent")

    def test_deleting_a_task_still_removes_it(self):
        task = self.add(self.home["id"], "Pay the rent")
        self.assertEqual(self.client.delete(f"/api/tasks/{task['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/tasks/{task['id']}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/lists/{self.home['id']}/tasks").get_json(), [])


class FilterRegression(ApiCase):
    def setUp(self):
        super().setUp()
        self.home = self.make_list()
        self.add(self.home["id"], "Pay the rent", priority="high", due_date="2026-03-01")
        self.add(self.home["id"], "Read the notes", priority="low", tags=["study"])
        self.add(self.home["id"], "Renew the passport", priority="medium")
        self.add(self.home["id"], "Ring the bank", priority="high")

    def test_a_list_still_comes_back_highest_priority_first_ties_by_id(self):
        found = self.client.get(f"/api/lists/{self.home['id']}/tasks")
        self.assertEqual(
            self.titles(found),
            ["Pay the rent", "Ring the bank", "Renew the passport", "Read the notes"],
        )

    def test_every_task_in_the_list_still_comes_back(self):
        found = self.client.get(f"/api/lists/{self.home['id']}/tasks").get_json()
        self.assertEqual(len(found), 4)

    def test_the_status_filter_still_works(self):
        first = self.client.get(f"/api/lists/{self.home['id']}/tasks").get_json()[0]
        self.client.post(f"/api/tasks/{first['id']}/complete")
        still_open = self.client.get(f"/api/lists/{self.home['id']}/tasks?status=open")
        self.assertEqual(len(still_open.get_json()), 3)
        done = self.client.get(f"/api/lists/{self.home['id']}/tasks?status=done")
        self.assertEqual(self.titles(done), ["Pay the rent"])

    def test_an_unknown_status_is_still_a_400(self):
        response = self.client.get(f"/api/lists/{self.home['id']}/tasks?status=later")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "invalid_status")

    def test_the_keyword_search_is_still_case_insensitive(self):
        shouting = self.client.get(f"/api/lists/{self.home['id']}/tasks?q=RENT")
        self.assertEqual(self.titles(shouting), ["Pay the rent"])
        whispering = self.client.get(f"/api/lists/{self.home['id']}/tasks?q=ring")
        self.assertEqual(self.titles(whispering), ["Ring the bank"])

    def test_the_tag_filter_still_works(self):
        found = self.client.get(f"/api/lists/{self.home['id']}/tasks?tag=study")
        self.assertEqual(self.titles(found), ["Read the notes"])

    def test_the_tasks_of_an_unknown_list_are_still_a_404(self):
        response = self.client.get("/api/lists/4040/tasks")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"]["code"], "list_not_found")


class OverdueRegression(ApiCase):
    def setUp(self):
        super().setUp()
        self.home = self.make_list()
        self.late = self.add(
            self.home["id"], "Pay the rent", priority="high", due_date="2026-03-01"
        )
        self.today = self.add(self.home["id"], "Ring the bank", due_date="2026-03-10")
        self.later = self.add(self.home["id"], "Book the dentist", due_date="2026-04-01")
        self.undated = self.add(self.home["id"], "Water the plants")

    def overdue(self, today="2026-03-10"):
        return self.client.get(f"/api/tasks/overdue?today={today}")

    def test_a_task_due_today_is_still_not_overdue(self):
        self.assertEqual(self.titles(self.overdue()), ["Pay the rent"])

    def test_a_task_with_no_due_date_is_still_never_overdue(self):
        found = self.overdue("2030-01-01").get_json()
        self.assertNotIn("Water the plants", [task["title"] for task in found])
        self.assertEqual(len(found), 3)

    def test_a_finished_task_is_still_not_overdue(self):
        self.client.post(f"/api/tasks/{self.late['id']}/complete")
        self.assertEqual(self.overdue().get_json(), [])

    def test_the_overdue_report_is_still_most_overdue_first(self):
        self.assertEqual(
            self.titles(self.overdue("2026-05-01")),
            ["Pay the rent", "Ring the bank", "Book the dentist"],
        )

    def test_the_overdue_report_still_needs_a_valid_day(self):
        self.assertEqual(self.client.get("/api/tasks/overdue").status_code, 400)
        bad = self.client.get("/api/tasks/overdue?today=last%20tuesday")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.get_json()["error"]["code"], "invalid_date")


if __name__ == "__main__":
    unittest.main()
