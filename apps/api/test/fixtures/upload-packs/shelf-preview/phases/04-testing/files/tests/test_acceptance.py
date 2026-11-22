"""Your acceptance suite for the shelf API.

Cover the acceptance criteria of SH-1 (shelf order and the author filter), SH-2
(lending) and SH-3 (returning). Write them against the HTTP contract, not the
code: a test that mirrors the implementation passes whatever the
implementation does.

Everything you need is already here.

* `client` is Flask's test client, wired to a fresh, empty shelf for every
  test. `client.post("/api/books/3/lend", json={"borrower": "Ade"})` is the
  request a browser would make, minus the socket.
* `add_book` puts a book on the shelf through the API and returns it.

The graders run your suite against secretly broken copies of the API, and a
suite that only checks the status code will not notice most of them.
"""
