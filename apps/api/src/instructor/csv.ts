import type { FeedbackReport } from '@learnsdlc/shared';
import { PHASE_ORDER } from '@learnsdlc/shared';

/**
 * The two instructor CSV files' columns and the cells only they write: the
 * appeal file (`CSV_COLUMNS`, one row per learner and phase) and the grade
 * book (`GRADEBOOK_COLUMNS`, one row per learner and project). Every cell of
 * both goes through `csvCell`.
 */

export const CSV_COLUMNS = [
  'email',
  'displayName',
  'cohort',
  'project',
  'phaseKey',
  'status',
  'bestScore',
  'attempts',
  'hints',
  'relianceIndex',
  'passedAt',
  'completed',
  // The three phase-report columns (kill matrix, conformance, drill), read
  // from the latest submission's report. Blank where the phase does not
  // produce them, which is most of them.
  'kill matrix',
  'conformance',
  'drill',
  // Four facts about the newest attempt, appended. They
  // are appended rather than slotted in beside their neighbours on purpose;
  // a spreadsheet or a script reading this file by column position keeps
  // working, and a term of exports stays comparable.
  'packVersion',
  'submittedAt',
  'late',
  'regraded',
] as const;

/**
 * One row per learner and project, one column per phase: the shape a
 * spreadsheet and an LMS actually want, where `CSV_COLUMNS` is the shape an
 * appeal wants. Both go through `csvCell`, so both carry the same
 * formula-injection guard.
 */
export const GRADEBOOK_COLUMNS = [
  'email',
  'displayName',
  'class',
  'project',
  ...PHASE_ORDER,
  'average',
  'gates passed',
  'completed',
  // The two overview numbers, appended at the end for the same reason as the
  // four attempt facts in `CSV_COLUMNS`; the header is the
  // contract a spreadsheet import reads, and a file whose columns move breaks
  // every saved import and makes a term of exports incomparable. Both are read
  // off the **pinned version's** tasks, so `checklist %` is a different
  // question from `gates passed` beside it: gates counts the phase rows this
  // board holds, the checklist counts the required tasks the version declares.
  // `quiz mastery %` is blank where there is no quiz, never `0`; the rule the
  // gradebook export keeps for a phase with no score.
  'checklist %',
  'quiz mastery %',
] as const;

/** Mutants caught over mutants seeded, from the testing phase's kill matrix. */
export function killMatrixCell(
  report: FeedbackReport | null | undefined,
): string {
  const mutation = report?.mutation;
  return mutation ? `${mutation.killed}/${mutation.total}` : '';
}

/** Design-contract claims the code kept, over claims made. */
export function conformanceCell(
  report: FeedbackReport | null | undefined,
): string {
  const claims = report?.contract;
  if (!claims?.length) return '';
  return `${claims.filter((claim) => claim.verdict === 'kept').length}/${claims.length}`;
}

/** The deployment drill in three words: did the fix hold, and was it diagnosed. */
export function drillCell(report: FeedbackReport | null | undefined): string {
  const drill = report?.drill;
  if (!drill) return '';
  if (!drill.passedAfterFix) return 'not fixed';
  return drill.diagnosisNamesFault ? 'fixed and diagnosed' : 'fixed';
}

/**
 * RFC 4180 quoting, plus a guard against formula injection: spreadsheets run
 * a cell beginning with = + - @ as a formula, and display names come straight
 * from the sign-up form, so a learner called "=HYPERLINK(...)" would execute
 * in the instructor's Excel. The apostrophe makes the cell literal text.
 */
export function csvCell(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
