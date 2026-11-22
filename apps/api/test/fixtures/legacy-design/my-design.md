# TaskTrackr — Design (your sections)

## 1 — Task data model *(complete this)*

<!-- One row per field of the tasks table, plus the tables tasks depends on.
     Read the backlog and ask what each story forces the model to store:
     US-3 filters by status and searches the title, US-4 needs to know when a
     task was due, and a tag belongs to many tasks while a task carries many
     tags. Point a field at the table it belongs to in the notes column.
     The same model goes into shared/contract/api.json under "entities". -->

| Field | Type | Required? | Notes / which story needs it |
|-------|------|-----------|------------------------------|
| id    | integer | yes    | assigned by the database (US-1) |
|       |      |           |                              |
|       |      |           |                              |
|       |      |           |                              |
|       |      |           |                              |
|       |      |           |                              |

## 2 — API contract *(complete this)*

<!-- One block per operation: what goes in, what comes out, what happens when
     it goes wrong, and the story it satisfies. Write the same three operations
     into shared/contract/api.json — that file is the one phases 3 and 4 hold
     you to, and this section is where you say it in words. -->

### `completeTask(id)` — US-?

- Inputs:
- Returns:
- Errors:

### `listTasks(listId, filters)` — US-?

- Inputs:
- Returns:
- Ordering:
- Errors:

### `getOverdue(today)` — US-?

- Inputs:
- Returns:
- Boundary:
- Errors:

## 3 — Decision log *(complete this)*

<!-- At least ONE decision with the trade-off you weighed. Real forks in this
     design: the API filters versus the browser filters; today as a required
     parameter versus the server reading its own clock; a tags column on tasks
     versus a table that pairs them; one page for the report versus a filter
     on the list. -->

| # | Decision | Trade-off weighed |
|---|----------|-------------------|
| D1 |          |                   |
