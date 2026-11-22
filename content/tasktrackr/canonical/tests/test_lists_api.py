"""The list endpoints, and the one route that proves the app came up."""


def test_health_reports_the_version(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "version": "2.0.0"}


def test_lists_start_empty(client):
    response = client.get("/api/lists")
    assert response.status_code == 200
    assert response.get_json() == []


def test_a_new_list_comes_back_with_its_counts(client):
    response = client.post("/api/lists", json={"name": "Home"})
    assert response.status_code == 201
    created = response.get_json()
    assert created["name"] == "Home"
    assert created["task_count"] == 0
    assert created["open_count"] == 0
    assert created["created_at"]


def test_a_list_without_a_name_is_refused(client):
    response = client.post("/api/lists", json={"name": "  "})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_name"


def test_a_missing_body_is_refused_the_same_way(client):
    response = client.post("/api/lists")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_name"


def test_two_lists_cannot_share_a_name(client):
    client.post("/api/lists", json={"name": "Home"})
    response = client.post("/api/lists", json={"name": "Home"})
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "duplicate_list"


def test_the_counts_follow_the_tasks(client, make_list, make_task):
    home = make_list("Home")
    make_task("Pay the rent", list_id=home["id"])
    done = make_task("Water the plants", list_id=home["id"])
    client.post(f"/api/tasks/{done['id']}/complete")

    only = client.get("/api/lists").get_json()[0]
    assert only["task_count"] == 2
    assert only["open_count"] == 1


def test_lists_come_back_in_the_order_they_were_made(client):
    for name in ("Home", "Work", "Reading"):
        client.post("/api/lists", json={"name": name})
    assert [row["name"] for row in client.get("/api/lists").get_json()] == [
        "Home",
        "Work",
        "Reading",
    ]


def test_tasks_of_an_unknown_list_are_a_404(client):
    response = client.get("/api/lists/404/tasks")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "list_not_found"


def test_an_address_no_route_claims_answers_in_json(client):
    response = client.get("/api/nothing-here")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "not_found"
