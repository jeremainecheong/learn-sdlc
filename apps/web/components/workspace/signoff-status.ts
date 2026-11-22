import type { PhaseDetail, PhaseStatus, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';

/**
 * A task whose review passed and that now waits on a
 * teacher's countersignature.
 *
 * A teacher can mark a task "Needs your sign-off". A passing verdict on such a
 * task does not pass it: the row stays `submitted` and the API sets
 * `awaitingSignOff` (`taskRollup`), so the next phase stays shut until the
 * teacher countersigns. `submitted` is also where a refused verdict leaves a
 * task, so a learner surface that read `submitted` as "Needs revision" would
 * tell a learner whose work had passed to revise it, and invite a resubmit
 * that costs a review. These are the words and the one test those surfaces
 * share. After the countersignature the task is `passed` and every surface
 * reads it as passed.
 */

/** The task chip while the countersignature is pending. */
export const AWAITING_SIGN_OFF = "Awaiting your teacher's sign-off";

/** Teacher credit without a reviewed pass, in the state words; `STATE_LABEL.credited` is this. */
export const CREDIT_AWARDED = 'Credit awarded, review still needed';

/** The Review view's Pass line on a task awaiting the countersignature. */
export const SIGN_OFF_PASS_LINE = "Your work passed review. Your teacher's countersignature opens the next phase.";

/**
 * The same line on the project's last phase (`isLastPhase`), where no phase
 * follows: the countersignature passes the phase, and the learner's own
 * "Complete the project" (Merge on the pull request) is what completes it
 * (`advance()` marks the enrolment complete).
 */
export const SIGN_OFF_LAST_PASS_LINE =
  "Your work passed review. Your teacher's countersignature passes this last phase; then you can complete the project.";

/** The Pass line while the countersignature is pending, by whether the phase is the project's last. */
export function signOffPassLine(isLast: boolean): string {
  return isLast ? SIGN_OFF_LAST_PASS_LINE : SIGN_OFF_PASS_LINE;
}

/** Why "Submit for review" is off while the countersignature is pending. */
export const SIGN_OFF_SUBMIT_REASON =
  "Your work passed review and is waiting for your teacher's sign-off, so there is nothing to resubmit.";

/**
 * Why "Submit for review" is off while
 * a newer revision of the task is still queued or being reviewed. The API
 * holds one revision in flight per task and will not countersign while a newer
 * one is queued or running, so a press could not land; the room says so.
 */
export const REVISION_IN_FLIGHT_REASON =
  'Your last revision is still being reviewed, so nothing more can be handed in until its verdict is in.';

/**
 * How old a queued or running revision may be before the API's next submit
 * writes it off (`IN_FLIGHT_MAX_AGE_MS` in the feedback service): a row nobody
 * is running must not hold the task shut for ever. Past this age Submit is on
 * again, so the press that frees the slot can be made (with a durable queue the
 * API answers it with the revision still in flight).
 */
export const IN_FLIGHT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The chip tone while the countersignature is pending: neither the revision
 * tone (accent) nor the Pass tone, because the work passed and the phase has
 * not.
 */
export const SIGN_OFF_TONE = 'neutral' as const;

type Held = { tasks?: readonly PhaseTaskView[] } | null | undefined;

/** The revision a surface holds, where it holds one: the verdict that may have just landed. */
export type HeldRevision = Pick<SubmissionView, 'id' | 'status' | 'passed' | 'createdAt'> & { taskKey?: string };

/**
 * The task a surface is about: the named one, or the phase's one task where it
 * has exactly one. On a split phase with no task named there is no one task,
 * and the answer is no.
 */
function taskOf(detail: Held, taskKey?: string | null): PhaseTaskView | undefined {
  const tasks = detail?.tasks;
  if (!tasks?.length) return undefined;
  if (taskKey) {
    const named = tasks.find((task) => task.key === taskKey);
    if (named) return named;
  }
  return tasks.length === 1 ? tasks[0] : undefined;
}

/**
 * Whether the task (the named one, or the phase's one task) passed its review
 * and waits on the teacher's countersignature: `submitted` with
 * `awaitingSignOff`. A payload without tasks, a phase with several and no task
 * named, and a countersigned (`passed`) task all answer false, so those
 * surfaces read exactly as they did.
 */
export function awaitingSignOff(detail: Held, taskKey?: string | null, latest?: HeldRevision | null): boolean {
  const task = taskOf(detail, taskKey);
  if (!task || task.status === 'passed') return false;
  if (task.awaitingSignOff && task.status === 'submitted') return true;
  return verdictAwaits(task, latest);
}

/**
 * The moment a verdict lands. The room holds the new passing revision before
 * the reload brings the task's flag, and a failed reload would leave it there:
 * "Continue" and a live Submit for a task that is waiting. A task the teacher
 * marked (its evidence is 'signed-off') that is not passed, with a passing
 * revision newer than the one its row knows, waits: a pass on a marked task
 * never passes it (`taskRollup`). Once the row knows that revision, or the task
 * was started over after it, the row's own flag is the answer.
 */
function verdictAwaits(task: PhaseTaskView, latest: HeldRevision | null | undefined): boolean {
  if (!latest || task.evidence !== 'signed-off') return false;
  if (latest.status !== 'completed' || latest.passed !== true) return false;
  if (latest.taskKey && latest.taskKey !== task.key) return false;
  if (!latest.id || latest.id === task.lastSubmissionId) return false;
  if (task.resetAt && !(Date.parse(latest.createdAt) > Date.parse(task.resetAt))) return false;
  return true;
}

const queuedOrRunning = (revision: HeldRevision) => revision.status === 'queued' || revision.status === 'running';

/**
 * How long until a revision in flight is old enough for the API to write off;
 * 0 once it is. A timestamp that cannot be read counts as new, as the API's own
 * age reading does.
 */
export function inFlightAgesOutIn(revision: Pick<HeldRevision, 'createdAt'>, now: number = Date.now()): number {
  const created = Date.parse(revision.createdAt);
  if (!Number.isFinite(created)) return IN_FLIGHT_MAX_AGE_MS;
  return Math.max(0, created + IN_FLIGHT_MAX_AGE_MS - now);
}

/**
 * The task's newest revision while it
 * is still queued or being reviewed, so Submit has nothing it could hand in;
 * null otherwise.
 *
 * `latest` is the revision the room holds; `read` is the phase read's own
 * newest revision, where the room has one. A revision another task answers
 * (a split phase holds one in flight per task) does not hold this task's
 * Submit. A queued copy the room kept is not in flight once a read of the same
 * revision, or of a newer one for the task, says a verdict is in, so a stale
 * copy never leaves Submit off. Nor is one past the API's age-out window: the
 * next submit is what writes it off.
 */
export function pendingRevision(
  latest: HeldRevision | null | undefined,
  taskKey?: string | null,
  read?: HeldRevision | null,
  now: number = Date.now(),
): HeldRevision | null {
  const mine = [latest, read].filter(
    (revision): revision is HeldRevision => Boolean(revision) && !(taskKey && revision!.taskKey && revision!.taskKey !== taskKey),
  );
  return (
    mine.find(
      (revision) =>
        queuedOrRunning(revision) &&
        inFlightAgesOutIn(revision, now) > 0 &&
        !mine.some(
          (other) =>
            !queuedOrRunning(other) && (other.id === revision.id || Date.parse(other.createdAt) > Date.parse(revision.createdAt)),
        ),
    ) ?? null
  );
}

/** Whether `pendingRevision` holds one: the rooms' Submit gate. */
export function revisionInFlight(
  latest: HeldRevision | null | undefined,
  taskKey?: string | null,
  read?: HeldRevision | null,
  now: number = Date.now(),
): boolean {
  return pendingRevision(latest, taskKey, read, now) !== null;
}

/**
 * Why nothing is handed in while a proposal operation runs on a document page
 * that holds the assistant in both of its modes (every code phase's): the
 * operation reads and writes the saved
 * workspace, and a submission taken in the middle of one could be reviewed
 * against the files from before the Apply. The design room holds its Submit
 * for the same reason.
 */
export const PROPOSAL_HOLD_REASON = 'The assistant is working on a proposal. Submit when it has finished.';
/**
 * The same hold on a page's other run of the saved files (the incident
 * drill's Start the drill and Run the selfcheck, which read the saved
 * workspace a proposal operation may be about to change).
 */
export const PROPOSAL_HOLD_RUN_REASON = 'The assistant is working on a proposal. Run this when it has finished.';
/** The same hold on the incident drill's Declare resolved, which is neither a Submit nor a run. */
export const PROPOSAL_HOLD_RESOLVE_REASON = 'The assistant is working on a proposal. Declare the incident resolved when it has finished.';
/**
 * The proposal was applied, but the page's own read of the phase after it
 * failed (the mentor offers "Retry workspace refresh"). Until that read lands,
 * the page holds what it held while the proposal ran, with these words: it is
 * no longer waiting for the assistant, it is waiting for the learner to retry.
 */
export const READ_BACK_HOLD_REASON = 'The proposal was applied, but this page has not read it back. Choose Retry workspace refresh in the mentor, then submit.';
export const READ_BACK_HOLD_RUN_REASON = 'The proposal was applied, but this page has not read it back. Choose Retry workspace refresh in the mentor, then run this.';
export const READ_BACK_HOLD_RESOLVE_REASON = 'The proposal was applied, but this page has not read it back. Choose Retry workspace refresh in the mentor, then declare the incident resolved.';
/** The page's own sentence in that state, drawn where the mentor may be hidden. */
export const READ_BACK_NOTICE = 'The proposal was applied to your saved workspace, but this page could not read it back. Choose Retry workspace refresh in the mentor (Show mentor if it is hidden). Until then nothing that hands in or changes your saved work is started from this page.';

/**
 * Why a room's Submit is off, or nothing when it is on as far as these two
 * answers go: the countersignature first, then a
 * revision in flight.
 */
export function submitOffReason(awaiting: boolean, revisionPending: boolean): string | undefined {
  if (awaiting) return SIGN_OFF_SUBMIT_REASON;
  return revisionPending ? REVISION_IN_FLIGHT_REASON : undefined;
}

/**
 * A phase-level surface (a room's verdict chip, the matrix card, the phase
 * card) on a phase whose countersignature is the one thing missing: every
 * required task passed or waits, and at least one waits. On a phase with one
 * task this is exactly `awaitingSignOff(detail)`; a passed phase, a phase with
 * a required task still open, and a phase with none waiting answer false.
 */
export function phaseAwaitingSignOff(detail: (Held & { status?: PhaseStatus }) | null | undefined): boolean {
  const tasks = detail?.tasks;
  if (!detail || !tasks?.length || detail.status === 'passed') return false;
  if (tasks.length === 1) return awaitingSignOff(detail);
  const waits = (task: PhaseTaskView) => task.status === 'submitted' && task.awaitingSignOff;
  return tasks.some(waits) && tasks.every((task) => !task.required || task.status === 'passed' || waits(task));
}

/**
 * Whether the dashboard's latest review is one whose phase waits on the
 * countersignature. The review history carries no task key, so the line speaks
 * for the phase: every required task passed or waits and one waits (the e2e
 * journey's split Requirements phase included). On a one-task phase a passing
 * review newer than the held list knows counts too, as in the room.
 */
export function reviewAwaitsSignOff(detail: (Held & { status?: PhaseStatus }) | null | undefined, review: HeldRevision): boolean {
  if (phaseAwaitingSignOff(detail)) return true;
  return detail?.tasks?.length === 1 && awaitingSignOff(detail, undefined, review);
}

/**
 * The dashboard's "Your latest feedback" line. A refused review keeps the
 * ordinary words; a passing one never asks for a revision, and one waiting on the
 * countersignature says what it opens: the next phase, or on the project's
 * last phase (`isLast`) the way to complete the project.
 */
export function latestFeedbackLine(phaseTitle: string, passed: boolean, awaiting: boolean, isLast = false): string {
  if (!passed) return `${phaseTitle}: open the original review and choose your next revision.`;
  if (!awaiting) return `${phaseTitle}: your work passed review. Open it to see the evidence it accepted.`;
  return isLast
    ? `${phaseTitle}: your work passed review. Your teacher's countersignature passes this last phase; then you can complete the project.`
    : `${phaseTitle}: your work passed review. Your teacher's countersignature opens the next phase.`;
}

/**
 * A phase-level room's verdict chip (the change room's): its word and tone.
 *
 * `credited` is the gate's answer (`isCredited` in gate-state.ts, read by the
 * caller): a phase passed on the board by a teacher's credit with no reviewed
 * pass behind it reads as credit, never "Pass".
 */
export function changeRoomChip(
  detail: Pick<PhaseDetail, 'status' | 'attempts'> & { tasks?: readonly PhaseTaskView[] },
  credited = false,
): { label: string; tone: 'pass' | 'accent' | 'warn' | typeof SIGN_OFF_TONE } {
  const status: PhaseStatus = detail.status;
  if (status === 'passed' && credited) return { label: CREDIT_AWARDED, tone: 'warn' };
  if (status === 'passed') return { label: 'Pass', tone: 'pass' };
  if (phaseAwaitingSignOff(detail)) return { label: AWAITING_SIGN_OFF, tone: SIGN_OFF_TONE };
  return { label: detail.attempts > 0 ? 'Needs revision' : 'Not submitted', tone: 'accent' };
}
