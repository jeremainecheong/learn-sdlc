// seal marker: DEADLINE-SEALED-REFERENCE-6W4N (the reference suite)
// It lands in the workspace beside web/src/lib/overdue.ts, which is why the import resolves.
// @ts-ignore -- resolved in the learner's workspace
import { isOverdue } from './overdue';

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const assert: typeof import('node:assert');

const TODAY = '2026-11-13';
const task = (dueDate: string | null) => ({ title: 'Send the report', dueDate, done: false });

test('a task due yesterday is overdue', () => {
  assert.strictEqual(isOverdue(task('2026-11-12'), TODAY), true);
});

test('a task due today is not overdue', () => {
  assert.strictEqual(isOverdue(task('2026-11-13'), TODAY), false);
});

test('a task due tomorrow is not overdue', () => {
  assert.strictEqual(isOverdue(task('2026-11-14'), TODAY), false);
});

test('a task with no due date is not overdue', () => {
  assert.strictEqual(isOverdue(task(null), TODAY), false);
});
