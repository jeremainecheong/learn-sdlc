# TaskTrackr

A task manager you can run. Lists hold tasks, tasks carry tags and comments, and one report
answers the only question anybody actually asks a task manager: what is late.

It is deliberately small and deliberately real. There is a database, an HTTP API, a browser
front end, a contract between them, two containers and a runbook — the same parts a system at
work has, in the smallest honest quantity.

## The two services

```
browser ──▶ web (node)  ──/api──▶  api (python)  ──▶  tasktrackr.db (sqlite)
                │
                └── serves web/dist/app.js and web/index.html
```

**web** is `web/serve.js`, about eighty lines of `node:http`. It serves the built front end and
forwards anything under `/api` to the API. That is the whole reason there is no CORS anywhere in
this application: the browser only ever talks to one origin, and `API_URL` is what tells the web
service where the other one is.

**api** is Flask over `sqlite3` from the standard library. `api/routes/` is the only code that
knows about HTTP; `api/repository/` is the only code that knows SQL; `api/errors.py` builds
every error in one place. The whole HTTP contract is in `shared/contract/api.json`, and the
screens are in `shared/contract/screens.json`.

## Running it

```
pip install -r requirements.txt
npm install
npm run dev          # builds the front end, then starts both services
```

Then open http://127.0.0.1:5173. `npm run dev` runs the API on 8000 and the web service on 5173
with `API_URL=http://127.0.0.1:8000`; Ctrl-C stops both.

```
npm run build        # esbuild bundles web/src/main.tsx to web/dist/app.js
npm test             # the API suite and the front-end suite
npm run lint         # tsc --noEmit over web/src
npm run selfcheck    # asks whether this deployment hangs together
python3 ops/seed.py  # three lists and ten tasks, so there is something to look at
```

With containers:

```
docker compose up --build
```

Same two services, same ports, `web` waiting on `api`'s healthcheck, and the database on a named
volume so `docker compose down` does not lose it.

## The tests

`tests/` is pytest over Flask's test client — real routing, real status codes, real JSON, no
socket. `web/src/**/*.test.tsx` sit beside the code they test and run under jsdom. Both suites
use `test` and `assert` as globals, which is why neither imports a test framework.

```
npm run test:api     # python3 -m pytest tests -q
npm run test:web     # node web/run-tests.js
```

`web/run-tests.js` does the same three things the LearnSDLC sandbox does to your front-end
suite, in the same order, so a suite that passes on your laptop passes when it is marked.

## Where the rules live

Three rules carry most of this application, and each is one line of code:

- **Ordering.** Highest priority first, ties by ascending id. In SQL, in
  `api/repository/tasks.py`.
- **Search.** `q` matches part of the title, case-insensitively. Also in SQL, also there.
- **Overdue.** Open tasks whose due date is strictly *before* today. A task due today is not
  late yet. This one is written twice: in SQL for the report, and in
  `web/src/lib/overdue.ts` for the badge, because a badge on a row must not need a round trip.

Two copies of one rule is a risk, and it is on purpose: it is the thing the tests have to hold
together.

## Configuration

Everything is an environment variable with a working default. See `.env.example`.
