"""The sealed API suite for the implementation phase (SH-1, SH-2).

seal marker: SHELF-SEALED-HIDDEN-5F3K

unittest rather than pytest: the graded artefacts stay on the harness whose
seal has been proved, so this suite builds its own application per case and
reads nothing from tests/conftest.py.
"""

import unittest

from api.main import create_app


class ShelfCase(unittest.TestCase):
    """One fresh application, and therefore one empty shelf, per case."""

    def setUp(self):
        app = create_app()
        app.config["TESTING"] = True
        self.client = app.test_client()

    def add(self, title, author, year=None):
        response = self.client.post("/api/books", json={"title": title, "author": author, "year": year})
        self.assertEqual(response.status_code, 201)
        return response.get_json()

    def titles(self, query=""):
        return [book["title"] for book in self.client.get(f"/api/books{query}").get_json()]


class ListingTheShelf(ShelfCase):
    """SH-1: shelf order and the author filter."""

    def test_an_empty_shelf_is_an_empty_list(self):
        self.assertEqual(self.client.get("/api/books").get_json(), [])

    def test_order_is_by_title_ignoring_case(self):
        self.add("persuasion", "Jane Austen")
        self.add("Emma", "Jane Austen")
        self.add("Middlemarch", "George Eliot")
        self.assertEqual(self.titles(), ["Emma", "Middlemarch", "persuasion"])

    def test_two_copies_of_one_title_keep_the_order_they_arrived_in(self):
        first = self.add("Beloved", "Toni Morrison")
        second = self.add("Beloved", "Toni Morrison")
        ids = [book["id"] for book in self.client.get("/api/books").get_json()]
        self.assertEqual(ids, [first["id"], second["id"]])

    def test_the_author_filter_ignores_case_and_spaces(self):
        self.add("Emma", "Jane Austen")
        self.add("Middlemarch", "George Eliot")
        self.assertEqual(self.titles("?author=%20jane%20AUSTEN%20"), ["Emma"])

    def test_a_blank_author_is_no_filter(self):
        self.add("Emma", "Jane Austen")
        self.add("Middlemarch", "George Eliot")
        self.assertEqual(self.titles("?author=%20"), ["Emma", "Middlemarch"])

    def test_an_author_nobody_wrote_is_an_empty_list(self):
        self.add("Emma", "Jane Austen")
        self.assertEqual(self.titles("?author=Nobody"), [])


class LendingABook(ShelfCase):
    """SH-2: lending, and what a lend refuses."""

    def test_a_lent_book_says_who_has_it(self):
        book = self.add("Emma", "Jane Austen")
        response = self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "  Ade "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["on_loan_to"], "Ade")
        self.assertEqual(self.client.get(f"/api/books/{book['id']}").get_json()["on_loan_to"], "Ade")

    def test_an_unknown_book_is_a_404(self):
        response = self.client.post("/api/books/99/lend", json={"borrower": "Ade"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"]["code"], "book_not_found")

    def test_a_blank_borrower_is_refused(self):
        book = self.add("Emma", "Jane Austen")
        response = self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "   "})
        self.assertEqual(response.status_code, 409)
        self.assertIsNone(self.client.get(f"/api/books/{book['id']}").get_json()["on_loan_to"])

    def test_a_book_on_loan_cannot_be_lent_again(self):
        book = self.add("Emma", "Jane Austen")
        self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})
        response = self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Bo"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.get(f"/api/books/{book['id']}").get_json()["on_loan_to"], "Ade")

    def test_a_returned_book_can_be_lent_again(self):
        book = self.add("Emma", "Jane Austen")
        self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})
        self.client.post(f"/api/books/{book['id']}/return")
        response = self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Bo"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["on_loan_to"], "Bo")


if __name__ == "__main__":
    unittest.main()
