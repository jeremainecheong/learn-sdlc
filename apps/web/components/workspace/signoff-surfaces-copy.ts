import { andList, type PhaseStatus, type PhaseTaskView } from '@learnsdlc/shared';
import { onwardOpens } from './onward-copy';

/**
 * The feedback page's hero on a split
 * phase with one task waiting on the teacher's countersignature and a
 * required sibling still open.
 *
 * The hero does not say "<Phase> is ready to build on." or "This phase passed
 * its evidence review" there, because the phase has not passed. It reads the
 * dashboard's neutral words and names what is still open. The words for a
 * phase whose required tasks
 * all passed or wait stay `signoff-status.ts`'s (AWAITING_SIGN_OFF,
 * SIGN_OFF_PASS_LINE).
 */

/** The hero's heading there: the dashboard's neutral words. */
export const SPLIT_OPEN_HEADLINE = 'Your work passed review.';

/**
 * The hero's line under SPLIT_OPEN_HEADLINE: what is still open, and what
 * opens the next phase, or on the project's last phase (`isLast`) what lets
 * the project be completed. The countersign clause only when a REQUIRED task
 * waits: a waiting optional task does not hold the phase.
 */
export function splitOpenLine(phaseTitle: string, openTitles: readonly string[], countersign = true, isLast = false): string {
  const one = openTitles.length === 1;
  return `Still open in ${phaseTitle}: ${andList([...openTitles])}. ${onwardOpens(isLast)} once ${
    one ? 'it passes' : 'they pass'
  }${countersign ? ' and your teacher countersigns your work' : ''}.`;
}

const waits = (task: PhaseTaskView) => task.status === 'submitted' && task.awaitingSignOff;

/** Whether a REQUIRED task of the phase waits on the countersignature. */
export function requiredTaskWaits(detail: { tasks?: readonly PhaseTaskView[] } | null | undefined): boolean {
  return Boolean(detail?.tasks?.some((task) => task.required && waits(task)));
}

/** The phase's required tasks that neither passed nor wait on the countersignature. */
export function openRequiredTasks(
  detail: { status?: PhaseStatus; tasks?: readonly PhaseTaskView[] } | null | undefined,
): PhaseTaskView[] {
  if (!detail?.tasks || detail.status === 'passed') return [];
  return detail.tasks.filter((task) => task.required && task.status !== 'passed' && !waits(task));
}

/**
 * The required tasks still open on a split phase where another task waits on
 * the countersignature: neither passed nor waiting. Empty on a one-task phase,
 * a passed phase, a phase with no task waiting, and a phase whose required
 * tasks all passed or wait (that one reads the sign-off words instead).
 */
export function openRequiredWhileWaiting(
  detail: { status?: PhaseStatus; tasks?: readonly PhaseTaskView[] } | null | undefined,
): PhaseTaskView[] {
  const tasks = detail?.tasks;
  if (!detail || !tasks || tasks.length < 2 || detail.status === 'passed') return [];
  if (!tasks.some(waits)) return [];
  return openRequiredTasks(detail);
}
