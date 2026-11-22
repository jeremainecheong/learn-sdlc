"""The task endpoints: making them, changing them, filtering them, and the
overdue report every later phase is built on.
"""

import pytest


@pytest.fixture
def home(make_list):
    return make_list("Home")


def add(client, list_id, title, **fields):
    """Post a task and return it."""
    payload = {"title": title}
    payload.update(fields)
    return client.post(f"/api/lists/{list_id}/tasks", json=payload).get_json()


# ------------------------------------------------------------- making them --


def test_a_new_task_starts_open_with_no_tags_and_no_comments(client, home):
    response = client.post(f"/api/lists/{home['id']}/tasks", json={"title": "Pay the rent"})
    assert response.status_code == 201
    created = response.get_json()
    assert created["title"] == "Pay the rent"
    assert created["priority"] == "medium"
    assert created["status"] == "open"
    assert created["due_date"] is None
    assert created["completed_at"] is None
    assert created["tags"] == []
    assert created["comment_count"] == 0


def test_a_task_keeps_its_priority_due_date_and_tags(client, home):
    created = add(
        client,
        home["id"],
        "Renew the passport",
        priority="high",
        due_date="2026-03-01",
        tags=["errand", "admin"],
    )
    assert created["priority"] == "high"
    assert created["due_date"] == "2026-03-01"
    assert created["tags"] == ["admin", "errand"]


def test_a_task_needs_a_title(client, home):
    response = client.post(f"/api/lists/{home['id']}/tasks", json={"title": "   "})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_title"


