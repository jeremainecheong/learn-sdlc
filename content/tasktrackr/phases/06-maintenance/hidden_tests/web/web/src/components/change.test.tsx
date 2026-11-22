/**
 * CR-2 on the row: the count when there is something to count, and silence
 * when there is not.
 *
 * Sealed. The visible suite beside it asks the same two questions in one case;
 * these two are what the phase scores.
 */

import { cleanup, render, screen } from '@testing-library/react';

import { TaskRow } from './TaskRow';
import type { Task } from '../api/types';

function task(fields: Partial<Task>): Task {
  return {
    id: 7,
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

test('a task with comments wears the count, and one comment is not "1 comments"', () => {
  cleanup();
  render(<TaskRow task={task({ comment_count: 4 })} today="2026-03-02" />);
  assert.strictEqual(screen.getByTestId('comment-count').textContent, '4 comments');
  cleanup();
  render(<TaskRow task={task({ comment_count: 1 })} today="2026-03-02" />);
  assert.strictEqual(screen.getByTestId('comment-count').textContent, '1 comment');
});

test('a task with no comments wears no badge at all', () => {
  cleanup();
  render(<TaskRow task={task({ comment_count: 0 })} today="2026-03-02" />);
  assert.strictEqual(screen.queryByTestId('comment-count'), null);
  // and the rest of the row is untouched: the count is an addition, not a rewrite
  assert.strictEqual(screen.getByTestId('task-title').textContent, 'Renew the passport');
  assert.ok(screen.getByTestId('complete-task'));
});
