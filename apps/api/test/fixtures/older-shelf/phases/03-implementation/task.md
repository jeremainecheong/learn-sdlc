# Implementation: fill the marked gaps

The shelf runs except for four marked gaps: two in the Python API
(`api/shelf.py`: `books` and `lend`) and two in the TypeScript page
(`web/src/lib/shelf.ts`: `shelfLabel` and `sortForShelf`). Make the backlog's
rules true in both layers.

## What good looks like

- `books` lists by title ignoring case, then id, and the author filter ignores
  case and surrounding spaces.
- `lend` refuses an unknown id, a blank borrower, and a book already on loan.
- `shelfLabel` and `sortForShelf` agree with the API about what a person reads.
- The visible tests pass before you submit; the hidden suites ask more.

## Using the AI mentor well

Paste the failing test's name, not your whole file, and ask what rule it is
checking. The mentor explains; it does not write the function for you.
