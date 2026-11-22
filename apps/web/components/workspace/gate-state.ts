import type { PhaseEvidenceGap, PhaseStatus, PhaseTaskView } from '@learnsdlc/shared';
import { AWAITING_SIGN_OFF, CREDIT_AWARDED } from './signoff-status';

/**
 * The learner's state words, the same everywhere a state is named:
 * the phase header's chip, the gate band's label and a task row.
 *
 * Six states, kept apart because they look alike and are not:
 *
 * - a **reviewed pass** (the review passed the work);
 * - **teacher credit** (a Mark as passed or a sign-off wrote the board as
 *   passed with no reviewed pass behind it; the strict-evidence gate still
 *   wants one, so the next phase does not open on it);
 * - a reviewed pass **waiting for the countersignature**;
 * - every prerequisite met, so Continue is open;
 * - a review that came back **Needs revision**;
 * - work that is open or being worked.
 *
 * The words are labels only. What opens a phase is the API's gate, and none
 * of these reads it differently from the rooms that already did.
 */
export const STATE_LABEL = {
  reviewPassed: 'Review passed',
  credited: CREDIT_AWARDED,
  awaiting: AWAITING_SIGN_OFF,
  ready: 'Ready to continue',
  revise: 'Needs revision',
  inProgress: 'In progress',
} as const;

export type LearnerState = keyof typeof STATE_LABEL;

/** The chip tone for each state, from the tones the chips already have. */
export const STATE_TONE: Record<LearnerState, 'pass' | 'warn' | 'neutral' | 'accent' | 'outline'> = {
  reviewPassed: 'pass',
  ready: 'pass',
  credited: 'warn',
  awaiting: 'neutral',
  revise: 'accent',
  inProgress: 'outline',
};

/** What the band says under "Credit awarded, review still needed": the sentence the gate banner has always said. */
export const CREDIT_EXPLANATION = 'Passed on the board, not yet reviewed';

type GatePhase = {
  status: PhaseStatus | string;
  key?: string;
  evidenceNeeded?: PhaseEvidenceGap[];
  notReachedYet?: true;
};

/** A gap named in another phase (the last phase's completion arm), by id or key. */
export function gapInAnotherPhase(gap: PhaseEvidenceGap, phaseId: string, phaseKey?: string): boolean {
  return Boolean((gap.phaseId && gap.phaseId !== phaseId) || (gap.phaseKey && phaseKey && gap.phaseKey !== phaseKey));
}

/**
 * The tasks of this phase that are credited without a reviewed pass.
 *
 * The one source both the task rows and the gate band read: the API's own
 * `evidenceNeeded`, the strict-evidence gate's predicate. A task whose key it
 * names is passed on the board and still wants a review of its own; a passed
 * task it does not name has a reviewed pass. A gap in another phase is not
 * this phase's, and is left out.
 */
export function creditedTaskKeys(phaseId: string, phase: GatePhase | null | undefined): Set<string> {
  const gaps = phase?.evidenceNeeded?.filter(Boolean) ?? [];
  return new Set(gaps.filter((gap) => !gapInAnotherPhase(gap, phaseId, phase?.key)).map((gap) => gap.key));
}

/**
 * Where the room's phase (or the task the room is working in) stands, in the
 * vocabulary above.
 *
 * `awaiting` is the room's own reading of the countersignature
 * (`awaitingSignOff`), and `verdict` the newest settled review the room holds
 * for its task. Neither changes what the gate accepts.
 */
export function learnerState(
  phaseId: string,
  phase: GatePhase,
  room: {
    awaiting?: boolean;
    verdict?: { status: string; passed?: boolean | null } | null;
    /** The task this room works in, on a phase with a task list. */
    task?: Pick<PhaseTaskView, 'key' | 'status'> | null;
  } = {},
): LearnerState {
  // A countersignature still awaited holds the room only while the phase has
  // not passed. On a passed phase the gate's own answer below decides: an
  // optional task waiting on its sign-off, or the instant between a verdict
  // and its read, must not hide a Continue the gate allows.
  if (room.awaiting && phase.status !== 'passed') return 'awaiting';
  const credited = creditedTaskKeys(phaseId, phase);
  if (phase.status === 'passed') {
    if (credited.size > 0 || (phase.notReachedYet && (phase.evidenceNeeded?.length ?? 0) > 0)) return 'credited';
    // Every gap named elsewhere (the completion arm) still holds Continue shut.
    if ((phase.evidenceNeeded?.length ?? 0) > 0) return 'reviewPassed';
    return phase.notReachedYet ? 'reviewPassed' : 'ready';
  }
  const verdict = room.verdict;
  // A task passed on the board in a phase that has not passed. The teacher's
  // per-task sign-off can write that with no review behind it, and the gate's
  // `evidenceNeeded`, which would name it, is served only once the phase has
  // passed. "Review passed" is said only where the gate's answer is held, so
  // here the phase is what it is, in progress: never a review, never a
  // refusal (a sign-off over a failed verdict is not "Needs revision").
  if (room.task?.status === 'passed') return 'inProgress';
  // A revision still being reviewed is work in progress, not a refusal.
  if (verdict && (verdict.status === 'queued' || verdict.status === 'running')) return 'inProgress';
  if (verdict && verdict.status === 'completed') return verdict.passed ? 'reviewPassed' : 'revise';
  if (room.task?.status === 'submitted') return 'revise';
  return 'inProgress';
}

/**
 * Whether a passed task (or, with no key, the phase's one task) is credited
 * rather than reviewed: the same `evidenceNeeded` the gate band and
 * the task rows read, so every place that names the task's state agrees with
 * the band. False on a phase that has not passed: the gate answers only for a
 * passed phase. It decides no gate; it only picks the words.
 */
export function isCredited(
  phaseId: string,
  phase: GatePhase | null | undefined,
  taskKey?: string | null,
): boolean {
  if (!phase || phase.status !== 'passed') return false;
  if (taskKey) return creditedTaskKeys(phaseId, phase).has(taskKey);
  return learnerState(phaseId, phase) === 'credited';
}

/** "Phase 4 of 6", from the place and count the phase detail carries. */
export function phasePlace(place?: number | null, count?: number | null): string | null {
  return place && count ? `Phase ${place} of ${count}` : null;
}
