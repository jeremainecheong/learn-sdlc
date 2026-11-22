/**
 * One task, as a row.
 *
 * This component calls isOverdue but does not know the rule, and that is the
 * point: the boundary is written once, in web/src/lib/overdue.ts, and every
 * screen that needs it asks the same function.
 *
 * CR-2 adds one thing to this file and nothing else. Everything already here
 * works, and the row is on every screen, so a change that reaches further than
 * the badge is a change somebody has to review twice.
 */

import type { ReactNode } from 'react';
import { OverdueBadge } from './OverdueBadge';
import { daysLate, isOverdue } from '../lib/overdue';
import type { Task } from '../api/types';

export interface TaskRowProps {
  task: Task;
  /** The day the screen is being read on, as an ISO date. */
  today: string;
  /** Source-list identity when the report spans multiple lists. */
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
        {/*
          TODO(learner) CR-2: the comment count belongs here.

          A task that carries comments wears a badge reading "1 comment" or
          "4 comments"; a task with none wears nothing at all, because an
          empty badge on every row is noise. The badge the row already wears
          when it is late is the shape to copy: className "badge
          badge-comments", data-testid "comment-count".

          task.comment_count is the number the API sends. It reads 0 while the
          count is not implemented yet in TASK_SELECT.
        */}
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
