/**
 * The Maintenance builder's pure half: which task it edits, which steps are
 * done, which rubric keys the grader scores itself, the change body the
 * server holds, the sentences it asks and refuses with (the contract switch
 * over a non-empty starting list, a ticket edit that drops a covered id) and
 * the publish warning (the starting record that already meets the floor).
 * Nothing here touches React, the network or the DOM.
 */
import {
  FIXED_SCORER_KEYS,
  evaluateChangeFloor,
  nextItemId,
  pluralWord,
  serialiseChangeRequest,
  ticketCoveredRefusal,
  validateChangeRequestRecord,
  type ChangeChecksBody,
  type ChangeFloorSpec,
  type ChangeTicket,
  type DraftPhaseView,
  type DraftTaskView,
  type TaskMutationResult,
  type UpdateTaskBody,
} from '@learnsdlc/shared';
import { WEIGHT_TOLERANCE } from '../requirements/builder-model';

export const MAINTENANCE_STEP_LABELS = ['Brief', 'Ticket', 'Code and runs', 'Change request', 'Criteria'] as const;

/** The four keys the grader scores itself on a code phase: their key and removal are locked. */
export const LOCKED_MAINTENANCE_KEYS = FIXED_SCORER_KEYS.code;

/** The publish warning when the starting record already meets the floor; it never refuses. */
export const STARTING_CHANGE_MEETS_FLOOR =
  'The starting change request already meets the floor, so a learner who changes nothing passes it. Raise the floor or empty the starting record.';

/** The line the builder shows on a task still in the older format, editable and read-only. */
export const CHANGE_OLDER_FORMAT_NOTICE =
  'This task is in the older format. Saving the brief, the ticket, the change request floor or the criteria converts it.';
export const CHANGE_OLDER_FORMAT_NOTICE_READONLY = 'This task is in the older format.';

/**
 * The task the builder edits on this phase, or null where the editor keeps
 * its generic panels: Maintenance's one code task, when the payload carries
 * its change view (a task still in the older format carries the read-time
 * view). A concept quiz beside it keeps its own row. A read-only draft draws
 * the builder without inputs, so the task is the builder's either way.
 */
export function maintenanceBuilderTask(phase: DraftPhaseView, _editable: boolean): DraftTaskView | null {
  if (phase.key !== 'maintenance') return null;
  const work = phase.tasks.filter((one) => one.checkKind !== 'quiz' && !one.quiz);
  return work.length === 1 && work[0].checkKind === 'code' && work[0].change ? work[0] : null;
}

/**
 * Which of the five steps are done: Brief has an intro and a title; Ticket
 * has a title, a summary and an acceptance line; Code and runs always;
 * Change request once saved (a structured task's is; an older one only after
 * its first save); Criteria has weights summing to 1 and at least one
 * criterion beside the four fixed keys.
 */
export function maintenanceStepsDone(phase: DraftPhaseView, task: DraftTaskView, saved: { change: boolean }): boolean[] {
  const ticket = task.change?.ticket;
  const criteria = task.rubric?.criteria ?? [];
  const sum = criteria.reduce((total, one) => total + one.weight, 0);
  const locked: readonly string[] = LOCKED_MAINTENANCE_KEYS;
  return [
    phase.intro.trim().length > 0 && task.title.trim().length > 0,
    Boolean(ticket && ticket.title.trim() && ticket.summary.trim() && ticket.acceptance.length > 0),
    true,
    saved.change || (Boolean(task.change) && !task.recordOlderFormat),
    Math.abs(sum - 1) <= WEIGHT_TOLERANCE && criteria.some((one) => !locked.includes(one.key)),
  ];
}

/** The change body the task carries (the converted switch and floor on a task still in the older format). */
export function changeBodyOf(task: DraftTaskView): ChangeChecksBody {
  return { contract: task.change!.contract, floor: { ...task.change!.floor } };
}

/** The change body the server holds on this task, or null on one still in the older format (or none). */
export function savedChangeBody(task: DraftTaskView | undefined): ChangeChecksBody | null {
  return task?.change && !task.recordOlderFormat ? changeBodyOf(task) : null;
}

/**
 * A save that writes the task through the builder's one queue: given the
 * change body the server holds when its turn comes (null on a task still in
 * the older format), the body to send.
 */
export type MaintenanceTaskWrite = (build: (held: ChangeChecksBody | null) => UpdateTaskBody) => Promise<TaskMutationResult>;

/** The confirm line before switching the contract off over a starting record that declares amendments, or null. */
export function contractOffConfirm(startingText: string | null): string | null {
  const n = startingText ? validateChangeRequestRecord(startingText, null).change?.contract.length ?? 0 : 0;
  return n > 0 ? `Switching this off deletes the ${n} contract ${pluralWord(n, 'amendment')} in the starting change request.` : null;
}

/**
 * The record's bytes as the files door stores them while the contract is
 * off: without contract amendments (the door drops them). Bytes that do not
 * read, or declare none, come back as they are.
 */
export function withoutAmendments(text: string): string {
  const read = validateChangeRequestRecord(text, null).change;
  return read && read.contract.length > 0 ? serialiseChangeRequest({ ...read, contract: [] }) : text;
}

/** The door's refusal for a ticket that drops an acceptance id the starting record covers, or null. */
export function ticketEditProblem(next: ChangeTicket, startingText: string | null): string | null {
  const read = startingText ? validateChangeRequestRecord(startingText, null).change : null;
  if (!read) return null;
  const ids = new Set(next.acceptance.map((one) => one.id));
  const dropped = [...read.tests.flatMap((one) => one.covers), ...read.release.changes.flatMap((one) => one.covers)].find((id) => !ids.has(id));
  return dropped === undefined ? null : ticketCoveredRefusal(dropped);
}

/** The publish warning when the starting record already passes every floor check, or null. */
export function startingChangeWarning(startingText: string, spec: ChangeFloorSpec): string | null {
  return evaluateChangeFloor(startingText, spec).every((one) => one.passed) ? STARTING_CHANGE_MEETS_FLOOR : null;
}

/** The next free acceptance id: 'AC-1', then one past the highest number, by the shared minting rule. */
export function nextAcceptanceId(ticket: ChangeTicket): string {
  return nextItemId(ticket.acceptance.map((one) => one.id), 'AC-');
}
