/**
 * Bounded, learner-owned evidence for the explanation assessor.
 *
 * Without these records, a learner's true sentences, that INCIDENT-1 matched
 * the resolved drill, or that they had edited one sentence of the proposal,
 * can come back labelled `contradicted`, because the drill record is not in
 * the assessor's context and the sentence cannot be checked. This module
 * reduces the records the learner's own work
 * wrote, the deployment drill, their recent Run results, their own edit of the
 * proposal, to the smallest set of facts that makes a statement about them
 * checkable instead of invisible.
 *
 * Three rules govern everything here:
 *
 * 1. **Never anything that makes approval easier.** No grading submission, no
 *    verdict, no score, no phase status, and none of the learner's own prose
 *    (their incident write-up, their runbook bytes). Reading a learner's own
 *    words back to the assessor would let them earn a dimension by restating
 *    what they typed earlier.
 * 2. **Bounded.** The whole block fits inside {@link EVIDENCE_MAX_CHARS}, well
 *    clear of the provider's own hard cap on the assessment payload.
 * 3. **Pure.** Every import in this file is `import type`, so nothing here
 *    pulls the TypeORM entity graph, Nest, or anything else into a caller. The
 *    semantic-eval harnesses load the assessment module without starting an
 *    app, and this module must never be the reason that stops working. The
 *    assessor's prose rule about these records lives in
 *    `explanation-assessment.ts` beside `EVIDENCE_SCOPE_RULE`, for the same
 *    reason: that file must keep importing nothing but pure modules.
 */
import type { DrillState, JobStatus, RunResult } from '@learnsdlc/shared';
import type { ProposalEditEvidence } from './agent-proposal.entity';

/** The most recent completed Runs supplied. Three is enough to show a trend. */
export const EVIDENCE_MAX_RUNS = 3;
/** Paths whose edited lines are excerpted. The full path lists are not capped by this. */
const EVIDENCE_MAX_EDIT_PATHS = 3;
/** Excerpted lines per side, per path. */
const EVIDENCE_MAX_EDIT_LINES = 3;
/** Characters kept of one excerpted line. */
const EVIDENCE_MAX_LINE_CHARS = 120;
/** Characters kept across every excerpted line of an edit, on both sides together. */
const EVIDENCE_MAX_EDIT_CHARS = 700;
/** Paths named in each of the changed/added/removed lists. */
export const EVIDENCE_MAX_PATHS = 20;
/** The whole evidence block, serialised. */
export const EVIDENCE_MAX_CHARS = 2048;

// A copy of `DELIMITER_PATTERN` in learner-scrub.ts, because this module
// imports types only.
const DELIMITER_PATTERN = /<<<\s*LEARNER_DATA|LEARNER_DATA\s*>>>/gi;
// A copy of `CONTROL_CHARS` in fence-markers.ts, because this module imports
// types only. Written with plain ASCII escapes, as that one is: raw control
// bytes in the source make the file binary to ordinary tooling, and any
// editor, formatter or transfer that normalises them would disable this scrub
// with no compile error and no failing test.
// Tab, newline and carriage return are content, and stay out of the class.
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Strip control bytes, then neutralise any fence delimiter, then bound the
 * length. The provider scrubs the whole serialised payload the same way before
 * it fences it; doing it here as well means a bug in one of the two is not the
 * only thing standing between learner bytes and the fence. Control characters
 * go first so a delimiter split by one cannot survive the second pass.
 */
export function scrubEvidenceText(value: string, maxChars: number): string {
  const scrubbed = value.replace(CONTROL_PATTERN, ' ').replace(DELIMITER_PATTERN, '[marker]');
  return scrubbed.length > maxChars ? `${scrubbed.slice(0, maxChars)}…` : scrubbed;
}

/** What the deployment drill recorded, with none of what the learner wrote about it. */
export interface RecordedDrillEvidence {
  fault: string;
  pagedAt: string;
  /** Absent on a drill paged before the field existed; never guessed into a red. */
  pagedExit: number | null;
  healthRanAt: string | null;
  healthExit: number | null;
  fixAppliedAt: string | null;
  resolvedAt: string | null;
  /** Whether the learner filed a record. Its prose is deliberately NOT supplied. */
  incidentRecorded: boolean;
}

