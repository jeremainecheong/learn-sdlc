import { RUBRIC_CRITERION_DESCRIPTION_MAX, type PhaseRubric, type RubricCriterion } from '@learnsdlc/shared';

/**
 * What the older-shape conversions (Design, Deployment, Maintenance) share
 * about a rubric: the older rule labels folded into their criteria's
 * descriptions, the cap every converted description is held to, and a record
 * criterion added to a rubric that has none.
 */

export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A word whose stop is an abbreviation's, not a sentence end ("See Fig. 3"). */
const ABBREVIATION = /(?:^|[\s(])(?:Fig|Figs|Eq|Sec|Ref|No|Nos|Dr|Mr|Mrs|Ms|St|vs|cf|approx|e\.g|i\.e)$/i;

/**
 * A description held to `max` characters: whole when it fits, else cut at the
 * last sentence end within `max`, else at the last word boundary with a full
 * stop added (still within `max`).
 */
export function cutDescription(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let end = -1;
  // a stop at the very end of `head` ends a sentence only when the text breaks there too
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) {
    if (m[0] === '.' && ABBREVIATION.test(head.slice(0, m.index))) continue;
    if (m.index + 1 < head.length || /\s/.test(text[max] ?? '')) end = m.index;
  }
  if (end >= 0) return head.slice(0, end + 1);
  let words = text.slice(0, max - 1);
  // a cut between the two halves of a character drops the half it would leave
  if (/[\uD800-\uDBFF]$/.test(words)) words = words.slice(0, -1);
  if (!/\s/.test(text[max - 1] ?? '')) {
    const space = words.search(/\s\S*$/);
    if (space > 0) words = words.slice(0, space);
  }
  return `${words.trimEnd().replace(/[\s,;:.!?]+$/, '')}.`;
}

/** The rule sentences that fit no criterion, named so the teacher's wording never vanishes without a word; null when none. */
export function leftOutNote(left: readonly string[]): string | null {
  return left.length
    ? `${count(left.length, 'rule sentence did not fit its criterion and was', 'rule sentences did not fit their criteria and were')} left out: ${left.join(' ')}`
    : null;
}

/** A rule's label as the fold reads it: trimmed, its closing stops dropped; '' when it has none. */
export const ruleLabel = (rule: { label?: unknown }): string => String(rule.label ?? '').trim().replace(/[.]+$/, '');

/**
 * The older rule labels folded into their criteria's descriptions: the teacher's
 * own wording first, each label a sentence after it, every description held to the cap with the cut named.
 * Shared by the Design, Deployment and Maintenance conversions. `notes` says what happened to the teacher's
 * wording and what was cut; `left` holds the sentences that did not fit, for `leftOutNote`.
 */
export function foldRuleSentences(
  rubric: PhaseRubric | undefined,
  rules: readonly { label?: unknown; criterion: string }[],
  teacherWorded: ReadonlySet<string>,
): { rubric: PhaseRubric | undefined; notes: string[]; left: string[] } {
  const notes: string[] = [];
  const sentences = new Map<string, string[]>();
  for (const rule of rules) {
    const label = ruleLabel(rule);
    if (label) sentences.set(rule.criterion, [...(sentences.get(rule.criterion) ?? []), `${label}.`]);
  }
  const MAX = RUBRIC_CRITERION_DESCRIPTION_MAX;
  const left: string[] = [];
  const wordingKept: string[] = [];
  const wordingWhole: string[] = [];
  const cut: string[] = [];
  // every converted description is held to the cap, so the rubric saves back through `RubricDto` unchanged
  const fit = (c: RubricCriterion, text: string): string => {
    if (text.length <= MAX) return text;
    cut.push(`${teacherWorded.has(c.key) ? "the teacher's own wording" : 'the description'} of "${c.title}" cut to ${MAX} characters`);
    return cutDescription(text, MAX);
  };
  const converted: PhaseRubric | undefined = rubric && {
    passThreshold: rubric.passThreshold,
    criteria: rubric.criteria.map((c) => {
      const own = sentences.get(c.key);
      if (!own?.length) return c.description === undefined ? { ...c } : { ...c, description: fit(c, c.description) };
      // the teacher's own wording leads, a sentence of its own; cut to the
      // cap, it leaves no room, and the rule sentences go to the left-out list
      const wording = teacherWorded.has(c.key) ? (c.description ?? '').trim() : '';
      // the cut is decided on the wording as written; a closing stop is added only where it fits
      if (wording.length > MAX) {
        left.push(...own);
        return { ...c, description: fit(c, wording) };
      }
      let description = wording && wording.length < MAX && !/[.!?]$/.test(wording) ? `${wording}.` : wording;
      let followed = false;
      for (const sentence of own) {
        const next = description ? `${description} ${sentence}` : sentence;
        if (next.length > MAX) left.push(sentence);
        else { description = next; followed = true; }
      }
      // the wording leads its rule sentences, or, when none fits after it, stands alone
      if (wording) (followed ? wordingKept : wordingWhole).push(`"${c.title}"`);
      if (description) return { ...c, description };
      // every sentence was left out: the criterion's own description, held to the cap, or none as it had none
      return c.description === undefined ? { ...c } : { ...c, description: fit(c, c.description) };
    }),
  };
  if (wordingKept.length) {
    notes.push(`the teacher's own wording of ${wordingKept.join(', ')} kept in front of ${wordingKept.length === 1 ? 'its' : 'their'} rule sentences`);
  }
  if (wordingWhole.length) {
    notes.push(`the teacher's own wording of ${wordingWhole.join(', ')} kept whole; ${wordingWhole.length === 1 ? 'its' : 'their'} rule sentences left out`);
  }
  notes.push(...cut);
  return { rubric: converted, notes, left };
}

/** A record criterion added to a rubric with none: every weight x 0.85, rounded to four decimals; the new one takes the rest. */
export function withRecordCriterion(rubric: PhaseRubric, criterion: RubricCriterion): PhaseRubric {
  const criteria = rubric.criteria.map((c) => ({ ...c, weight: Math.round(c.weight * 0.85 * 10_000) / 10_000 }));
  const rest = Math.round((1 - criteria.reduce((n, c) => n + c.weight, 0)) * 10_000) / 10_000;
  return { ...rubric, criteria: [...criteria, { ...criterion, weight: rest }] };
}
