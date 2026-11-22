/**
 * What kind of pass a phase holds, as the API's board says it
 * (`EnrollmentView.phases[].passKind`, written by `passKindOf` in
 * `apps/api/src/workflow/strict-gate.ts`, the gate's own predicate).
 *
 * - `reviewed`: every required task has its reviewed pass.
 * - `credit`: a teacher's Mark as passed or sign-off wrote the board as passed
 *   with no reviewed pass behind it. The next phase does not open on it.
 *
 * Present only on a passed phase; a phase without it is never read as a
 * credit. Typed here rather than in the shared package; words only, never a
 * gate.
 */
import { STATE_LABEL, type LearnerState } from '@/components/workspace/gate-state';

export type PassKind = 'reviewed' | 'credit';

/**
 * On a credit, a required task the gate still wants, by its key;
 * `awaitsSignOff` where its review passed and only the teacher's
 * countersignature is missing.
 */
export type CreditTask = { key: string; awaitsSignOff?: boolean };

/** A phase as the board sends it, with the optional `passKind` (and, on a credit, `creditTasks`). */
export type WithPassKind = { status: string; passKind?: PassKind; creditTasks?: CreditTask[] };

/** A passed phase the API names as a teacher's credit without a reviewed pass. */
export function isCreditOnly(phase: WithPassKind): boolean {
  return phase.status === 'passed' && phase.passKind === 'credit';
}

/**
 * The state a credit is said in: `awaiting` where every task the gate still
 * wants has passed its review and waits only on the countersignature
 * ("Awaiting your teacher's sign-off"), else `credited` ("Credit awarded,
 * review still needed"). A payload with no `creditTasks` reads `credited`.
 */
export function creditState(phase: WithPassKind): Extract<LearnerState, 'credited' | 'awaiting'> {
  const tasks = phase.creditTasks ?? [];
  return tasks.length > 0 && tasks.every((task) => task.awaitsSignOff === true) ? 'awaiting' : 'credited';
}

/** The words for a credit: {@link creditState}'s label in the state vocabulary. */
export function creditLabel(phase: WithPassKind): string {
  return STATE_LABEL[creditState(phase)];
}

/**
 * Whether a revision's pass is a current one on a credited phase: its task is
 * not one the gate still wants, or it is one waiting only on the
 * countersignature (its review passed). A revision with no task key (a sole
 * task, whose phase-wide credit names that one task) is not.
 */
export function revisionPassIsCurrent(phase: WithPassKind, taskKey: string | undefined): boolean {
  if (!taskKey || !phase.creditTasks) return false;
  const wanted = phase.creditTasks.find((task) => task.key === taskKey);
  return !wanted || wanted.awaitsSignOff === true;
}
