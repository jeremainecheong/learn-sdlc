import type { Task } from './types';

/**
 * Whether a task shows the overdue badge on the given day.
 * Both dates are ISO strings (yyyy-mm-dd), so they compare as text.
 */
export function isOverdue(task: Task, today: string): boolean {
  if (task.dueDate === null) {
    return false;
  }
  // A task is overdue when its due date is before today.
  return false; // TODO(learner): replace this line with the rule above.
}
