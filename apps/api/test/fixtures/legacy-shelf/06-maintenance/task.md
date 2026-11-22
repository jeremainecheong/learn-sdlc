# Maintenance: change request CHG-1

The library has asked for the shelf to follow the order a librarian shelves
in: by the author's surname, then by title, then by id. Change both layers
(`api/shelf.py` and `web/src/lib/shelf.ts`) without breaking anything the
shelf already did.

## What good looks like

- The API and the page agree on the new order.
- Lending, returning and the author filter behave exactly as before.
- The visible regression cases pass before you submit.

## Using the AI mentor well

Ask the mentor which existing behaviour your change could break, then run the
regression cases to find out.
