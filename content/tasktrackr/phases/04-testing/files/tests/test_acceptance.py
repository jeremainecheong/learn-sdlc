"""Your acceptance suite for TaskTrackr.

Cover the acceptance criteria of US-2 (complete a task), US-3 (list, filter and
order) and US-4 (the overdue report) — the three stories the API already
answers. Write them against the HTTP contract in shared/contract/api.json, not
against the code: a test that mirrors the implementation passes whatever the
implementation does.

Everything you need is already here.

* `client` is Flask's test client, wired to a fresh in-memory database for
  every test. `client.post("/api/tasks/3/complete")` is the request a browser
  would make, minus the socket.
* `make_list` and `make_task` build a starting state through the API.
* `today()` reads the run clock. Pin a date in the Run clock control and every
  date below moves with it, which is why the suite gives the same verdict
  tomorrow as it does now. Never type a date into this file, and never call
  `date.today()`.

Three tests is the floor, not the target. The graders run your suite against
secretly broken copies of the API, and a suite that only reads the response
body will not notice most of them.
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
    """An ISO date `offset` days from the day this run is happening on."""
    return (today() + timedelta(days=offset)).isoformat()


# ----------------------------------------------------- the worked example --


def test_a_new_task_starts_open_with_the_contract_defaults(client, home):
    """US-1, worked for you: arrange, act, then assert one thing you can see."""
    created = add(client, home["id"], "Write the report")

    assert created["status"] == "open"
    assert created["priority"] == "medium"
    assert created["tags"] == []


# TODO(learner): US-2 — completing a task. Two criteria, and the second one is
#                the one suites forget: an id no task has must be refused, with
#                the status code and the error code the contract names.
#                Ask yourself what proves a task is really finished. The answer
#                the endpoint gives you, or the answer the next request gives?


# TODO(learner): US-3 — listing, filtering and ordering. Test one axis at a
#                time before you combine them: status, then keyword, then the
#                order the contract promises. "Pay Rent" and a search for
#                "rent" is one line, and it is the line that catches a whole
#                class of bug.


# TODO(learner): US-4 — the overdue report. Three dates decide this rule:
#                clearly before today, exactly today, and after today. Build
#                each of them with day(-3), day(0) and day(2). Two more tasks
#                belong in this section and neither belongs on the report: one
#                with no due date, and one that was finished late.
