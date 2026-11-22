import type { Task } from './types';

// seal marker: DEADLINE-SEALED-SOLUTION-5V1A (the Implementation phase's reference answer)

/**
 * Whether a task shows the overdue badge on the given day.
 * Both dates are ISO strings (yyyy-mm-dd), so they compare as text.
 */
export function isOverdue(task: Task, today: string): boolean {
  if (task.dueDate === null) {
    return false;
  }
  // A task is overdue when its due date is before today.
  return task.dueDate < today;
}
