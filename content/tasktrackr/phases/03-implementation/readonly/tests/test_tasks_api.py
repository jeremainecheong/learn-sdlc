"""The four cases you can see, one for each rule you are implementing.

They run through Flask's own test client, so each one reads like the request
it stands for. Press Run visible tests as often as you like: this file is the
fast loop, and it is the same suite the grader runs for the visible_tests
criterion. The hidden suite asks the same three contracts a lot more questions.

The fixtures — client, make_list, make_task — are in tests/conftest.py, which
you can open and read.
"""


def test_completing_a_task_marks_it_done(client, make_task):
    """US-2: the route answers 200 with the finished task."""
    task = make_task("Pay the rent")

    response = client.post(f"/api/tasks/{task['id']}/complete")

    assert response.status_code == 200
    completed = response.get_json()
    assert completed["status"] == "done"
    assert completed["completed_at"] is not None


def test_completing_a_task_nobody_has_is_a_404(client):
    """US-2: an unknown id is refused under the code the contract publishes."""
    response = client.post("/api/tasks/404/complete")

    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "task_not_found"


def test_status_open_leaves_out_the_finished_tasks(client, make_list, make_task):
    """US-3: the status filter narrows the list the route returns."""
    home = make_list("Home")
    kept = make_task("Pay the rent", list_id=home["id"])
    finished = make_task("Water the plants", list_id=home["id"])
    client.post(f"/api/tasks/{finished['id']}/complete")

    found = client.get(f"/api/lists/{home['id']}/tasks?status=open").get_json()

    assert [task["id"] for task in found] == [kept["id"]]


def test_a_task_due_before_today_is_in_the_overdue_report(client, make_task):
    """US-4: the report is open tasks whose due date is behind the day asked for."""
    late = make_task("Renew the passport", due_date="2026-03-01")
    make_task("Book the dentist", due_date="2026-03-20")

    found = client.get("/api/tasks/overdue?today=2026-03-05").get_json()

    assert [task["id"] for task in found] == [late["id"]]