/** One completed Run, reduced to counts. Never a submission, verdict or score. */
export interface RecordedRunEvidence {
  at: string;
  exitKind: string;
  ok: boolean;
  tests: { total: number; passed: number; failed: number; errored: number } | null;
  /**
   * Server-observed ORDERING, and nothing more: this run was recorded before
   * the assessed bytes existed. It is not provenance, and `false` asserts
   * nothing about which bytes ran. A run always executes the learner's saved
   * workspace, a pending proposal's files are never written to it, and this
   * review happens only while the proposal is unapplied and the saved workspace
   * still hashes to the bytes the proposal was made against. So no supplied run
   * exercised the proposed change, whatever its timestamp. The assessor is told
   * that outright by `RECORDED_EVIDENCE_RULE`, rather than being left to read an
   * unmarked run as one that might have.
   */
  predatesProposal: boolean;
}

/** The learner's own edit of this proposal: that it happened, and what it touched. */
export interface RecordedEditEvidence {
  editedAt: string;
  previousHash: string;
  currentHash: string;
  changedPaths: string[];
  addedPaths: string[];
  removedPaths: string[];
  /**
   * The lines the edit removed and added, by occurrence. A pure reordering of
   * otherwise unchanged lines shows as no changed line; the assessor's rule
   * says so in as many words.
   *
   * Each excerpted line is trimmed to fit the budget, which erases exactly the
   * difference a whitespace-only edit made, and an all-whitespace line is
   * dropped from both sides entirely. `whitespaceOnly` marks such a path, so a
   * removed and added pair that reads identically, or a changed path with no
   * lines at all, is never taken for a no-op. The gate revokes approval on a
   * whitespace edit, so "I only fixed the indentation" is a true claim that has
   * to stay checkable rather than look contradicted.
   */
  changedLines: Array<{ path: string; removed: string[]; added: string[]; whitespaceOnly?: true }>;
  /** True when a path list, a line list or a line itself was cut to fit. */
  truncated: boolean;
}

export interface LearnerRecordedEvidence {
  recordedDrill: RecordedDrillEvidence | null;
  recordedRuns: RecordedRunEvidence[];
  recordedEdit: RecordedEditEvidence | null;
}

/**
 * The shape this module reads off an execution run row. Structural on purpose:
 * `ExecutionRunEntity` satisfies it, and naming it here keeps the entity module
 * out of this file entirely.
 */
export interface RecordedRunRow {
  id: string;
  kind: 'run' | 'submit';
  status: JobStatus;
  result: RunResult | null;
  createdAt: Date | string;
}

/** A stored time stamp as scrubbed text of at most 40 characters, or null when it is not a non-empty string. */
const scrubbedStamp = (value: unknown): string | null =>
  typeof value === 'string' && value ? scrubEvidenceText(value, 40) : null;

const instant = (value: Date | string): number => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : scrubEvidenceText(String(value), 40);

/**
 * Shared's `incidentRecorded` (root cause, fix and action item all
 * non-blank), restated because this module imports types only; the spec pins
 * the two to the same answers.
 */
function threeFieldsWritten(incident: DrillState['incident'] | undefined): boolean {
  if (!incident || typeof incident !== 'object') return false;
  return [incident.rootCause, incident.fix, incident.actionItem].every((one) => typeof one === 'string' && one.trim() !== '');
}

export function recordedDrillEvidence(drill: DrillState | null | undefined): RecordedDrillEvidence | null {
  if (!drill || typeof drill !== 'object') return null;
  return {
    fault: scrubEvidenceText(typeof drill.fault === 'string' ? drill.fault : '', 60),
    pagedAt: scrubbedStamp(drill.pagedAt) ?? '',
    pagedExit: typeof drill.pagedExit === 'number' ? drill.pagedExit : null,
    healthRanAt: scrubbedStamp(drill.healthRanAt),
    healthExit: typeof drill.healthExit === 'number' ? drill.healthExit : null,
    fixAppliedAt: scrubbedStamp(drill.fixAppliedAt),
    resolvedAt: scrubbedStamp(drill.resolvedAt),
    // The caller hands the drill through `drillWithIncident`, so this is the runbook record's incident.
    incidentRecorded: threeFieldsWritten(drill.incident),
  };
}

