"""The acceptance suite this pack would hand in for the API.

seal marker: SHELF-SEALED-REFERENCE-4T7W

One case per acceptance criterion of SH-1, SH-2 and SH-3, written against the
HTTP contract rather than the code. It is the pack's own proof that the planted
API bugs can be caught.
"""


def test_the_author_filter_ignores_case(client, add_book):
    """SH-1/AC-2: an author typed in any case finds that author's books."""
    add_book(title="Emma", author="Jane Austen", year=1815)
    add_book(title="Middlemarch", author="George Eliot", year=1871)

    found = client.get("/api/books?author=jane austen").get_json()

    assert [book["title"] for book in found] == ["Emma"]


def test_books_are_listed_by_title(client, add_book):
    """SH-1/AC-1: shelf order is title order."""
    add_book(title="Persuasion", author="Jane Austen", year=1817)
    add_book(title="Emma", author="Jane Austen", year=1815)

    found = client.get("/api/books").get_json()

    assert [book["title"] for book in found] == ["Emma", "Persuasion"]


def test_lend_records_the_borrower(client, add_book):
    """SH-2/AC-1: a lent book says who has it."""
    book = add_book()

    response = client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})

    assert response.status_code == 200
    assert response.get_json()["on_loan_to"] == "Ade"


def test_lend_twice_is_refused(client, add_book):
    """SH-2/AC-2: a book already on loan cannot be lent again."""
    book = add_book()
    client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})

    response = client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Bo"})

    assert response.status_code == 409
    assert client.get(f"/api/books/{book['id']}").get_json()["on_loan_to"] == "Ade"


def test_return_puts_the_book_back(client, add_book):
    """SH-3/AC-1: a returned book is on the shelf again."""
    book = add_book()
    client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})

    response = client.post(f"/api/books/{book['id']}/return")

    assert response.status_code == 200
    assert response.get_json()["on_loan_to"] is None


def test_return_of_an_unknown_book_is_a_404(client):
    """SH-3/AC-2: returning a book nobody has is refused under its own code."""
    response = client.post("/api/books/404/return")

    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "book_not_found"
