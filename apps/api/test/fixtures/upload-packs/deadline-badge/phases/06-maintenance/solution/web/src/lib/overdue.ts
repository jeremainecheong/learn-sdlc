import type { Task } from './types';

// seal marker: DEADLINE-SEALED-SOLUTION-4C6E (the change request's reference answer)

/**
 * Whether a task shows the overdue badge on the given day.
 * Both dates are ISO strings (yyyy-mm-dd), so they compare as text.
 */
export function isOverdue(task: Task, today: string): boolean {
  if (task.done || task.dueDate === null) {
    return false;
  }
  // A task is overdue when its due date is before today.
  return task.dueDate < today;
}
