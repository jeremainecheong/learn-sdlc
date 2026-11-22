# Shelf

A small library you can run: a Flask API (`api/`) that keeps books in memory,
and a React page (`web/src/ShelfPage.ts`) that shows them in shelf order.

    python3 api/main.py              # serve on $PORT (8000 by default)
    python3 api/main.py --selfcheck  # check a deployment without serving
