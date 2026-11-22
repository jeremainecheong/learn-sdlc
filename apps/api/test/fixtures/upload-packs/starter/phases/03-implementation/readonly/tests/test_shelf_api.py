"""The cases you can see, one for each rule you are implementing.

They run through Flask's own test client (the fixtures are in
tests/conftest.py, which you can open). Press Run visible tests as often as you
like; the hidden suite asks the same rules many more questions.
"""


def test_books_come_back_in_title_order(client, add_book):
    """SH-1: the shelf lists books by title, whatever order they arrived in."""
    add_book(title="Station Eleven", author="Emily St. John Mandel", year=2014)
    add_book(title="Kindred", author="Octavia E. Butler", year=1979)

    titles = [book["title"] for book in client.get("/api/books").get_json()]

    assert titles == ["Kindred", "Station Eleven"]


def test_lending_a_book_records_the_borrower(client, add_book):
    """SH-2: a lent book says who has it."""
    book = add_book()

    response = client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})

    assert response.status_code == 200
    assert response.get_json()["on_loan_to"] == "Ade"


def test_a_book_cannot_be_lent_twice(client, add_book):
    """SH-2: a book is in one place at a time."""
    book = add_book()
    client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})

    response = client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Bo"})

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "cannot_lend"
