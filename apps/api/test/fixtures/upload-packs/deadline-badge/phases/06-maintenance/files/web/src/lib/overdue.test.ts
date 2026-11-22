/**
 * Tests for the overdue badge. `test` and `assert` are globals the runner
 * provides; `assert` is Node's own.
 */
import { isOverdue } from './overdue';
import type { Task } from './types';

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const assert: typeof import('node:assert');

const TODAY = '2026-11-13';

function task(dueDate: string | null, done = false): Task {
  return { title: 'Send the report', dueDate, done };
}

test('a task due yesterday is overdue', () => {
  assert.strictEqual(isOverdue(task('2026-11-12'), TODAY), true);
});

test('a task due today is not overdue', () => {
  assert.strictEqual(isOverdue(task('2026-11-13'), TODAY), false);
});
