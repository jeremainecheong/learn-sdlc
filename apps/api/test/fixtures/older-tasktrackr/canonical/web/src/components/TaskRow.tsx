/**
 * One task, as a row.
 *
 * This component calls isOverdue but does not know the rule, and that is the
 * point: the boundary is written once, in web/src/lib/overdue.ts, and every
 * screen that needs it asks the same function.
 */

import type { ReactNode } from 'react';
import { OverdueBadge } from './OverdueBadge';
import { daysLate, isOverdue } from '../lib/overdue';
import type { Task } from '../api/types';

export interface TaskRowProps {
  task: Task;
  /** The day the screen is being read on, as an ISO date. */
  today: string;
  /** Optional source-list identity where rows span more than one list. */
  sourceList?: ReactNode;
  onComplete?: (task: Task) => void;
  onReopen?: (task: Task) => void;
}

export function TaskRow({ task, today, sourceList, onComplete, onReopen }: TaskRowProps) {
  const late = isOverdue(task, today);
  const done = task.status === 'done';

  return (
    <li
      className={`task-row${done ? ' is-done' : ''}${late ? ' is-late' : ''}`}
      data-testid="task-row"
      data-task-id={task.id}
    >
      <div className="task-main">
        <span className="task-title" data-testid="task-title">
          {task.title}
        </span>
        <span className={`badge badge-${task.priority}`} data-testid="task-priority">
          {task.priority}
        </span>
        {late ? <OverdueBadge days={daysLate(task, today)} /> : null}
        {task.comment_count > 0 ? (
          <span className="badge badge-comments" data-testid="comment-count">
            {task.comment_count === 1 ? '1 comment' : `${task.comment_count} comments`}
          </span>
        ) : null}
      </div>

      <div className="task-meta">
        {sourceList ? <span data-testid="task-source-list">{sourceList}</span> : null}
        {task.due_date ? (
          <span data-testid="task-due">due {task.due_date}</span>
        ) : (
          <span className="muted">no due date</span>
        )}
        {task.tags.map((tag) => (
          <span className="tag" data-testid="task-tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>

      {done ? (
        <button type="button" data-testid="reopen-task" onClick={() => onReopen?.(task)}>
          Reopen
        </button>
      ) : (
        <button type="button" data-testid="complete-task" onClick={() => onComplete?.(task)}>
          Complete
        </button>
      )}
    </li>
  );
}
