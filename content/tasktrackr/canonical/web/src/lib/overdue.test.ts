/**
 * The boundary rule, on the client (US-4, US-5).
 *
 * `test` and `assert` are globals: the LearnSDLC runner provides them, and so
 * does `node web/run-tests.js`. There is no framework to import.
 */

import { byMostOverdue, daysLate, isOverdue } from './overdue';
import type { Task } from '../api/types';

function task(fields: Partial<Task>): Task {
  return {
    id: 1,
    list_id: 1,
    title: 'Something',
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

test('a task due yesterday is overdue', () => {
  assert.strictEqual(isOverdue(task({ due_date: '2026-03-13' }), '2026-03-14'), true);
});

test('a task due today is not overdue yet', () => {
  assert.strictEqual(isOverdue(task({ due_date: '2026-03-14' }), '2026-03-14'), false);
});

test('a task due tomorrow is not overdue', () => {
  assert.strictEqual(isOverdue(task({ due_date: '2026-03-15' }), '2026-03-14'), false);
});

test('a task with no due date is never overdue', () => {
  assert.strictEqual(isOverdue(task({ due_date: null }), '2026-03-14'), false);
});

test('a finished task is not overdue however late it was', () => {
  const late = task({ due_date: '2026-01-01', status: 'done', completed_at: '2026-03-10T10:00:00+00:00' });
  assert.strictEqual(isOverdue(late, '2026-03-14'), false);
});

test('days late counts whole days, and is zero when nothing is late', () => {
  assert.strictEqual(daysLate(task({ due_date: '2026-03-11' }), '2026-03-14'), 3);
  assert.strictEqual(daysLate(task({ due_date: '2026-03-14' }), '2026-03-14'), 0);
  assert.strictEqual(daysLate(task({ due_date: null }), '2026-03-14'), 0);
});

test('days late is zero for a task that is not overdue, not a negative number', () => {
  // A task due next week is not "minus four days late", and a task finished
  // three weeks late is not late now. Both answers are 0, and both come from
  // asking isOverdue first rather than subtracting two dates.
  assert.strictEqual(daysLate(task({ due_date: '2026-03-18' }), '2026-03-14'), 0);
  const finished = task({ due_date: '2026-02-01', status: 'done', completed_at: '2026-03-10T10:00:00+00:00' });
  assert.strictEqual(daysLate(finished, '2026-03-14'), 0);
});

test('the report order is most overdue first, then priority, then id', () => {
  const rows = [
    task({ id: 3, due_date: '2026-03-13', priority: 'low' }),
    task({ id: 1, due_date: '2026-03-01', priority: 'low' }),
    task({ id: 2, due_date: '2026-03-13', priority: 'high' }),
  ];
  const order = [...rows].sort(byMostOverdue('2026-03-14')).map((row) => row.id);
  assert.deepStrictEqual(order, [1, 2, 3]);
});
