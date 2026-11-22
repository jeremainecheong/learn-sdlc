/**
 * The learner's task reset and retry: the plan, the input and the result.
 */

import type { PhaseTaskView } from './phase-detail';

/* -------------------------- the learner's task reset ------------------------
 *
 * "Start this task over", on an authored task list. A learner resets one
 * task of theirs; the plan route says first, in full, what the reset would
 * do, and the reset route does exactly that or refuses in one sentence.
 * Nothing a learner submitted is deleted and no attempt count moves: the
 * task's reset count rises by one, and every revision made before it is of an
 * earlier run (`CohortExportSubmission.resetEpoch`). On a task that has passed
 * (or a TaskTrackr phase that has) the same two routes are "Retry this task"
 * (or "Retry this phase"), and the plan carries `retry`.
 * ------------------------------------------------------------------------- */

/** A path the reset keeps, because a sibling task that shares it has passed. */
export interface TaskResetProtectedPath {
  path: string;
  /** The learner-visible title of the passed sibling task that keeps it. */
  siblingTitle: string;
}

/**
 * `GET /phases/:id/tasks/:taskKey/reset`: what a reset of this task would do,
 * so the confirm names it before the learner presses anything.
 */
export interface TaskResetPlanView {
  /** Paths whose learner copy is deleted, so the pinned version's starter is what they read again. */
  restores: string[];
  /** Paths the server seeds: deleted, then seeded again from the pinned version. */
  reseeds: string[];
  /** Paths a passed sibling task shares, kept as they are. */
  protectedBy: TaskResetProtectedPath[];
  /**
   * A pending Agentic proposal for **any** task of this phase is dropped by
   * the reset, because its approval is bound to every editable file of the
   * phase. The confirm says so first.
   */
  dropsPendingProposal: boolean;
  /** The one sentence the reset would be refused with, or null when it would go ahead. */
  refusal: string | null;
  /**
   * Set when the task has passed: the reset is then a **retry** of completed
   * work, and null on a plain start-over. A retry puts the task back to its
   * starting point for a new attempt and keeps every earlier submission, the
   * earlier pass and its date, the best score, the attempt count, a teacher's
   * signature and the project's completion record; the task counts as passed
   * again only once a new submission passes the same review.
   */
  retry: TaskRetryPlan | null;
}

/** What the confirm says about a retry (`TaskResetPlanView.retry`). */
export interface TaskRetryPlan {
  /**
   * True on a sole-task phase (TaskTrackr's), whose one task is the phase:
   * the confirm says "Retry this phase" rather than "Retry this task".
   */
  wholePhase: boolean;
  /** What the retry keeps and when the task counts again, in the API's own sentences. */
  keeps: string;
}

/**
 * `POST /phases/:id/tasks/:taskKey/reset`'s body, and its only key: the
 * workspace version the tab last loaded (`PhaseDetail.workspaceUpdatedAt`),
 * null for a workspace never saved. A version that has moved on is a 409
 * with the body a stale save gets, and nothing is written.
 */
export interface ResetTaskInput {
  baseVersion: string | null;
}

/**
 * What the reset answers: the new workspace version for the tab to adopt,
 * the workspace as it now stands, and the task's own view.
 */
export interface TaskResetResult {
  version: string;
  workspace: Record<string, string>;
  task: PhaseTaskView;
}
