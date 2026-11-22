"""The sealed API suite for change request CHG-1, plus the regression it must keep.

seal marker: SHELF-SEALED-HIDDEN-5F3K

unittest, and no conftest: the suite builds its own application per case.
"""

import unittest

from api.main import create_app


class ShelfCase(unittest.TestCase):
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


class ShelvedBySurname(ShelfCase):
    """CHG-1: surname, then title, then id."""

    def test_surname_decides_before_title(self):
        self.add("Beloved", "Toni Morrison")
        self.add("Kindred", "Octavia E. Butler")
        self.add("Emma", "Jane Austen")
        self.assertEqual(self.titles(), ["Emma", "Kindred", "Beloved"])

    def test_surname_ignores_case(self):
        self.add("Zami", "audre lorde")
        self.add("Ariel", "Sylvia Plath")
        self.add("Citizen", "Claudia Rankine")
        self.assertEqual(self.titles(), ["Zami", "Ariel", "Citizen"])

    def test_one_author_is_shelved_by_title(self):
        self.add("Persuasion", "Jane Austen")
        self.add("emma", "Jane Austen")
        self.assertEqual(self.titles(), ["emma", "Persuasion"])

    def test_the_author_filter_keeps_the_new_order(self):
        self.add("Persuasion", "Jane Austen")
        self.add("Emma", "Jane Austen")
        self.add("Middlemarch", "George Eliot")
        self.assertEqual(self.titles("?author=jane%20austen"), ["Emma", "Persuasion"])


class StillWorks(ShelfCase):
    """The regression half: lending and returning are unchanged."""

    def test_lend_and_return(self):
        book = self.add("Emma", "Jane Austen")
        lent = self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})
        self.assertEqual(lent.get_json()["on_loan_to"], "Ade")
        again = self.client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Bo"})
        self.assertEqual(again.status_code, 409)
        back = self.client.post(f"/api/books/{book['id']}/return")
        self.assertIsNone(back.get_json()["on_loan_to"])


if __name__ == "__main__":
    unittest.main()
