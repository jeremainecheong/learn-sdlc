/**
 * The badge that says a task is late (US-5).
 *
 * It renders nothing at all when the task is on time, rather than an empty
 * badge: a row with no badge is the normal case and should look like it.
 */

export interface OverdueBadgeProps {
  /** Whole days past the due date. Zero or less means the task is not late. */
  days: number;
}

export function OverdueBadge({ days }: OverdueBadgeProps) {
  if (days <= 0) return null;
  return (
    <span className="badge badge-overdue" data-testid="overdue-badge">
      {days === 1 ? '1 day late' : `${days} days late`}
    </span>
  );
}
