## Change request CR-2

TaskTrackr shipped. People are using it, and one thing keeps coming back:

> **CR-2 — Comments on a task.** A task says what to do and never says what
> happened. Let people leave a comment on a task, read a task's comments newest
> first, and see on the task row how many a task carries.

The codebase is the finished one. Lists, tasks, tags, filters and the overdue
report all work, and the front end reads them. Your job is to add the new
capability **without breaking any of it**.

Open **`api/repository/comments.py`** and implement the
`add_comment(conn, task_id, author, body)` and `list_comments(conn, task_id)`
gaps:

- `add_comment` stores one comment and returns it, in the shape the contract
  publishes: `id`, `task_id`, `author`, `body`, `created_at`.
- An unknown task raises `KeyError`, whichever of the two you are in.
- An empty author or an empty body raises `ValueError`. Whitespace alone is
  empty: a comment with neither says nothing to the next person who reads the
  task.
- `list_comments` returns the comments newest first.

Then the routes, in **`api/routes/comments.py`**. The blueprint is registered
already; the two handlers are yours:

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/tasks/{id}/comments` | 200, the comments | 404 `task_not_found` |
| POST | `/api/tasks/{id}/comments` | 201, the comment | 400 `invalid_comment`, 404 `task_not_found` |

`api/routes/tasks.py` is the worked example: it turns `KeyError` into a 404 and
`ValueError` into a 400, and builds both with `fail()` so every error this API
sends has one shape.

### The count, and the part that can break something

The task row has to show how many comments a task carries, so every task the
API returns needs a `comment_count`. That lives in `TASK_SELECT`, in
**`api/repository/tasks.py`** — and that one query is read by `get_task`,
`list_tasks` and `overdue_tasks`, each of which glues its own `WHERE` and
`ORDER BY` onto the end of it.

So the count has to come back **one value per task, without changing how many
rows the query returns**. `tag_names`, a few lines below, already does exactly
that against a different table. Read it before you write anything.

A join in the `FROM` clause is the obvious move and it is the wrong one: it
changes the row count of the query every screen in the application reads. The
regression suite is what tells you, and you can run it yourself.

### The row

The count is only a count until somebody sees it. In
**`web/src/components/TaskRow.tsx`**, a task that carries comments wears a
badge and a task with none wears nothing:

| `comment_count` | the row shows |
|---|---|
| 0 | nothing at all |
| 1 | `1 comment` |
| 4 | `4 comments` |

The badge is a `<span>` with `className="badge badge-comments"` and
`data-testid="comment-count"`, in the `task-main` block beside the overdue
badge — which is the same shape, written a few lines above. `TaskRow` is on
every screen in the application, so this is one addition and nothing else: a
change that reaches further than the badge is a change somebody has to review
twice.

### The record the change travels with

Three artefacts, and none of them is decoration:

- **`shared/contract/api.json`** — the published HTTP contract. Both halves of
  the application are written against it, so an operation that is not in it is
  an operation nobody outside this repository can call. Add `listComments` and
  `addComment` in the shape of their neighbours, and add the error code
  `addComment` answers with to `errors`.
- **`design/contracts.json`** — the operations you promised in the design
  phase, seeded into this workspace when the phase unlocked. Add the two
  comment operations: their inputs, what they return, and the error cases. The
  conformance ledger holds your code against what is written there.
- **`CHANGELOG.md`** — the `2.1.0` heading is waiting and the entry under it is
  yours. Write it for the person who upgrades, not for the person who wrote the
  change.

### How you are graded

- **Change and regression** — on submit, a sealed suite runs your new
  behaviour **and** a regression suite over everything the earlier phases
  shipped, across both layers. The two are pooled, so a change that costs a
  regression scores less than no change at all.
- **Visible tests** — two runs, and you can run both. **API tests**:
  `tests/test_comments_api.py` is a three-question smoke of the change, and
  `tests/test_lists_api.py` and `tests/test_tasks_api.py` are the regression
  suite, in your workspace on purpose. **Front end**:
  `web/src/components/TaskRow.test.tsx` asks the same question of the row.
- **Maintainability** — the change should be small and local. Static analysis
  checks that you left no TODO markers, added no banned constructs and did not
  inflate complexity.

### What good looks like

- The new functions read like their neighbours: the same lookup helper for the
  unknown-task case, the same `_to_comment` on the way out, no second copy of a
  check that already exists.
- The regression suite is green before you ever press Submit PR-6.
- Nothing outside the six files the request names has changed.

### Using the AI mentor well

Ask how to scope a change safely, what a count in a composed query has to look
like, or why regression tests belong in a maintenance change. It will not write
the SQL, the routes or the badge for you.

Press **Run regression tests** as you work, and **Run app** to see the count on
a real row. When you are ready, press **Submit PR-6**. You need **Pass on every required criterion**;
this is the final phase, so passing completes the project.
