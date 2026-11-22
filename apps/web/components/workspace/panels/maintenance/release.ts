/**
 * The release record: the document the merge writes, assembled from the
 * artefacts the learner already made.
 *
 * The record itself is not a form. It exists so the learner can see, before
 * the merge, what the release note will say about their change, and which of
 * its lines is still blank because an artefact is. The release it quotes
 * (the version, the summary, the change lines and the rollback) is written in
 * the change room's Release tab, into the change request record.
 */
import { andList } from '@learnsdlc/shared';
import type { ChangeRequest, EnrollmentView, FeedbackReport, ReleaseRecordView } from '@learnsdlc/shared';
import type { StatusState } from '@/lib/phase';
import type { ContractOperation } from './contracts';
import { baseName, isWritten } from './contracts';
import { count } from './change-signature';
import { impactAbsence, type ChangeMark } from './impact';
import { NOT_MEASURED_REASON } from '@/components/pr/analysisReach';

/** What the record calls a release whose version is not written yet. */
const NEXT_RELEASE = 'the next release';

export interface ReleaseLine {
  label: string;
  /** One sentence. Blank when the artefact it reads from is still empty. */
  text: string;
  state: StatusState;
  /** What to do about a blank line, named as the place it is written. */
  todo?: string;
}

export interface ReleaseRecord {
  /** The change request's release version, or "the next release" while it is blank. */
  version: string;
  /** The version is written in the change request. */
  versioned: boolean;
  title: string;
  /** Written once PR-6 merges; a draft until then. */
  merged: boolean;
  /** The merge message, from the release the API wrote. */
  notes: string | null;
  createdAt: string | null;
  lines: ReleaseLine[];
  /** v1 … v5, oldest first, so the record sits in a series. */
  earlier: ReleaseRecordView[];
}

/** "Release record 1.1.0", or "Release record for the next release" while the version is blank. */
export function releaseHeading(record: ReleaseRecord): string {
  return record.versioned ? `Release record ${record.version}` : `Release record for ${NEXT_RELEASE}`;
}

/** The change request's release is recorded: a version and at least one named change line. */
export function releaseWritten(change: ChangeRequest): boolean {
  return Boolean(change.release.version.trim()) && change.release.changes.some((line) => line.line.trim());
}

/* --------------------------------- lines --------------------------------- */

/** "Added: reopen_task (CR-1). Changed: nothing." */
export function changedSentence(
  marks: { mark: ChangeMark; n: number }[],
  added: string[],
  ticketId: string,
): string {
  const addedNames = added.slice(0, 3).join(', ');
  const head =
    added.length > 0
      ? `Added: ${addedNames}${added.length > 3 ? ` and ${added.length - 3} more` : ''} (${ticketId}).`
      : 'Added: nothing.';
  const changed = marks.find((m) => m.mark === 'changed')?.n ?? 0;
  const tail = changed > 0 ? `Changed: ${count(changed, 'function')}.` : 'Changed: nothing.';
  return `${head} ${tail}`;
}

/** What the record says when the verdict holds no function-level reading of the change. */
export const NO_FUNCTION_READING =
  "No function-level reading of the changed files was made, so this line names no function. The pull request's Files changed tab shows what changed.";

const FILES_CHANGED_TAB = " The pull request's Files changed tab shows what changed.";

/**
 * Why there is no function-level reading, said from the verdict's static
 * analysis (`impactAbsence`); a verdict with no analysis keeps NO_FUNCTION_READING.
 */
