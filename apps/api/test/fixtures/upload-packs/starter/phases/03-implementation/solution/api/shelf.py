"""The shelf: every book the library owns, kept in memory.

A book is a dict with five keys: id, title, author, year (an int or None) and
on_loan_to (the borrower's name, or None while the book is on the shelf).
Every method hands back copies, so a caller can never edit the shelf by
editing what it was given.
"""

# seal marker: SHELF-SEALED-SOLUTION-8M2Q (the implementation phase's reference answer)


def _year_is_valid(year):
    """A year is optional; when one is given it is a four-digit whole number."""
    if year is None:
        return True
    if isinstance(year, bool) or not isinstance(year, int):
        return False
    return 1000 <= year <= 2999


class Shelf:
    """The books, by id, and the id the next book will get."""

    def __init__(self):
        self._books = {}
        self._next_id = 1

    def add(self, title, author, year=None):
        """Put a new book on the shelf and return it.

        ValueError for a blank title or author, or a year that is not a
        four-digit number.
        """
        title = (title or "").strip()
        author = (author or "").strip()
        if not title:
            raise ValueError("a book needs a title")
        if not author:
            raise ValueError("a book needs an author")
        if not _year_is_valid(year):
            raise ValueError("year must be a four-digit number")
        book = {"id": self._next_id, "title": title, "author": author, "year": year, "on_loan_to": None}
        self._books[book["id"]] = book
        self._next_id += 1
        return dict(book)

    def get(self, book_id):
        """One book by id. KeyError when no book has it."""
        if book_id not in self._books:
            raise KeyError(book_id)
        return dict(self._books[book_id])

    def books(self, author=None):
        """Every book in shelf order: by title ignoring case, then by id.

        With an author, only that author's books, matched ignoring case and
        the spaces around the name. A blank author is no filter at all.
        """
        found = list(self._books.values())
        if author is not None and author.strip():
            wanted = author.strip().lower()
            found = [book for book in found if book["author"].lower() == wanted]
        found.sort(key=lambda book: (book["title"].lower(), book["id"]))
        return [dict(book) for book in found]

    def lend(self, book_id, borrower):
        """Lend a book to a borrower and return it.

        KeyError for an unknown id. ValueError for a blank borrower, or for a
        book that is already on loan: a book is in one place at a time.
        """
        if book_id not in self._books:
            raise KeyError(book_id)
        name = (borrower or "").strip()
        if not name:
            raise ValueError("a loan needs a borrower")
        book = self._books[book_id]
        if book["on_loan_to"] is not None:
            raise ValueError("that book is already on loan")
        book["on_loan_to"] = name
        return dict(book)

    def give_back(self, book_id):
        """Put a lent book back on the shelf and return it.

        KeyError for an unknown id; ValueError for a book that is not on loan.
        """
        if book_id not in self._books:
            raise KeyError(book_id)
        book = self._books[book_id]
        if book["on_loan_to"] is None:
            raise ValueError("that book is not on loan")
        book["on_loan_to"] = None
        return dict(book)