def test_a_task_priority_must_be_one_of_three(client, home):
    response = client.post(
        f"/api/lists/{home['id']}/tasks", json={"title": "Pay", "priority": "urgent"}
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_priority"


def test_a_due_date_must_be_an_iso_date(client, home):
    response = client.post(
        f"/api/lists/{home['id']}/tasks", json={"title": "Pay", "due_date": "next tuesday"}
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_due_date"


def test_a_task_on_an_unknown_list_is_a_404(client):
    response = client.post("/api/lists/404/tasks", json={"title": "Pay"})
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "list_not_found"


# ------------------------------------------------------------ reading them --


def test_one_task_can_be_read_back(client, home):
    created = add(client, home["id"], "Pay the rent")
    response = client.get(f"/api/tasks/{created['id']}")
    assert response.status_code == 200
    assert response.get_json()["title"] == "Pay the rent"


def test_an_unknown_task_is_a_404(client):
    response = client.get("/api/tasks/404")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"


# ----------------------------------------------------------- changing them --


def test_a_patch_changes_only_what_it_names(client, home):
    created = add(client, home["id"], "Pay the rent", priority="low")
    response = client.patch(f"/api/tasks/{created['id']}", json={"priority": "high"})
    assert response.status_code == 200
    changed = response.get_json()
    assert changed["priority"] == "high"
    assert changed["title"] == "Pay the rent"


def test_a_patch_to_done_records_when_it_was_finished(client, home):
    created = add(client, home["id"], "Pay the rent")
    changed = client.patch(f"/api/tasks/{created['id']}", json={"status": "done"}).get_json()
    assert changed["status"] == "done"
    assert changed["completed_at"] is not None


def test_a_patch_refuses_a_status_the_schema_would_not_hold(client, home):
    created = add(client, home["id"], "Pay the rent")
    response = client.patch(f"/api/tasks/{created['id']}", json={"status": "maybe"})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_status"


def test_completing_a_task_really_changes_the_row(client, home):
    created = add(client, home["id"], "Pay the rent")
    response = client.post(f"/api/tasks/{created['id']}/complete")
    assert response.status_code == 200
    assert response.get_json()["status"] == "done"

    again = client.get(f"/api/tasks/{created['id']}").get_json()
    assert again["status"] == "done"
    assert again["completed_at"] is not None


def test_completing_a_finished_task_changes_nothing(client, home):
    created = add(client, home["id"], "Pay the rent")
    first = client.post(f"/api/tasks/{created['id']}/complete").get_json()
    second = client.post(f"/api/tasks/{created['id']}/complete").get_json()
    assert second == first


def test_completing_an_unknown_task_is_a_404(client):
    response = client.post("/api/tasks/404/complete")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"


def test_reopening_a_task_forgets_when_it_was_finished(client, home):
    created = add(client, home["id"], "Pay the rent")
    client.post(f"/api/tasks/{created['id']}/complete")
    reopened = client.post(f"/api/tasks/{created['id']}/reopen").get_json()
    assert reopened["status"] == "open"
    assert reopened["completed_at"] is None


def test_a_deleted_task_is_gone(client, home):
    created = add(client, home["id"], "Pay the rent")
    assert client.delete(f"/api/tasks/{created['id']}").status_code == 204
    assert client.get(f"/api/tasks/{created['id']}").status_code == 404


def test_deleting_an_unknown_task_is_a_404(client):
    response = client.delete("/api/tasks/404")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"


# ---------------------------------------------------------- filtering them --


def test_status_narrows_the_list(client, home):
    kept = add(client, home["id"], "Pay the rent")
    finished = add(client, home["id"], "Water the plants")
    client.post(f"/api/tasks/{finished['id']}/complete")

    open_only = client.get(f"/api/lists/{home['id']}/tasks?status=open").get_json()
    done_only = client.get(f"/api/lists/{home['id']}/tasks?status=done").get_json()
    assert [task["id"] for task in open_only] == [kept["id"]]
    assert [task["id"] for task in done_only] == [finished["id"]]


def test_an_unknown_status_is_refused(client, home):
    response = client.get(f"/api/lists/{home['id']}/tasks?status=bogus")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_status"


def test_the_keyword_matches_a_substring_whatever_the_case(client, home):
    add(client, home["id"], "Pay Rent")
    add(client, home["id"], "Water the plants")
    found = client.get(f"/api/lists/{home['id']}/tasks?q=rent").get_json()
    assert [task["title"] for task in found] == ["Pay Rent"]


def test_the_tag_filter_narrows_the_list(client, home):
    add(client, home["id"], "Pay the rent", tags=["money"])
    add(client, home["id"], "Water the plants", tags=["garden"])
    found = client.get(f"/api/lists/{home['id']}/tasks?tag=money").get_json()
    assert [task["title"] for task in found] == ["Pay the rent"]


def test_two_filters_narrow_together(client, home):
    add(client, home["id"], "Pay the rent", tags=["money"])
    finished = add(client, home["id"], "Pay the tax", tags=["money"])
    client.post(f"/api/tasks/{finished['id']}/complete")
    found = client.get(f"/api/lists/{home['id']}/tasks?q=pay&status=open").get_json()
    assert [task["title"] for task in found] == ["Pay the rent"]


def test_tasks_come_back_highest_priority_first_then_by_id(client, home):
    low = add(client, home["id"], "Water the plants", priority="low")
    high_one = add(client, home["id"], "Pay the rent", priority="high")
    middle = add(client, home["id"], "Book the dentist", priority="medium")
    high_two = add(client, home["id"], "Renew the passport", priority="high")

    order = [task["id"] for task in client.get(f"/api/lists/{home['id']}/tasks").get_json()]
    assert order == [high_one["id"], high_two["id"], middle["id"], low["id"]]


# ------------------------------------------------------------- the report ---


def test_the_overdue_report_takes_the_day_as_an_argument(client):
    response = client.get("/api/tasks/overdue")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_date"


def test_the_overdue_report_refuses_a_day_it_cannot_read(client):
    response = client.get("/api/tasks/overdue?today=yesterday")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_date"


def test_a_task_due_before_today_is_overdue(client, home):
    late = add(client, home["id"], "Pay the rent", due_date="2026-03-01")
    found = client.get("/api/tasks/overdue?today=2026-03-02").get_json()
    assert [task["id"] for task in found] == [late["id"]]


def test_a_task_due_today_is_not_overdue_yet(client, home):
    add(client, home["id"], "Pay the rent", due_date="2026-03-02")
    assert client.get("/api/tasks/overdue?today=2026-03-02").get_json() == []


def test_a_task_with_no_due_date_is_never_overdue(client, home):
    add(client, home["id"], "Water the plants")
    assert client.get("/api/tasks/overdue?today=2026-03-02").get_json() == []


def test_a_finished_task_is_not_overdue_however_late_it_was(client, home):
    late = add(client, home["id"], "Pay the rent", due_date="2026-03-01")
    client.post(f"/api/tasks/{late['id']}/complete")
    assert client.get("/api/tasks/overdue?today=2026-03-05").get_json() == []


def test_the_overdue_report_puts_the_worst_first(client, home):
    recent = add(client, home["id"], "Pay the rent", due_date="2026-03-04")
    oldest = add(client, home["id"], "Renew the passport", due_date="2026-02-20")
    middle = add(client, home["id"], "Book the dentist", due_date="2026-03-01")

    found = client.get("/api/tasks/overdue?today=2026-03-05").get_json()
    assert [task["id"] for task in found] == [oldest["id"], middle["id"], recent["id"]]


def test_the_overdue_report_reaches_across_lists(client, make_list):
    home = make_list("Home")
    work = make_list("Work")
    at_home = add(client, home["id"], "Pay the rent", due_date="2026-03-01")
    at_work = add(client, work["id"], "Write the notes", due_date="2026-03-01")

    found = client.get("/api/tasks/overdue?today=2026-03-05").get_json()
    assert {task["id"] for task in found} == {at_home["id"], at_work["id"]}
