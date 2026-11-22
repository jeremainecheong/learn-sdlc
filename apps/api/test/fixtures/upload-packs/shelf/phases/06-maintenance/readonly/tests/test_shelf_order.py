"""The regression cases you can see for change request CHG-1.

CHG-1 moves the shelf from title order to the order a librarian shelves in:
by the author's surname, then by title. Everything else the shelf did before
must still work, so the lending case below is here on purpose.
"""


def test_books_are_shelved_by_surname(client, add_book):
    """CHG-1: the author's surname decides the order, not the title."""
    add_book(title="Beloved", author="Toni Morrison", year=1987)
    add_book(title="Kindred", author="Octavia E. Butler", year=1979)

    titles = [book["title"] for book in client.get("/api/books").get_json()]

    assert titles == ["Kindred", "Beloved"]


def test_lending_still_works(client, add_book):
    """SH-2, kept: a lent book still says who has it."""
    book = add_book()

    response = client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})

    assert response.status_code == 200
    assert response.get_json()["on_loan_to"] == "Ade"
