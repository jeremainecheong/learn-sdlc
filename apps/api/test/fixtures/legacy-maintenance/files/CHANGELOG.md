# Changelog

Every release that changed what somebody can do, newest first. Versions follow
`MAJOR.MINOR.PATCH`: a breaking change to the contract is major, a new capability is minor, a
fix is a patch.

## 2.1.0

<!-- TODO(learner) CR-2: the entry for this release, written for the person who upgrades and
     not for the person who wrote it. What can they do now that they could not do before, and
     what does it change about a contract they already depend on? One line each, under an
     `### Added` heading in the shape of 2.0.0 below. The version heading above stays; only the
     body is yours. -->

## 2.0.0

The first release anybody else can run.

### Added
- Lists, tasks and tags, over a SQLite database with foreign keys enforced.
- Eleven HTTP operations under `/api`, published in `shared/contract/api.json`.
- Three screens behind a hash router, published in `shared/contract/screens.json`: the lists,
  the tasks in one list with a filter bar, and the overdue report.
- The overdue report: open tasks strictly past their due date, most overdue first. The day is a
  parameter, never the machine's clock.
- Two containers and a compose file, with a healthcheck on the API and a named volume for the
  database.
- `python3 api/main.py --selfcheck`, which asks whether the deployment hangs together and says
  what is wrong in one sentence when it does not.
- `ops/seed.py`, so a fresh database has something in it.

### Notes
- The web service proxies `/api` to the API, so the application needs no CORS.
- The front end uses no cookies, no local storage and no `history.pushState`. State is React
  state and the API.
- The `comments` table is in the schema and nothing reads or writes it yet.
