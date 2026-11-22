# Phase 3, implementation: notes for whoever runs the lab

Not shown to the learner. This is the timing and the one lever worth pulling.

## The 90-minute shape, which is what ships

Five gaps across two layers: `list_tasks` and `overdue_tasks` in `api/repository/tasks.py`, the
`complete_task` route in `api/routes/tasks.py`, `isOverdue` in `web/src/lib/overdue.ts` and
`useTasks` in `web/src/hooks/useTasks.ts`. Measured against the shipped solution, that is **27
lines of Python and 35 of TypeScript**, in a workspace of 31 files. The visible suites are six
cases; the hidden suites are twenty-two.

The order in the mentor's progressive hints is the order that works: the route first, because it
is four lines and it turns two visible cases green, then `list_tasks`, then `overdue_tasks`, then
`isOverdue`, then `useTasks`. A learner who starts with `useTasks` spends the hour on React and
never meets the two rules the phase is actually about.

**`useTasks` is the biggest single gap by some way** — 32 of those 35 TypeScript lines — and it
is the only one that is about a framework rather than about a rule. That is what the lever below
is for, and it is worth deciding before the lab rather than during it.

Press **Run app** with nothing written and the preview is honest about where they are: the lists
page renders and shows three seeded lists, and clicking one fails, because
`GET /api/lists/1/tasks` is the first gap. That is a good thing to show on the projector before
anybody starts typing.

## The 60-minute variant: lock `useTasks` and ship it complete

If the slot is an hour rather than ninety minutes, take this before the lab rather than at 1am
during it.

- In `phase.json`, move `web/src/hooks/useTasks.ts` from `"editable": true` to
  `"editable": false` and point its `source` at `../../canonical/web/src/hooks/useTasks.ts`.
- Drop it from `checks.editableTargets`, and delete `solution/web/src/hooks/useTasks.ts` — the
  loader would still load it and `executionFiles` would still ignore it, but an overlay that
  answers no gap is a file nobody will maintain.
- Drop the last two cases of `hidden_tests/web/web/src/overdue.hidden.test.tsx` — "only the
  filters that are set reach the request" and "a failed request becomes an error, not an empty
  list". The front-end run then has six hidden cases and the pooled total is twenty.
- Reword objective 5 and item 5 of `task.md`, and the last progressive hint, which all name the
  hook.

What survives is the rule that matters: `isOverdue` is still the learner's, written once in
TypeScript against the same boundary they wrote in SQL, and `TaskRow.tsx` still renders a badge
from it in a component they did not write.

What is lost is the case that catches the most common defect in a first React app — a hook that
swallows a 500 and renders "no tasks". If you take the variant, say that out loud when you show
the report, because no test will say it for you.

## Two things that are deliberate and look like mistakes

- **The two hidden suites run under different harnesses from the visible ones.** The learner
  reads and writes pytest; the sealed Python suite is unittest, because that is the seal three
  runner tests prove. The front end is the same harness either way.
- **`code_quality` scores the Python files only.** The analyzer skips `.ts` and `.tsx` for now
  (wave F decision 9), so a `TODO(learner)` left in `overdue.ts` costs nothing where the same
  marker left in `tasks.py` costs 10 points. Nobody has complained yet; say it if asked rather
  than being caught by it.
