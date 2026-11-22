/**
 * The row, and the badge it wears when it is late (US-5).
 */

import { cleanup, render, screen } from '@testing-library/react';

import { TaskRow } from './TaskRow';
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

test('a task due yesterday wears the overdue badge', () => {
  cleanup();
  render(<TaskRow task={task({ due_date: '2026-03-01' })} today="2026-03-02" />);
  assert.ok(screen.getByTestId('overdue-badge'));
  assert.match(screen.getByTestId('overdue-badge').textContent || '', /1 day late/);
});

test('a task due today wears no badge', () => {
  cleanup();
  render(<TaskRow task={task({ due_date: '2026-03-02' })} today="2026-03-02" />);
  assert.strictEqual(screen.queryByTestId('overdue-badge'), null);
});

test('a task finished late wears no badge either', () => {
  cleanup();
  const done = task({ due_date: '2026-01-01', status: 'done', completed_at: '2026-03-01T10:00:00+00:00' });
  render(<TaskRow task={done} today="2026-03-02" />);
  assert.strictEqual(screen.queryByTestId('overdue-badge'), null);
});

test('a done task offers Reopen and an open one offers Complete', () => {
  cleanup();
  render(<TaskRow task={task({ status: 'done' })} today="2026-03-02" />);
  assert.ok(screen.getByTestId('reopen-task'));
  assert.strictEqual(screen.queryByTestId('complete-task'), null);
});

test('the comment count shows only when there are comments', () => {
  cleanup();
  render(<TaskRow task={task({ comment_count: 0 })} today="2026-03-02" />);
  assert.strictEqual(screen.queryByTestId('comment-count'), null);
  cleanup();
  render(<TaskRow task={task({ comment_count: 2 })} today="2026-03-02" />);
  assert.strictEqual(screen.getByTestId('comment-count').textContent, '2 comments');
});

test('the tags and the due date are on the row', () => {
  cleanup();
  render(<TaskRow task={task({ due_date: '2026-04-01', tags: ['home', 'admin'] })} today="2026-03-02" />);
  assert.strictEqual(screen.getByTestId('task-due').textContent, 'due 2026-04-01');
  assert.strictEqual(screen.getAllByTestId('task-tag').length, 2);
});
