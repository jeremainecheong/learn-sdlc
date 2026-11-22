/**
 * The overdue rule, on the client this time (US-4, US-5).
 *
 * The API already knows this rule: GET /api/tasks/overdue applies it in SQL.
 * The badge on a row needs the same answer without a round trip, so the rule
 * lives here as well, as a pure function over data you already have.
 *
 * Two copies of one rule is a risk, not a mistake. It is the reason the
 * testing phase asks you to prove the boundary in both languages: the day the
 * two disagree is the day a task is late in the report and on time on the row.
 */

import type { Task } from '../api/types';

/** Just enough of a task to answer the question. */
export type Dated = Pick<Task, 'due_date' | 'status'>;

/**
 * Whether a task is late as of `today`.
 *
 * A task with no due date is never overdue. A completed task is never
 * overdue, however late it was. A task due today is not yet overdue — the day
 * is not over.
 *
 * Both dates are ISO strings ("2026-03-14"), and ISO dates compare correctly
 * as strings: "2026-03-01" < "2026-03-02". That is why the column is TEXT.
 */
export function isOverdue(task: Dated, today: string): boolean {
  if (!task.due_date) return false;
  return task.due_date < today;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many whole days late a task is, or 0 when it is not overdue at all.
 *
 * The report shows this beside the title, because "late" is a fact and "eleven
 * days late" is a priority.
 */
export function daysLate(task: Dated, today: string): number {
  if (!isOverdue(task, today)) return 0;
  const due = Date.parse(`${task.due_date}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.round((now - due) / MS_PER_DAY);
}

/** The report's order: most overdue first, then higher priority, then id. */
export function byMostOverdue(today: string) {
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return (a: Task, b: Task): number =>
    daysLate(b, today) - daysLate(a, today) ||
    rank[a.priority] - rank[b.priority] ||
    a.id - b.id;
}