function noReadingText(report: FeedbackReport): string {
  switch (impactAbsence(report.staticAnalysis)) {
    case 'unavailable':
      return `The analyzer could not run in this review, so this line names no function.${FILES_CHANGED_TAB}`;
    case 'unread':
      return `${NOT_MEASURED_REASON.replace(/\.$/, '')}, so this line names no function.${FILES_CHANGED_TAB}`;
    case 'no-baseline':
      return `The review read the functions in your files but had no earlier reading of them to compare with, so this line names no function.${FILES_CHANGED_TAB}`;
    case 'no-function':
      return `The analyzer read your files and found no function in them, so this line names no function.${FILES_CHANGED_TAB}`;
    case 'no-named-function':
      return `The analyzer read your files and counted functions in them but could not name any of them, so this line names no function.${FILES_CHANGED_TAB}`;
    case 'no-list':
      return `The review kept no list of the functions in your files, so this line names no function.${FILES_CHANGED_TAB}`;
    default:
      return NO_FUNCTION_READING;
  }
}

/** The "What changed" line before any verdict: no reading has been made, so it says so rather than "nothing". */
export const NOT_READ_YET =
  'Not read yet. The review of your pull request reads which functions the change adds and changes.';

/**
 * The "What changed" line. Before any verdict it is blank and says it has not
 * been read yet: "Added: nothing. Changed: nothing." there read as a change
 * with nothing in it, under the learner's own release text. With a
 * verdict but no impact reading it names no count, because "nothing" would be
 * a claim about code nobody read, and it is not a blank line the learner can
 * fill. With a reading, a function added or an existing one changed is a
 * written line; only a reading where nothing moved is blank.
 */
function whatChangedLine(input: ReleaseInput): ReleaseLine {
  if (!input.report) return { label: 'What changed', text: '', state: 'todo', todo: NOT_READ_YET };
  if (!input.impactRead) return { label: 'What changed', text: noReadingText(input.report), state: 'done' };
  const changed = input.marks.find((m) => m.mark === 'changed')?.n ?? 0;
  const moved = input.added.length > 0 || changed > 0;
  return {
    label: 'What changed',
    text: changedSentence(input.marks, input.added, input.ticket.id),
    state: moved ? 'pass' : 'todo',
    todo: moved ? undefined : `No new function yet. Write ${input.signature} in the code.`,
  };
}

/** "18 tests passing, 2 planted bugs caught." */
export function testsSentence(report: FeedbackReport | null): string {
  const cases = report?.tests?.cases ?? [];
  if (cases.length === 0) return '';
  const passed = cases.filter((c) => c.status === 'passed').length;
  const head = passed === cases.length ? `${count(cases.length, 'test')} passing.` : `${passed} of ${count(cases.length, 'test')} passing.`;
  const mutation = report?.mutation;
  if (!mutation || mutation.total === 0) return head;
  const bugs =
    mutation.killed === mutation.total
      ? `All ${count(mutation.total, 'planted bug')} caught.`
      : `${mutation.killed} of ${count(mutation.total, 'planted bug')} caught.`;
  return `${head} ${bugs}`;
}

export interface ReleaseInput {
  projectTitle: string;
  ticket: { id: string; title: string; summary: string };
  change: ContractOperation | null;
  signature: string;
  /** The room draws a Contract tab (the teacher's switch is on; an older-format phase draws none); without one the record has no contract line. */
  contractTab: boolean;
  report: FeedbackReport | null;
  /**
   * The verdict carries an impact reading (`report.impact`). The API writes
   * none when the analyzer read no function on either side, which is every
   * phase whose files are all ones it does not read (TypeScript among them),
   * so no function count can be said for the change.
   */
  impactRead: boolean;
  marks: { mark: ChangeMark; n: number }[];
  added: string[];
  /** The change request record as it stands: the release it carries. */
  record: ChangeRequest;
  enrollment: EnrollmentView | null;
  phaseOrder: number;
}

/**
 * The record as it stands. Every line names the artefact it was read from, so
 * a blank line is a piece of work rather than a gap in the page.
 */
/** One clause, ended once: the learner's own full stop is not doubled. */
function sentence(text: string): string {
  const t = text.trim();
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
}

