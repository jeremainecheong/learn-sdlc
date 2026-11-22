## Your task

Your implementation passed, but "the code runs" is not the same as "the behaviour is proven". In this phase you write the acceptance suites for TaskTrackr — the suites a team would run before every release.

The application has two halves and so does the phase. The whole application is mounted in the workspace and locked, so the two test files you open are the only things that change.

- **`tests/test_acceptance.py`** tests the **API's HTTP routes** through Flask's in-process test client.
- **`web/src/acceptance.test.tsx`** tests the **front end** in the supplied jsdom DOM harness.

### The API half, in `tests/test_acceptance.py`

1. **US-2, completing a task.** Completion is stored, not merely answered, and an id no task has is refused with the status code and the error code `shared/contract/api.json` names.
2. **US-3, listing, filtering and ordering.** Status filtering, keyword matching that ignores case, and the ordering promise: high before medium before low, ties by id.
3. **US-4, the overdue report.** Open tasks with a due date strictly before the day you ask about. Cover the boundary — **due today is not overdue** — and keep out a task that has no due date and a task that was finished late.

What is already in the file:

- **`client`** is Flask's test client, wired to a fresh in-memory database for every test. `client.post("/api/tasks/3/complete")` is the request a browser would make, minus the socket, and it goes through the same routing, status codes and JSON your front end will meet.
- **`make_list`** and **`make_task`** build a starting state through the API, and the `add` and `day` helpers at the top of the file save you the repetition.
- **`today()`** reads the run clock. See below.

### The front-end half, in `web/src/acceptance.test.tsx`

4. **US-5, the late marker on a row.** A row for a task whose due date has gone by carries a marker saying how many whole days late it is. A finished task carries none, however late it was. A task with no due date carries none either.
5. **US-3 again, from the other side.** The search box has to survive the next filter: when a status is chosen as well, the request the front end sends still carries the keyword.

What is already in that file:

- **`render`** puts a component in jsdom and **`screen`** asks questions of that DOM. This harness checks rendered content and interactions without opening a browser or proving its visual layout. `screen.getByTestId(...)` throws when nothing matches; `screen.queryByTestId(...)` answers `null`, which is what you want when the point of the test is that something is absent.
- **`renderHook`** runs a hook on its own, and **`waitFor`** waits for the state it settles into.
- **`assert`** is node's assert module. There is no `expect` and no matcher library here.
- **`aTask(...)`** and **`answerWith(...)`** are in `web/src/testing/fixtures.ts`, locked and worth reading once. `aTask` gives you a task with the contract's defaults so a test names only the fact it is about; `answerWith` answers every request with one canned response and collects the URLs that were asked for. There is no server behind these tests, and a test that reaches for the network is told so.
- **`today()`** and **`daysAgo(n)`** are the twins of `tests/clock.py`, and they read the same run clock.

The testids the application already carries, so you can ask for exactly the thing you mean:

| testid | what it is |
|---|---|
| `task-row` | one row |
| `task-title`, `task-priority`, `task-due`, `task-tag` | what the row says |
| `overdue-badge` | the late marker, and its wording is "3 days late" |
| `complete-task`, `reopen-task` | the button the row offers |
| `filter-status`, `filter-q`, `filter-tag` | the filter bar |

### How you are graded

- **Pass on a healthy application** — a test that fails on correct code is a bug in the test.
- **Mutation testing** — on submit, your suites also run against **eight secretly broken copies of the application**: six of the API and two of the front end. A strong suite fails on every one of them, which is what "killing a mutant" means. Weak assertions let them through.
- **Coverage mapping** — completing, filtering, the overdue report and the late marker each need at least one test, and **six tests across the two files** is the floor.

Press **Run my tests** while you work: both suites run one after the other and the report groups them under **API tests** and **Front end**. The broken copies only run on submit. Open **Execution evidence** to inspect each case, its failure details and the run's console output. These suites do not replace a separate browser check of the running application.

Name each test after the criterion it proves and keep the ids from the requirements phase — `US-3/AC-2`, `US-5/AC-2`. Every planted bug is filed against one criterion, so a surviving copy names the criterion your suite has not proved yet.

### The response, or the next request

One habit is worth more than any other on the API side. A handler can answer `"status": "done"` and write nothing at all, and the only thing that can tell you is asking for the task again:

```python
client.post(f"/api/tasks/{task['id']}/complete")
again = client.get(f"/api/tasks/{task['id']}").get_json()
assert again["status"] == "done"
```

A suite that stops at the first response passes on an API that forgets everything.

The front-end habit is the twin of it: assert the URL the screen asked for, not only that something came back. A hook that quietly drops a parameter still renders whatever the server sent, and only the URL can tell you.

```tsx
const urls = answerWith({ body: [] });
// ... run the hook, wait for it to settle ...
assert.ok(urls[0].includes('q=rent'), urls[0]);
```

### The run clock

Both your suites have a boundary in them — due today is not overdue — and a boundary about dates is only testable if you decide what day it is. Read the day through `tests/clock.py` on the API side:

```python
from tests.clock import today

def day(offset):
    return (today() + timedelta(days=offset)).isoformat()
```

and through `web/src/testing/clock.ts` on the front end, where `daysAgo(3)` is the date three days ago. Build every due date from them. Then pin the clock in the **Run clock** control beside the criteria: with a date pinned, your suites, the reference runs and all eight broken copies see that same day, so the kill matrix means the same thing tomorrow as it does now. With nothing pinned they all see the machine's date.

A test that names a fixed date rots. A test that reads the machine's clock is a different test every day. Reading the clock through one function is how a real suite stays honest. Changing the clock costs you no attempt and invalidates no verdict — it is a parameter of the next run, not an event.

### What good looks like

- One behaviour per test, named after the criterion it proves.
- Assertions on stored state, on exact ordering, and on what the screen actually shows — not on "it did not raise".
- Both sides of every boundary, every error path checked by status code **and** error code, and the absent case asserted as carefully as the present one.

### Using the AI mentor well

Ask about boundary values, what makes an assertion strong, how to tell a response apart from stored state, or how to ask a rendered row a question. It will not reveal the planted bugs — working out what could break is the skill being trained.

When you are ready, press **Submit PR-4**. Every required criterion and its evidence must pass review before the next phase opens.
