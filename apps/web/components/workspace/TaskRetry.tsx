/**
 * "Retry this task" and "Retry this phase": the reset control's words for a
 * task the learner has already PASSED.
 *
 * A retry is the same plan-and-confirm as "Start this task over", through the
 * same routes (a TaskTrackr phase, whose one task has the empty key, through
 * `GET`/`POST /phases/:id/reset`). It puts the task back to its starting point
 * for a new attempt and keeps the earlier pass, its date, the best score,
 * every attempt, a teacher's signature, the phases opened since and a finished
 * project; the plan's `retry.keeps` says which of those apply, in the API's own
 * sentences, and the task counts as passed again only once a new submission
 * passes the same review.
 *
 * Offered where the API would let it go ahead: a passed task that is not a
 * quiz (a quiz is reset by the teacher), with no teacher review pending, on a
 * phase that is not locked. The API refuses everything else anyway, in one
 * sentence, and that sentence is what the confirm shows.
 */

import type { PhaseTaskView } from '@learnsdlc/shared';
import { DISPLAY_LOCALE } from '@/lib/locale';

/** What the confirm says first about the files, before the API's sentence on what is kept. */
export const RETRY_REPLACES = 'Work you have not submitted is replaced.';
export const RETRY_CONFIRM = 'Retry';
export const RETRY_BUSY = 'Retrying…';
export const RETRY_CHECKING = 'Checking what a retry would change…';
export const RETRY_PLAN_FAILED = 'What a retry would change could not be read. Nothing was changed.';
export const RETRY_FAILED = 'This could not be retried. Nothing was changed.';

/** TaskTrackr's shape: one task, whose key is the empty key the compiler mints. */
export function soleList(tasks: readonly PhaseTaskView[] | undefined): boolean {
  return tasks?.length === 1 && tasks[0].key === '';
}

/** Is this a passed task the learner may retry? The facts the API refuses on, read off the task view. */
export function retryOffered(
  tasks: readonly PhaseTaskView[] | undefined,
  task: PhaseTaskView | undefined,
  phaseStatus?: string,
): boolean {
  if (!task || !tasks?.some((one) => one.key === task.key)) return false;
  if (phaseStatus === 'locked') return false;
  if (task.artefactType === 'quiz') return false;
  if (task.status !== 'passed') return false;
  return !task.awaitingSignOff;
}

/** The control's name: the phase on TaskTrackr, whose one task is the phase, and the task on an authored list. */
export function retryLabel(tasks: readonly PhaseTaskView[] | undefined): string {
  return soleList(tasks) ? 'Retry this phase' : 'Retry this task';
}

/** What the room says once the retry has gone ahead. */
export function retryDone(wholePhase: boolean): string {
  return `${wholePhase ? 'This phase' : 'This task'} is open for a new attempt. Your earlier pass stays in your history.`;
}

/**
 * "14 September", the date the rest of the product writes (`longDate` in
 * `components/solution/derive.ts`). Written here rather than imported: that
 * module pulls in the pull-request barrel, which every room drawing this
 * control would then load.
 */
function passDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(DISPLAY_LOCALE, { day: 'numeric', month: 'long' });
}

/**
 * The lasting line for a task being retried: passed before, not passed now.
 * A retry keeps `passedAt` and puts the status back, and every teacher lever
 * that takes a pass away clears `passedAt` with it, so only a retry leaves a
 * task that is not passed with a pass date. Read off the task view, so it is
 * still said after a reload.
 */
export function retryHistory(task: PhaseTaskView | undefined): string | null {
  if (!task || task.status === 'passed' || !task.passedAt) return null;
  return `Passed on ${passDate(task.passedAt)}. This is a new attempt; it counts again once a new submission passes the same review.`;
}

/** The confirm's sentence on what a retry keeps: the files first, then the API's own words. */
export function RetryKeeps({ keeps }: { keeps: string }) {
  return (
    <p className="mt-3 text-[13px]" data-testid="task-reset-keeps">
      {RETRY_REPLACES} {keeps}
    </p>
  );
}
