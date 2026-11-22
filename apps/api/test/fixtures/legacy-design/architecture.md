# TaskTrackr — Design (approved sections)

## The two services *(approved)*

```
                    one origin, so no CORS anywhere
                    ┌───────────────────────────────┐
┌─────────┐         │  web (node)          /api     │        ┌──────────────┐
│ browser │ ──────▶ │  web/serve.js  ──────────────────────▶ │ api (python) │
└─────────┘         │  serves web/dist/app.js       │        │ Flask        │
                    └───────────────────────────────┘        └──────┬───────┘
                                                                    │ sqlite3
                                                             ┌──────▼───────┐
                                                             │ tasktrackr.db│
                                                             └──────────────┘
```

**web** is `web/serve.js`, about eighty lines of `node:http`. It serves the built front end and
forwards anything under `/api` to the API, which is the whole reason there is no CORS in this
application: the browser only ever talks to one origin. `API_URL` is what tells the web service
where the API is, and in phase 5 it is the line that breaks the deployment.

**api** is Flask over `sqlite3` from the standard library, in three layers with one direction of
dependency:

- **`api/routes/`** is the only code that knows about HTTP. It parses the query string, calls
  the repository and returns JSON. It contains no SQL and no rules.
- **`api/repository/`** is the only code that knows SQL. Filtering, ordering and the overdue
  rule live here, so they can be tested without a request.
- **`api/errors.py`** builds every error in one place, as `{"error": {"code", "message"}}` with
  a real status code.

**web/src** mirrors that split: `api/client.ts` is the only code that fetches, `hooks/` hold the
data, `lib/overdue.ts` holds the one rule the front end owns, and `pages/` and `components/`
render. Nothing in `web/src` filters an array that came back from the API, because a filter has
to be right about the rows that were never downloaded.

## Sequence: completing a task *(approved)*

1. The browser is on `#/lists/2`. The learner presses **Complete** on a `TaskRow`.
2. `web/src/api/client.ts` posts to `/api/tasks/7/complete`, on the page's own origin.
3. `web/serve.js` sees the `/api` prefix and forwards the request to `API_URL`.
4. `api/routes/tasks.py` reads the id, calls `api/repository/tasks.py`, and returns the task.
5. The repository writes `status` and `completed_at` in one statement and reads the row back.
6. An unknown id never reaches the repository twice: the route turns it into
   `task_not_found`, and `api/errors.py` sends `404` with that code.
7. The hook refreshes the list, the API filters and orders it again, and the row leaves the
   open filter.

The same seven steps run in the preview, in `npm run dev` and in `docker compose up`. The only
difference is what `API_URL` points at.

## What is settled, and what is yours *(approved)*

Settled: two services, the proxy, SQLite, hash routing, and the three-layer split on each side.
Do not redesign them — a design phase that reopens the architecture never reaches the contract.

Yours, in the three files this phase opens:

- **`design/my-design.md`** — the data model, one contract block per operation, and the decision
  log.
- **`shared/contract/api.json`** — the HTTP contract. Both halves of the application are written
  against this file, so it is the one both phases 3 and 4 will hold you to.
- **`shared/contract/screens.json`** — the screen contract. Which screens exist, what each one
  shows, and which operation feeds it.

`design/design.json` is the record behind `my-design.md`: the design editor writes it, and
phase 6 opens its change request against the operations you named in it.
