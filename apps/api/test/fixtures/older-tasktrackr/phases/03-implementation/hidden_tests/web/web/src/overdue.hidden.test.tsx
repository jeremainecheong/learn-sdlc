/**
 * The sealed front-end suite for the implementation phase (US-3, US-4, US-5).
 *
 * Eight cases: five on the boundary rule itself, one on the badge a component
 * the learner did not write puts on a row, and two on the hook — including the
 * one that catches the most common defect in a first React app, a request that
 * failed and rendered as "no tasks".
 *
 * Why `src(...)` instead of `import { isOverdue } from './lib/overdue'`: a
 * graded suite is written outside the workspace and imported before the seal
 * deletes it, so a relative import resolves beside the sealed copy rather than
 * beside the learner's code, and node answers "Cannot find module". Requiring
 * by workspace path — the child's working directory is the workspace root —
 * loads exactly the file the learner wrote.
 */

import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';

const src = (rel: string) => require(`${process.cwd()}/web/src/${rel}`);
const { isOverdue } = src('lib/overdue');
const { TaskRow } = src('components/TaskRow');
const { useTasks } = src('hooks/useTasks');

interface AnyTask {
  id: number;
  list_id: number;
  title: string;
  priority: string;
  due_date: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  tags: string[];
  comment_count: number;
}

const TODAY = '2026-03-14';

function task(fields: Partial<AnyTask>): AnyTask {
  return {
    id: 1,
    list_id: 1,
    title: 'Renew the passport',
    priority: 'medium',
    due_date: null,
    status: 'open',
    created_at: '2026-03-01T09:00:00+00:00',
    completed_at: null,
    tags: [],
    comment_count: 0,
    ...fields,
  };
}

/** Answers every call the same way, and records the URLs it was asked for. */
function stubFetch(answer: { status: number; body?: unknown }): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: () => Promise.resolve(JSON.stringify(answer.body ?? [])),
    });
  }) as unknown as typeof fetch;
  return urls;
}

test('a task due yesterday is overdue', () => {
  assert.strictEqual(isOverdue(task({ due_date: '2026-03-13' }), TODAY), true);
});

test('a task due today is not overdue yet', () => {
  assert.strictEqual(isOverdue(task({ due_date: TODAY }), TODAY), false);
});

test('a task due tomorrow is not overdue', () => {
  assert.strictEqual(isOverdue(task({ due_date: '2026-03-15' }), TODAY), false);
});

test('a task with no due date is never overdue', () => {
  assert.strictEqual(isOverdue(task({ due_date: null }), TODAY), false);
});

test('a finished task is not overdue, however late it was', () => {
  const late = task({
    due_date: '2026-01-05',
    status: 'done',
    completed_at: '2026-03-10T10:00:00+00:00',
  });
  assert.strictEqual(isOverdue(late, TODAY), false);
});

test('the row wears the overdue badge when the rule says late, and not otherwise', () => {
  // TaskRow is locked and the learner did not write it. It calls isOverdue, so
  // the badge appearing on the right rows is the rule working end to end.
  cleanup();
  render(<TaskRow task={task({ due_date: '2026-03-11' })} today={TODAY} />);
  assert.ok(screen.getByTestId('overdue-badge'), 'a task due three days ago wears no badge');
  assert.match(screen.getByTestId('overdue-badge').textContent || '', /3 days late/);

  cleanup();
  render(<TaskRow task={task({ due_date: TODAY })} today={TODAY} />);
  assert.strictEqual(
    screen.queryByTestId('overdue-badge'),
    null,
    'a task due today wears a badge it has not earned',
  );
});

test('only the filters that are set reach the request', async () => {
  cleanup();
  const set = stubFetch({ status: 200, body: [] });
  const chosen = renderHook(() => useTasks(2, { status: 'open', q: '  rent ', tag: '' }));
  await waitFor(() => assert.strictEqual(chosen.result.current.loading, false));
  assert.strictEqual(set.length, 1, `expected one request, got ${set.length}`);
  assert.ok(set[0].includes('status=open'), `status was not sent: ${set[0]}`);
  assert.ok(set[0].includes('q=rent'), `the search was not sent, or not trimmed: ${set[0]}`);
  assert.ok(!set[0].includes('tag='), `an empty tag was sent: ${set[0]}`);

  cleanup();
  const none = stubFetch({ status: 200, body: [] });
  const all = renderHook(() => useTasks(2, { status: 'all', q: '', tag: '' }));
  await waitFor(() => assert.strictEqual(all.result.current.loading, false));
  assert.strictEqual(none.length, 1, `expected one request, got ${none.length}`);
  assert.ok(!none[0].includes('status='), `"all" is not a filter, but it was sent: ${none[0]}`);
  assert.ok(!none[0].includes('q='), `an empty search was sent: ${none[0]}`);
});

test('a failed request becomes an error, not an empty list', async () => {
  // The one no visible test looks for: a hook that swallows a 500 renders
  // "nothing here matches those filters", which is a lie about the data.
  cleanup();
  stubFetch({
    status: 500,
    body: { error: { code: 'unexpected_error', message: 'The database is gone.' } },
  });
  const { result } = renderHook(() => useTasks(2, { status: 'all', q: '', tag: '' }));
  await waitFor(() => assert.strictEqual(result.current.loading, false));
  assert.strictEqual(result.current.error, 'The database is gone.');
  assert.deepStrictEqual(result.current.tasks, []);
});
