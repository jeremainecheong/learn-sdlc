"""The hidden API suite for phase 3: the same three contracts, asked harder.

Fourteen cases over the two repository gaps and the one route gap. They are
sealed, so they never reach the workspace the learner edits, and they are
written against the HTTP contract rather than against any particular way of
satisfying it: any implementation that answers what shared/contract/api.json
publishes passes all fourteen.

unittest rather than pytest, deliberately (wave F decision 2): the graded
artefacts stay on the harness whose seal has been proved. Nothing here uses
tests/conftest.py, so this suite builds its own application per case.
"""

import os
import unittest

# The suite must own its database before anything imports api.db, and an
# in-memory one lives exactly as long as the connection the app holds, so
# every case below starts empty without deleting a file.
os.environ["TASKTRACKR_DB"] = ":memory:"

from api.main import create_app  # noqa: E402


class ApiCase(unittest.TestCase):
    """One fresh application, and therefore one empty database, per case."""

    def setUp(self):
        app = create_app()
        app.config["TESTING"] = True
        self.client = app.test_client()

    def make_list(self, name="Home"):
        return self.client.post("/api/lists", json={"name": name}).get_json()

    def make_task(self, title, list_id=None, **fields):
        if list_id is None:
            list_id = getattr(self, "_list", None) or self.make_list()["id"]
            self._list = list_id
        payload = {"title": title}
        payload.update(fields)
        return self.client.post(f"/api/lists/{list_id}/tasks", json=payload).get_json()

    def tasks_in(self, list_id, query=""):
        return self.client.get(f"/api/lists/{list_id}/tasks{query}").get_json()


class CompletingATask(ApiCase):
    """US-2, and the route that carries it."""

    def test_a_completed_task_comes_back_done_and_stamped(self):
        task = self.make_task("Pay the rent")

        response = self.client.post(f"/api/tasks/{task['id']}/complete")

        self.assertEqual(200, response.status_code)
        completed = response.get_json()
        self.assertEqual("done", completed["status"])
        self.assertIsNotNone(completed["completed_at"])

    def test_the_row_itself_is_changed_not_just_the_answer(self):
        task = self.make_task("Pay the rent")

        self.client.post(f"/api/tasks/{task['id']}/complete")
        again = self.client.get(f"/api/tasks/{task['id']}").get_json()

        self.assertEqual("done", again["status"])
        self.assertIsNotNone(again["completed_at"])

    def test_completing_a_finished_task_changes_nothing(self):
        task = self.make_task("Pay the rent")

        first = self.client.post(f"/api/tasks/{task['id']}/complete")
        second = self.client.post(f"/api/tasks/{task['id']}/complete")

        self.assertEqual(200, second.status_code)
        self.assertEqual(first.get_json(), second.get_json())

    def test_an_unknown_id_is_a_404_and_creates_nothing(self):
        response = self.client.post("/api/tasks/404/complete")

        self.assertEqual(404, response.status_code)
        self.assertEqual("task_not_found", response.get_json()["error"]["code"])
        self.assertEqual(404, self.client.get("/api/tasks/404").status_code)


class FilteringAList(ApiCase):
    """US-3: the three filters, and the order the list comes back in."""

    def test_status_open_leaves_out_the_finished_tasks(self):
        home = self.make_list("Home")
        kept = self.make_task("Pay the rent", list_id=home["id"])
        finished = self.make_task("Water the plants", list_id=home["id"])
        self.client.post(f"/api/tasks/{finished['id']}/complete")

        found = self.tasks_in(home["id"], "?status=open")

        self.assertEqual([kept["id"]], [task["id"] for task in found])

    def test_a_status_the_contract_does_not_know_is_a_400(self):
        home = self.make_list("Home")

        response = self.client.get(f"/api/lists/{home['id']}/tasks?status=bogus")

        self.assertEqual(400, response.status_code)
        self.assertEqual("invalid_status", response.get_json()["error"]["code"])

    def test_the_keyword_matches_a_substring_whatever_the_case(self):
        home = self.make_list("Home")
        self.make_task("Pay The RENT", list_id=home["id"])
        self.make_task("Water the plants", list_id=home["id"])

        found = self.tasks_in(home["id"], "?q=he%20REN")

        self.assertEqual(["Pay The RENT"], [task["title"] for task in found])

    def test_the_tag_filter_narrows_the_list(self):
        home = self.make_list("Home")
        self.make_task("Pay the rent", list_id=home["id"], tags=["money"])
        self.make_task("Water the plants", list_id=home["id"], tags=["garden"])

        found = self.tasks_in(home["id"], "?tag=money")

        self.assertEqual(["Pay the rent"], [task["title"] for task in found])

    def test_two_filters_narrow_together(self):
        home = self.make_list("Home")
        self.make_task("Pay the rent", list_id=home["id"], tags=["money"])
        finished = self.make_task("Pay the tax", list_id=home["id"], tags=["money"])
        self.client.post(f"/api/tasks/{finished['id']}/complete")

        found = self.tasks_in(home["id"], "?q=pay&status=open")

        self.assertEqual(["Pay the rent"], [task["title"] for task in found])

    def test_the_order_is_high_then_medium_then_low_and_ties_go_by_id(self):
        home = self.make_list("Home")
        low = self.make_task("Water the plants", list_id=home["id"], priority="low")
        first_high = self.make_task("Pay the rent", list_id=home["id"], priority="high")
        middle = self.make_task("Book the dentist", list_id=home["id"], priority="medium")
        second_high = self.make_task("Renew the passport", list_id=home["id"], priority="high")

        found = self.tasks_in(home["id"])

        self.assertEqual(
            [first_high["id"], second_high["id"], middle["id"], low["id"]],
            [task["id"] for task in found],
        )


class TheOverdueReport(ApiCase):
    """US-4: the boundary, the two exclusions, and the order."""

    def test_a_task_due_today_is_not_overdue_yet(self):
        self.make_task("Pay the rent", due_date="2026-03-02")

        found = self.client.get("/api/tasks/overdue?today=2026-03-02").get_json()

        self.assertEqual([], found)

    def test_a_task_with_no_due_date_is_never_overdue(self):
        self.make_task("Water the plants")

        found = self.client.get("/api/tasks/overdue?today=2026-03-02").get_json()

        self.assertEqual([], found)

    def test_a_finished_task_is_not_overdue_however_late_it_was(self):
        late = self.make_task("Pay the rent", due_date="2026-03-01")
        self.client.post(f"/api/tasks/{late['id']}/complete")

        found = self.client.get("/api/tasks/overdue?today=2026-03-20").get_json()

        self.assertEqual([], found)

    def test_the_worst_comes_first(self):
        recent = self.make_task("Pay the rent", due_date="2026-03-04")
        oldest = self.make_task("Renew the passport", due_date="2026-02-20")
        middle = self.make_task("Book the dentist", due_date="2026-03-01")

        found = self.client.get("/api/tasks/overdue?today=2026-03-05").get_json()

        self.assertEqual(
            [oldest["id"], middle["id"], recent["id"]],
            [task["id"] for task in found],
        )
