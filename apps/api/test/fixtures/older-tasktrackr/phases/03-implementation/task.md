## Your task

TaskTrackr is built and it runs. The lists, the comments, the schema, the error envelope, the
router, the pages and every route and component around yours are written and locked. What is
missing is the code behind the five sentences your design phase wrote — three in the Python API
and two in the TypeScript front end — and each one is marked `TODO(learner)`.

1. **`list_tasks` in `api/repository/tasks.py`** *(US-3)* — the tasks in one list, narrowed by
   `status`, `q` and `tag`, highest priority first with ties by ascending id. A status the
   contract does not know is a `ValueError`, which the route already turns into a 400.
2. **`overdue_tasks` in `api/repository/tasks.py`** *(US-4)* — open tasks whose due date is
   **strictly before** the day passed in. No due date is never overdue; already done is never
   overdue. Most overdue first, then higher priority, then id.
3. **`complete_task` in `api/routes/tasks.py`** *(US-2)* — mark a task done and answer with it.
   An id nobody has is a 404 carrying the code `task_not_found`.
4. **`isOverdue` in `web/src/lib/overdue.ts`** *(US-4, US-5)* — the same boundary rule, in
   TypeScript, over data the browser already has. `web/src/components/TaskRow.tsx` is locked and
   calls it: write the rule once and a badge appears in a component you did not write.
5. **`useTasks` in `web/src/hooks/useTasks.ts`** *(US-3)* — ask the API for one list's tasks,
   send only the filters that are set, and hand the screen `{ tasks, loading, error, reload }`.
   A request that failed is an error, not an empty list.

`PRIORITY_ORDER`, `TASK_SELECT`, `get_task` and `fail` are already written above and beside the
Python stubs; `daysLate`, `byMostOverdue` and `queryFor` are written above the TypeScript ones.
Use them. The phase is about the five rules, not about SQLite row factories or query strings.

### Workflow

- Press **Run visible tests** any time. Two suites run one after the other and the report groups
  them: `tests/test_tasks_api.py`, four cases through Flask's own test client, and
  `web/src/lib/overdue.test.ts`, two cases on the boundary. All six fail right now, because the
  stubs raise `NotImplementedError` and throw `Error`.
- Press **Run app** to start your own API and your own front end and use them in the Preview
  tab. The database is seeded, so there is something to look at. Before you start, the lists
  page works and a list's tasks do not — that is the gap you are about to fill.
- The fixtures the API suite uses — `client`, `make_list`, `make_task` — are in
  `tests/conftest.py`, which is locked but open to read. They drive the API through Flask's test
  client, so a test reads exactly like the request it stands for.
- **Submit PR-3** runs both visible suites, two **hidden suites** of fourteen and eight
  cases over the same five contracts, and static analysis (leftover TODOs, banned constructs,
  complexity).
- Run before you submit. The rubric's process criterion notices.

### What good looks like

- Each gap is a few lines that lean on what the module already offers. `list_tasks` collects the
  conditions it was actually given; `overdue_tasks` is one SELECT with three conditions;
  `complete_task` is the same three lines as the four routes around it; `isOverdue` is three
  comparisons; `useTasks` is state, an effect and an answer for the failure.
- Every sentence of the docstring is true, not only the six assertions you can see. The hidden
  suites ask about an unknown id, a keyword in the middle of a title, two filters at once, a task
  due today, a task that was late but is finished, a badge on a row, a filter that should not
  have been sent, and a request that failed.
- The two overdue rules agree. You are writing the same boundary twice, once in SQL and once in
  TypeScript, and the day they disagree is the day a task is late in the report and on time on
  the row. The testing phase will ask you to prove it in both languages.
- The contract in `shared/contract/api.json` is the same one you completed in design. When your
  code and that file disagree, one of them is wrong and it is worth knowing which.

### Using the AI mentor well

Ask it to read a traceback with you, to point you at the SQL, the Flask construct or the React
hook the codebase already uses, or to talk through a boundary case. It will not write a function
body, and pasting a finished answer from anywhere defeats the phase — the hidden suites are only
interesting if the code is yours.

When you are ready, press **Submit PR-3**. Every required criterion and its evidence must pass review before the next phase opens.

### Your accepted screen copy

The read-only overdue page uses the title and empty-state sentence from the retained Design submission that passed when Implementation opened. Its source submission is recorded in `shared/contract/accepted-screen-copy.json`; the read-only screen contract shows the same text. Later draft edits do not change this accepted handoff. Older work without a retained accepted source uses an explicitly labelled reference copy.
