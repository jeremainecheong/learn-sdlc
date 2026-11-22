/**
 * The front-end acceptance suite this pack would hand in.
 *
 * One case per acceptance criterion of US-5 (the late marker on a row) and the
 * front-end half of US-3 (the search reaches the API), written against what a
 * person can see and what the browser actually asks for, rather than against
 * the code. It is the pack's own proof that the two planted front-end bugs can
 * be caught: a mutant that survives this suite is a bug in the pack, not in
 * the learner.
 *
 * Two habits carry most of it, and both are worth stealing:
 *
 * * assert what the screen shows, not what a function returned. The row is
 *   what a person reads, and the row is where the rule shows up or does not.
 * * assert the URL the front end asked for, not only that something came back.
 *   A hook that quietly drops a parameter still renders whatever the stub
 *   answers with, and only the URL can tell you.
 */

import { render, renderHook, screen, waitFor } from '@testing-library/react';

import { TaskRow } from './components/TaskRow';
import { queryFor, useTasks } from './hooks/useTasks';
import { daysAgo, today } from './testing/clock';
import { aTask, answerWith } from './testing/fixtures';

/* ------------------------------------------- US-5, the marker on a row -- */

test('a task past its due date carries the marker, and says how many days', () => {
  render(<TaskRow task={aTask({ due_date: daysAgo(3) })} today={today()} />);

  assert.strictEqual(screen.getByTestId('overdue-badge').textContent, '3 days late');
});

test('one day late is one day, not one days', () => {
  render(<TaskRow task={aTask({ due_date: daysAgo(1) })} today={today()} />);

  assert.strictEqual(screen.getByTestId('overdue-badge').textContent, '1 day late');
});

test('a task finished after its due date carries no marker', () => {
  // US-5/AC-2: a finished task is not owed, however late it was.
  const done = aTask({
    due_date: daysAgo(9),
    status: 'done',
    completed_at: `${daysAgo(1)}T10:00:00+00:00`,
  });

  render(<TaskRow task={done} today={today()} />);

  assert.strictEqual(screen.queryByTestId('overdue-badge'), null);
});

test('a task due today carries no marker yet', () => {
  render(<TaskRow task={aTask({ due_date: daysAgo(0) })} today={today()} />);

  assert.strictEqual(screen.queryByTestId('overdue-badge'), null);
});

test('a task with no due date carries no marker at all', () => {
  // US-5/AC-3: no marker, and no empty space where one would go.
  render(<TaskRow task={aTask({ due_date: null })} today={today()} />);

  assert.strictEqual(screen.queryByTestId('overdue-badge'), null);
  assert.strictEqual(screen.queryByTestId('task-due'), null);
});

/* --------------------------------- US-3, what the front end asks for --- */

test('only the filters that are set become query parameters', () => {
  assert.deepStrictEqual(queryFor({ status: 'all', q: '', tag: '' }), {});
  assert.deepStrictEqual(queryFor({ status: 'open', q: '  rent ', tag: 'home' }), {
    status: 'open',
    q: 'rent',
    tag: 'home',
  });
});

test('the keyword still reaches the API when a status is set as well', async () => {
  // US-3/AC-3: the second filter must not silently drop the first.
  const urls = answerWith({ body: [] });

  const { result } = renderHook(() => useTasks(2, { status: 'open', q: 'rent', tag: '' }));
  await waitFor(() => assert.strictEqual(result.current.loading, false));

  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes('q=rent'), `the keyword was dropped: ${urls[0]}`);
  assert.ok(urls[0].includes('status=open'), `the status was dropped: ${urls[0]}`);
});

test('a search box with nothing in it is not a search', async () => {
  const urls = answerWith({ body: [] });

  const { result } = renderHook(() => useTasks(2, { status: 'all', q: '   ', tag: '' }));
  await waitFor(() => assert.strictEqual(result.current.loading, false));

  assert.ok(!urls[0].includes('q='), `an empty keyword was sent: ${urls[0]}`);
});

test('a failed request becomes an error, not an empty list', async () => {
  answerWith({
    status: 500,
    body: { error: { code: 'unexpected_error', message: 'The database is gone.' } },
  });

  const { result } = renderHook(() => useTasks(2, { status: 'all', q: '', tag: '' }));
  await waitFor(() => assert.strictEqual(result.current.loading, false));

  assert.strictEqual(result.current.error, 'The database is gone.');
  assert.deepStrictEqual(result.current.tasks, []);
});