/**
 * The most recent completed Runs for this phase state, newest first.
 *
 * The filter and the order are repeated here rather than left to the query:
 * this module owns the rule that a submission is never evidence, so the rule is
 * testable without a database. A `createdAt` tie is broken by descending id,
 * the same way `explain.service.ts` and `feedback.service.ts` break it, two
 * rows really can share a timestamp on sqlite, and "the latest run" then has no
 * other answer.
 */
export function recordedRunEvidence(
  runs: readonly RecordedRunRow[] | null | undefined,
  assessedBytesAt: Date | string,
): RecordedRunEvidence[] {
  if (!Array.isArray(runs)) return [];
  const bytesAt = instant(assessedBytesAt);
  return runs
    .filter(row => row && row.kind === 'run' && row.status === 'completed' && row.result && typeof row.result === 'object')
    .sort((a, b) => instant(b.createdAt) - instant(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, EVIDENCE_MAX_RUNS)
    .map(row => {
      const result = row.result as RunResult;
      const tests = result.tests;
      return {
        at: iso(row.createdAt),
        exitKind: scrubEvidenceText(typeof result.exitKind === 'string' ? result.exitKind : '', 20),
        ok: result.ok === true,
        tests: tests ? { total: tests.total, passed: tests.passed, failed: tests.failed, errored: tests.errored } : null,
        predatesProposal: instant(row.createdAt) < bytesAt,
      };
    });
}

const splitLines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** Every non-whitespace character, in order. Two versions that squeeze to the same
 * string differ in whitespace and in nothing else. */
const squeeze = (text: string): string => text.replace(/\s+/g, '');

/**
 * Lines present on one side and not the other, counted as a multiset and
 * returned in their own side's order. O(n) in lines; no LCS, because this runs
 * on a learner's edit inside the assessment's own deadline.
 */
function lineOccurrenceDelta(before: string, after: string): { removed: string[]; added: string[] } {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const pool = new Map<string, number>();
  for (const line of beforeLines) pool.set(line, (pool.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of afterLines) {
    const held = pool.get(line) ?? 0;
    if (held > 0) pool.set(line, held - 1);
    else if (line.trim()) added.push(line);
  }
  const removed: string[] = [];
  for (const line of beforeLines) {
    const held = pool.get(line) ?? 0;
    if (held > 0) { pool.set(line, held - 1); if (line.trim()) removed.push(line); }
  }
  return { removed, added };
}

/**
 * The learner's own edit of this proposal, reduced.
 *
 * `latestEdit` is already server-validated provenance at the call site: its
 * `currentHash` is the proposal's hash and its `previousHash` re-hashes its own
 * `previousFiles`. This reduction does not re-derive that; it makes the edit
 * legible, so a learner's statement that they edited one sentence is a claim
 * the assessor can check rather than one it cannot see.
 */
export function recordedEditEvidence(
  edit: ProposalEditEvidence | null | undefined,
  proposedFiles: Record<string, string> | null | undefined,
): RecordedEditEvidence | null {
  if (!edit || typeof edit !== 'object') return null;
  const previous = edit.previousFiles && typeof edit.previousFiles === 'object' ? edit.previousFiles : {};
  const current = proposedFiles && typeof proposedFiles === 'object' ? proposedFiles : {};
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const path of Object.keys(current).sort()) {
    if (!(path in previous)) added.push(path);
    else if (previous[path] !== current[path]) changed.push(path);
  }
  for (const path of Object.keys(previous).sort()) if (!(path in current)) removed.push(path);

  let truncated = false;
  const boundPaths = (paths: string[]): string[] => {
    if (paths.length > EVIDENCE_MAX_PATHS) truncated = true;
    return paths.slice(0, EVIDENCE_MAX_PATHS).map(path => scrubEvidenceText(path, 200));
  };

  let budget = EVIDENCE_MAX_EDIT_CHARS;
  const excerpt = (lines: string[]): string[] => {
    const kept: string[] = [];
    if (lines.length > EVIDENCE_MAX_EDIT_LINES) truncated = true;
    for (const line of lines.slice(0, EVIDENCE_MAX_EDIT_LINES)) {
      if (budget <= 0) { truncated = true; break; }
      const text = scrubEvidenceText(line.trim(), Math.min(EVIDENCE_MAX_LINE_CHARS, budget));
      budget -= text.length;
      kept.push(text);
    }
    return kept;
  };

  if (changed.length > EVIDENCE_MAX_EDIT_PATHS) truncated = true;
  const changedLines = changed.slice(0, EVIDENCE_MAX_EDIT_PATHS).map(path => {
    const before = previous[path] ?? '';
    const after = current[path] ?? '';
    const delta = lineOccurrenceDelta(before, after);
    const entry = { path: scrubEvidenceText(path, 200), removed: excerpt(delta.removed), added: excerpt(delta.added) };
    // `changed` already means these two differ, so squeezing to the same string
    // means they differ in whitespace alone, the one edit whose bytes neither
    // the trimmed excerpt nor the blank-line filter can show.
    return squeeze(before) === squeeze(after) ? { ...entry, whitespaceOnly: true as const } : entry;
  });

  return {
    editedAt: scrubbedStamp(edit.editedAt) ?? '',
    previousHash: scrubEvidenceText(typeof edit.previousHash === 'string' ? edit.previousHash : '', 80),
    currentHash: scrubEvidenceText(typeof edit.currentHash === 'string' ? edit.currentHash : '', 80),
    changedPaths: boundPaths(changed), addedPaths: boundPaths(added), removedPaths: boundPaths(removed),
    changedLines, truncated,
  };
}

/**
 * The one builder a caller needs. Pure: the caller gathers the rows, this
 * decides what may be shown.
 *
 * Every key is always present, with `null` and `[]` for "nothing was recorded".
 * That is the whole point: the assessor must be able to tell "the record
 * says exit 0" from "there is no record", and an absent key reads as neither.
 *
 * The runs are dated against the learner's own latest edit when there is one,
 * not against the proposal's creation: the edit is when the assessed bytes came
 * into being, so a run before it did not exercise them.
 */
export function learnerRecordedEvidence(input: {
  drill?: DrillState | null;
  runs?: readonly RecordedRunRow[] | null;
  latestEdit?: ProposalEditEvidence | null;
  proposedFiles?: Record<string, string> | null;
  proposalAt: Date | string;
}): LearnerRecordedEvidence {
  const evidence: LearnerRecordedEvidence = {
    recordedDrill: recordedDrillEvidence(input.drill),
    recordedRuns: recordedRunEvidence(input.runs, input.latestEdit?.editedAt || input.proposalAt),
    recordedEdit: recordedEditEvidence(input.latestEdit, input.proposedFiles),
  };
  // The budget is an invariant of the WHOLE block, so every list the block can
  // grow has to be reachable from here. `boundPaths` admits up to
  // EVIDENCE_MAX_PATHS entries of up to 200 characters into each of the three
  // path lists, and an edit made only of added and removed paths would
  // otherwise leave this loop through its terminal break, several times over
  // the cap.
  //
  // Excerpts go first, because the counts and hashes are what make a claim
  // checkable at all; the changed paths are the last list cut, because they are
  // the ones whose lines were excerpted. Each branch strictly shrinks the block,
  // so the loop terminates, and every cut sets `truncated` so a shortened list
  // is never read as a complete one.
  while (JSON.stringify(evidence).length >= EVIDENCE_MAX_CHARS) {
    if (evidence.recordedEdit && evidence.recordedEdit.changedLines.length) {
      evidence.recordedEdit = { ...evidence.recordedEdit, changedLines: [], truncated: true };
    } else if (evidence.recordedRuns.length > 1) {
      evidence.recordedRuns = evidence.recordedRuns.slice(0, evidence.recordedRuns.length - 1);
    } else if (evidence.recordedEdit && evidence.recordedEdit.addedPaths.length > 1) {
      evidence.recordedEdit = { ...evidence.recordedEdit, addedPaths: evidence.recordedEdit.addedPaths.slice(0, 1), truncated: true };
    } else if (evidence.recordedEdit && evidence.recordedEdit.removedPaths.length > 1) {
      evidence.recordedEdit = { ...evidence.recordedEdit, removedPaths: evidence.recordedEdit.removedPaths.slice(0, 1), truncated: true };
    } else if (evidence.recordedEdit && evidence.recordedEdit.changedPaths.length > 1) {
      evidence.recordedEdit = { ...evidence.recordedEdit, changedPaths: evidence.recordedEdit.changedPaths.slice(0, 1), truncated: true };
    } else break;
  }
  return evidence;
}
