/**
 * Your acceptance suite for the TaskTrackr front end.
 *
 * The other half tests HTTP routes with Flask's in-process test client. This half tests
 * what a person actually sees: the row, and the request the screen makes when
 * they type in it. Cover the criteria of US-5 and the front-end criterion of
 * US-3, and write them against the screen and the URL rather than against the
 * code, because a test that mirrors the implementation passes whatever the
 * implementation does.
 *
 * Everything you need is already here.
 *
 * * `render` puts a component in the supplied jsdom DOM harness, and `screen`
 *   asks questions of it. This does not open a browser or prove visual layout.
 *   `screen.getByTestId(...)` throws when nothing matches;
 *   `screen.queryByTestId(...)` answers null, which is what you want when the
 *   point of the test is that something is absent.
 * * `renderHook` runs a hook on its own, and `waitFor` waits for the state it
 *   settles into.
 * * `assert` is node's assert module. There is no `expect` here.
 * * `aTask(...)` and `answerWith(...)` come from web/src/testing/fixtures.ts,
 *   which is locked and worth reading once.
 * * `today()` and `daysAgo(n)` read the run clock. Pin a date in the Run clock
 *   control and every date below moves with it. Never type a date into this
 *   file, and never call `new Date()`.
 *
 * The task panel lists the testids the rows and the bar carry.
 *
 * Three tests here is the floor, not the target, and six across the two
 * suites is what the grader counts.
 */

import { render, renderHook, screen, waitFor } from '@testing-library/react';

import { TaskRow } from './components/TaskRow';
import { useTasks } from './hooks/useTasks';
import { daysAgo, today } from './testing/clock';
import { aTask, answerWith } from './testing/fixtures';

/* ------------------------------------------------- the worked example -- */

test('a row shows the title and the priority it was given', () => {
  // Arrange, act, assert: one task, one render, one thing you can see.
  render(<TaskRow task={aTask({ title: 'Write the report', priority: 'high' })} today={today()} />);

  assert.strictEqual(screen.getByTestId('task-title').textContent, 'Write the report');
  assert.strictEqual(screen.getByTestId('task-priority').textContent, 'high');
});

// TODO(learner): US-5 — the late marker on a row. Four rows decide this rule,
//                and only one of them wears a marker: a task whose due date
//                has gone by, a task due today, a task with no due date, and a
//                task that was finished long after it was due. Build every
//                date with daysAgo(n), and remember that the marker says how
//                many days, so its wording is worth asserting too.

// TODO(learner): US-3 — what the screen actually asks the API for. Stub the
//                network with answerWith(...), run useTasks through
//                renderHook, wait for it to settle, then read the URL it
//                asked for. The case that matters is not the keyword on its
//                own: it is the keyword with a status set as well, because
//                that is where one narrowing quietly loses the other.
