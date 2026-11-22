# TaskTrackr product backlog (approved)

**Vision.** TaskTrackr is a task manager for people juggling study and work. It is
a web application: a Python API over a SQLite database, a React front end in
TypeScript, and one contract between them. Tasks live in lists, carry a
priority and an optional due date, and can be searched, filtered and commented
on.

**In scope for v2.0:** lists and tasks, completing and reopening a task,
filtering and searching a list, an overdue report, and a late marker on the
rows a person is already looking at. **Out of scope for v2.0:** accounts, sync,
notifications, and anything that sends a message to a human being.

Every acceptance criterion carries an id. `US-2/AC-1` is the first criterion of
US-2. The design, implementation, testing and deployment phases refer to
criteria by those ids — the testing phase files each seeded bug against the one
criterion that should catch it — so the story you write here mints its own:
`US-4/AC-1`, `US-4/AC-2`, and so on.

The note beside each title says where the behaviour lives. `api` is the Python
service, `web` is the React front end, and a story marked `api and web` is one
whose rule is written on both sides on purpose and has to agree.

---

## US-1 — Add a task *(approved, api)*

As a busy learner, I want to add a task to a list with a title, a priority and
an optional due date, so that I can capture work the moment I think of it.

**Acceptance criteria**

- **AC-1** Given a list with no tasks, when I add a task titled "Write report",
  then the task is stored in that list with priority `medium`, status `open`
  and no completion time.
- **AC-2** Given any list, when I add a task with an empty title, then the API
  answers 400 with the code `invalid_title` and stores nothing.
- **AC-3** Given any list, when I add a task with priority `urgent`, then the
  API answers 400 with the code `invalid_priority` — only `low`, `medium` and
  `high` exist.

## US-2 — Complete a task *(approved, api)*

As a busy learner, I want to mark a task as completed by its id, so that my
lists reflect what is actually left to do.

**Acceptance criteria**

- **AC-1** Given an open task, when I complete it, then it is stored as done
  with the time it was completed, and it is still done the next time anything
  reads it.
- **AC-2** Given an id no task has, when I complete it, then the API answers
  404 with the code `task_not_found` and nothing changes.

## US-3 — Filter, search and order a list *(approved, api and web)*

As a busy learner, I want to narrow a list by status, tag and keyword and read
it in priority order, so that I can see the right work without scrolling past
the rest.

**Acceptance criteria**

- **AC-1** Given a list of open and done tasks, when I ask for status `open`,
  then only the open tasks come back.
- **AC-2** Given tasks titled "Pay rent" and "Review notes", when I search for
  "rent", then only "Pay rent" comes back, and searching for "RENT" returns the
  same task — the match ignores case.
- **AC-3** Given a keyword in the search box, when I also change the status or
  the tag, then the request the front end sends still carries the keyword, so
  the search is not silently dropped by the next filter.
- **AC-4** Given tasks of mixed priorities, when I read a list, then `high`
  tasks come before `medium` and `medium` before `low`, and two tasks of the
  same priority are ordered by id.

## US-4 — Overdue report *(missing, you write it in `my-story.md`)*

*The product owner never wrote this story. It is your job in this phase, and
the phases after it build on what you write.*

## US-5 — See at a glance which tasks are late *(approved, web)*

As a busy learner, I want a late marker on the task rows I am already looking
at, so that I do not have to open a report to notice a deadline I have missed.

**Acceptance criteria**

- **AC-1** Given a task whose due date has passed, when I look at its row, then
  the row carries a marker saying how many whole days late the task is.
- **AC-2** Given a task I have completed, when I look at its row, then it
  carries no late marker, however long ago its due date was — a finished task
  is not owed.
- **AC-3** Given a task with no due date, when I look at its row, then it
  carries no late marker and no empty space where one would go.
