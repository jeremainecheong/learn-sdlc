import { CHANGE_CAPS, CHANGE_REQUEST_JSON, serialiseChangeRequest, validateChangeRequestRecord, type ChangeTicket } from '@learnsdlc/shared';
import { LEGACY_CHANGELOG_FILE } from '../migrations/change-records/change-records';
import { changeFromChangelog } from '../migrations/change-records/changelog-markdown';
import { validateChangeChecks } from './checks-validation';
import { FIXED_SCORER_KEYS } from '@learnsdlc/shared';
import type { CodeChecks } from './content.types';
import { conversionNote, markdownToRecord, notesMember, type LegacyPhaseInput, type LegacyPhaseOutput } from './record-legacy';
import { count, cutDescription, foldRuleSentences, withRecordCriterion } from './rule-sentences';

const plain = (text: string) => text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

/** The first blockquote's lines, joined, markers removed. */
function blockquote(md: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('>'));
  if (start < 0) return '';
  const out: string[] = [];
  for (const l of lines.slice(start)) { if (!l.trimStart().startsWith('>')) break; out.push(l.trimStart().replace(/^>\s?/, '')); }
  return out.join(' ');
}

/**
 * The ticket built from an older Maintenance's words: the first
 * CR-<n> or CHG-<n> token, else CR-1; the bold head of the first blockquote,
 * else the task's title; that blockquote's text, else the Background; the
 * objectives as AC-1 onward, at most `CHANGE_CAPS.acceptance`. Each is held
 * to its `CHANGE_CAPS` cap, cut at the last sentence end within it, else at
 * a word boundary (`cutDescription`; a title loses the stop a cut adds), and
 * every cut, and every objective left out, is named in `cuts`.
 */
export function ticketFromBrief(input: { taskPanel: string; title: string; intro: string; objectives: string[] }): { ticket: ChangeTicket; cuts: string[] } {
  const cuts: string[] = [];
  const held = (text: string, max: number, what: string) => {
    if (text.length <= max) return text;
    cuts.push(`${what} cut to ${max} characters`);
    return cutDescription(text, max);
  };
  const id = /\b(?:CR|CHG)-\d+\b/.exec(input.taskPanel)?.[0] ?? 'CR-1';
  const quote = blockquote(input.taskPanel);
  const head = /^\*\*(.+?)\*\*\s*/.exec(quote);
  const named = plain((head ? head[1] : input.title).replace(/\b(?:CR|CHG)-\d+\b/, '').replace(/^[\s—–:-]+/, '').replace(/[.\s]+$/, '')) || plain(input.title);
  const title = held(named, CHANGE_CAPS.ticketTitle, 'the ticket title').replace(/[.]+$/, '');
  const summary = held(plain(head ? quote.slice(head[0].length) : quote || input.intro), CHANGE_CAPS.ticketSummary, 'the ticket summary');
  const acceptance = input.objectives.slice(0, CHANGE_CAPS.acceptance).map((line, i) => ({
    id: `AC-${i + 1}`,
    line: held(plain(line), CHANGE_CAPS.acceptanceLine, `acceptance AC-${i + 1}`),
  }));
  const past = input.objectives.length - CHANGE_CAPS.acceptance;
  if (past > 0) cuts.push(`${count(past, 'objective', 'objectives')} past the first ${CHANGE_CAPS.acceptance} left out of the ticket`);
  return { ticket: { id, title, summary, acceptance }, cuts };
}

/**
 * An older code Maintenance as a Maintenance with a ticket and a change
 * request: the ticket built from the brief (`ticketFromBrief`);
 * the contract amendments on exactly when the phase mounts
 * `design/contracts.json`; `CHANGELOG.md`, editable or not, the starting
 * record (its TODO lines dropped, the template rule not applied); every
 * criterion's wording held to the cap with the cut named (the teacher's own
 * named as theirs); `change_request` added, the other weights scaled by
 * 0.85, when no criterion beside the four fixed code keys is there to grade
 * the record. Throws one fixed sentence on a markdown mount it cannot place,
 * and on words that would not fit the record.
 */
export function changeChecksFromLegacy(input: LegacyPhaseInput): LegacyPhaseOutput<CodeChecks> {
  const checks = input.checks as CodeChecks;
  const swapped = markdownToRecord(input.files, {
    phase: 'Maintenance',
    markdown: LEGACY_CHANGELOG_FILE,
    record: CHANGE_REQUEST_JSON,
    recordName: 'change request record',
    read: (text) => {
      const parse = changeFromChangelog(text, { dropTodo: true });
      return serialiseChangeRequest({ ...parse.change, ...notesMember(parse.notes) });
    },
    valid: (record) => !validateChangeRequestRecord(record, null).error,
  });
  const { ticket, cuts } = ticketFromBrief(input);
  const contract = input.files.some((f) => f.path === 'design/contracts.json');
  const next: CodeChecks = { ...checks, ticket, change: validateChangeChecks({ contract }, 'maintenance') };
  // a code task has no rules, so the fold holds each criterion's wording to the cap and names the cut
  const folded = foldRuleSentences(input.rubric, [], input.teacherWorded ?? new Set());
  let rubric = folded.rubric;
  const fixed = new Set(FIXED_SCORER_KEYS.code);
  const added = !!rubric && !rubric.criteria.some((c) => !fixed.has(c.key));
  if (rubric && added) {
    rubric = withRecordCriterion(rubric, { key: 'change_request', title: 'Change request', description: 'The record names what the change touched, the tests that cover each acceptance item and the release.', weight: 0 });
  }
  const said = [
    `the ticket ${ticket.id} built from the brief`,
    `the contract amendments ${contract ? 'on' : 'off'}`,
    ...(swapped.from ? [`${swapped.from} became the starting change request`] : []),
    ...(added ? ['change_request added, the other weights scaled by 0.85'] : []),
    ...folded.notes,
    ...cuts,
  ];
  return { files: swapped.files, checks: next, rubric, note: conversionNote('Maintenance converted to the change request record', said) };
}
