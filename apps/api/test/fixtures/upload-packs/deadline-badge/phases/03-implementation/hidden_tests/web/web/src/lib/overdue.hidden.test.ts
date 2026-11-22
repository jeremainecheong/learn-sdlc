// seal marker: DEADLINE-SEALED-HIDDEN-7Q2M (the Implementation phase's hidden suite)
// A sealed suite is imported from outside the workspace, so it loads the helper by workspace path.
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const assert: typeof import('node:assert');

const { isOverdue } = require(`${process.cwd()}/web/src/lib/overdue`);

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
