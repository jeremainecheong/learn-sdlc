"""The acceptance suite this pack would hand in.

One case per acceptance criterion of US-2, US-3 and US-4, written against the
HTTP contract in shared/contract/api.json rather than against the code, and
sharp enough to fail on every bug planted in ../mutants. It is the pack's own
proof that the kill matrix can be completed: a mutant that survives this suite
is a bug in the pack, not in the learner.

Two habits do most of the work here, and both are worth stealing:

* assert the **stored** state, not only the response. A handler can answer
  "done" and write nothing, and only a second request can tell you.
* build every date from ``today()``, never from a date typed into the file.
  ``today()`` reads the run clock, so this suite gives the same verdict
  tomorrow as it does now.
"""

from datetime import timedelta

import pytest

from tests.clock import today


@pytest.fixture
def home(make_list):
    """One list to hang the tasks on."""
    return make_list("Home")


def add(client, list_id, title, **fields):
    """Post a task and return it, so a test reads as arrange then act."""
    payload = {"title": title}
    payload.update(fields)
    return client.post(f"/api/lists/{list_id}/tasks", json=payload).get_json()


def day(offset):
    """An ISO date ``offset`` days from the day this run is happening on."""
    return (today() + timedelta(days=offset)).isoformat()


def overdue(client, on=None):
    """The overdue report as of a day, defaulting to today."""
    return client.get("/api/tasks/overdue", query_string={"today": on or day(0)})


def titles(response):
    """The titles a list response came back with, in the order it gave them."""
    return [task["title"] for task in response.get_json()]


# --------------------------------------------------------- US-2, complete --


def test_completing_a_task_answers_with_it_finished(client, home):
    task = add(client, home["id"], "Pay the rent")

    response = client.post(f"/api/tasks/{task['id']}/complete")

    assert response.status_code == 200
    finished = response.get_json()
    assert finished["status"] == "done"
    assert finished["completed_at"] is not None


def test_the_completion_is_still_there_on_the_next_request(client, home):
    """US-2/AC-1: completed means stored, not merely answered."""
    task = add(client, home["id"], "Pay the rent")
    client.post(f"/api/tasks/{task['id']}/complete")

    again = client.get(f"/api/tasks/{task['id']}").get_json()

    assert again["status"] == "done"
    assert again["completed_at"] is not None


def test_completing_a_finished_task_changes_nothing(client, home):
    task = add(client, home["id"], "Pay the rent")
    first = client.post(f"/api/tasks/{task['id']}/complete").get_json()

    second = client.post(f"/api/tasks/{task['id']}/complete")

    assert second.status_code == 200
    assert second.get_json()["completed_at"] == first["completed_at"]


def test_completing_a_task_that_does_not_exist_is_a_404(client):
    """US-2/AC-2: the missing id is refused, and refused under its own code."""
    response = client.post("/api/tasks/99999/complete")

    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"


# ------------------------------------------- US-3, list, filter and order --


def test_filtering_by_status_leaves_out_the_finished_tasks(client, home):
    open_task = add(client, home["id"], "Book the dentist")
    done_task = add(client, home["id"], "Post the letter")
    client.post(f"/api/tasks/{done_task['id']}/complete")

    response = client.get(f"/api/lists/{home['id']}/tasks", query_string={"status": "open"})

    assert response.status_code == 200
    assert [task["id"] for task in response.get_json()] == [open_task["id"]]


def test_a_keyword_matches_whatever_the_case(client, home):
    """US-3/AC-2: searching for "rent" finds "Pay Rent"."""
    add(client, home["id"], "Pay Rent")
    add(client, home["id"], "Review notes")

    response = client.get(f"/api/lists/{home['id']}/tasks", query_string={"q": "rent"})

    assert titles(response) == ["Pay Rent"]


def test_a_keyword_matches_inside_the_title_not_only_at_the_start(client, home):
    add(client, home["id"], "Renew the passport")

    response = client.get(f"/api/lists/{home['id']}/tasks", query_string={"q": "passport"})

    assert titles(response) == ["Renew the passport"]


def test_tasks_come_back_highest_priority_first(client, home):
    """US-3/AC-4: high before medium before low, ties by id."""
    low = add(client, home["id"], "Water the plants", priority="low")
    high = add(client, home["id"], "File the tax return", priority="high")
    medium_first = add(client, home["id"], "Answer the letter", priority="medium")
    medium_second = add(client, home["id"], "Book the dentist", priority="medium")

    response = client.get(f"/api/lists/{home['id']}/tasks")

    assert [task["id"] for task in response.get_json()] == [
        high["id"],
        medium_first["id"],
        medium_second["id"],
        low["id"],
    ]


def test_a_status_the_contract_does_not_know_is_refused(client, home):
    response = client.get(f"/api/lists/{home['id']}/tasks", query_string={"status": "urgent"})

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_status"


# ------------------------------------------------- US-4, the overdue report --


def test_a_task_due_before_today_is_overdue(client, home):
    late = add(client, home["id"], "Send the invoice", due_date=day(-3))

    response = overdue(client)

    assert response.status_code == 200
    assert [task["id"] for task in response.get_json()] == [late["id"]]


def test_a_task_due_today_is_not_overdue_yet(client, home):
    """US-4/AC-2: the boundary is strict — today is not late."""
    add(client, home["id"], "Call the bank", due_date=day(0))

    assert overdue(client).get_json() == []


def test_a_task_with_no_due_date_is_never_overdue(client, home):
    add(client, home["id"], "Someday, learn the piano")

    assert overdue(client).get_json() == []


def test_a_task_finished_late_is_not_reported_as_overdue(client, home):
    """US-4/AC-3: the report is what is still owed, not what was ever late."""
    late = add(client, home["id"], "Send the invoice", due_date=day(-3))
    client.post(f"/api/tasks/{late['id']}/complete")

    assert overdue(client).get_json() == []


def test_the_report_puts_the_most_overdue_first(client, home):
    older = add(client, home["id"], "Renew the passport", due_date=day(-9))
    newer = add(client, home["id"], "Send the invoice", due_date=day(-1))

    assert [task["id"] for task in overdue(client).get_json()] == [older["id"], newer["id"]]


def test_the_report_refuses_a_day_it_cannot_read(client):
    response = client.get("/api/tasks/overdue", query_string={"today": "last tuesday"})

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_date"
