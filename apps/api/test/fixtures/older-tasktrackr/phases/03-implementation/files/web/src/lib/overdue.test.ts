/**
 * The boundary rule, on the client (US-4, US-5).
 *
 * `test` and `assert` are globals — the LearnSDLC runner provides them, and so
 * does `node web/run-tests.js`. There is no framework to import and no
 * `expect`: this is node's own `assert`.
 *
 * Two cases, and they are the two that decide the rule. The hidden suite adds
 * the rest, including the badge on the row and the hook that fetches.
 */

import { isOverdue } from './overdue';
import type { Task } from '../api/types';

function task(fields: Partial<Task>): Task {
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

test('a task due yesterday is overdue', () => {
  assert.strictEqual(isOverdue(task({ due_date: '2026-03-13' }), '2026-03-14'), true);
});

test('a task due today is not overdue yet', () => {
  // The day is not over. This is the same boundary your SQL uses, and the
  // hidden suite asks about it in both languages.
  assert.strictEqual(isOverdue(task({ due_date: '2026-03-14' }), '2026-03-14'), false);
});