export function buildRelease(input: ReleaseInput): ReleaseRecord {
  const releases = input.enrollment?.releases ?? [];
  const mine = releases.find((r) => r.phaseOrder === input.phaseOrder) ?? null;
  const earlier = releases.filter((r) => r.phaseOrder < input.phaseOrder).sort((a, b) => a.phaseOrder - b.phaseOrder);

  const lines: ReleaseLine[] = [];

  lines.push(whatChangedLine(input));

  lines.push({
    label: 'Why',
    text: input.ticket.summary,
    state: input.ticket.summary ? 'pass' : 'todo',
    todo: input.ticket.summary ? undefined : `${input.ticket.id} carries no description.`,
  });

  if (input.contractTab) {
    const written = input.change ? isWritten(input.change) : false;
    lines.push({
      label: 'Contract',
      text: input.change
        ? `${baseName(input.change.name) || input.signature}: ${sentence(input.change.returns) || 'return value not stated'}${
            input.change.errors ? ` ${sentence(input.change.errors)}` : ''
          }`
        : '',
      state: written ? 'pass' : input.change ? 'warn' : 'todo',
      todo: written ? undefined : `Write the ${input.signature} contract in the Contract tab.`,
    });
  }

  const tests = testsSentence(input.report);
  lines.push({
    label: 'Tests',
    text: tests,
    state: tests ? (input.report?.passed ? 'pass' : 'warn') : 'todo',
    todo: tests ? undefined : 'No verdict yet. Submit the pull request to run the suites.',
  });

  const release = input.record.release;
  const said = [release.summary, ...release.changes.map((line) => line.line)].map(sentence).filter(Boolean).join(' ');
  lines.push({
    label: 'Release',
    text: said,
    state: releaseWritten(input.record) ? 'pass' : said ? 'warn' : 'todo',
    todo: said ? undefined : 'Write the release summary and its change lines in the Release tab.',
  });

  const rollback = release.rollback.trim();
  lines.push({
    label: 'Rollback',
    text: rollback,
    state: rollback ? 'pass' : 'todo',
    todo: rollback ? undefined : 'Say how to roll this release back in the Release tab.',
  });

  const versioned = Boolean(release.version.trim());
  const version = versioned ? release.version.trim() : NEXT_RELEASE;
  return {
    version,
    versioned,
    title: versioned ? `${input.projectTitle} ${version}` : `${input.projectTitle}, ${NEXT_RELEASE}`,
    merged: Boolean(mine),
    notes: mine?.notes ?? null,
    createdAt: mine?.createdAt ?? null,
    lines,
    earlier,
  };
}

/**
 * The line under the record's heading. Before the merge it says what the record will be assembled
 * from, the merge still to come; once the pull request has merged (the project completed, or the learner past this
 * phase), the merge is in the past and the line says so, naming the merge message only where one was written.
 */
export function releasePurpose(record: Pick<ReleaseRecord, 'merged' | 'notes'>, ticketId: string, pr: string): string {
  if (!record.merged) return `Assembled from ${ticketId}, your change request and the merge message when ${pr} merges.`;
  return record.notes
    ? `Assembled from ${ticketId}, your change request and the merge message, published when ${pr} merged.`
    : `Assembled from ${ticketId} and your change request, published when ${pr} merged.`;
}

/**
 * The record's closing line once the merge wrote it: the merge message, or,
 * since the message is optional, that none was written. Null before the merge.
 */
export function mergedLine(record: ReleaseRecord, pr: string): string | null {
  if (!record.merged) return null;
  return record.notes ? `Merge message: ${record.notes}` : `${pr} merged. No merge message was written.`;
}

/**
 * "2 lines are still blank: What changed and Tests."; what the record needs
 * before it reads whole, naming the lines, because the card draws only the
 * written ones and a count alone would not say which are missing.
 */
export function blanksSentence(record: ReleaseRecord): string {
  const blank = record.lines.filter((l) => l.state === 'todo');
  if (blank.length === 0) return 'Every line is written.';
  return `${blank.length === 1 ? 'One line is' : `${blank.length} lines are`} still blank: ${andList(blank.map((l) => l.label))}.`;
}

