/**
 * Contract contradictions, found while the learner types.
 *
 * A warning here says one thing only: this line of the contract states the
 * opposite of a fact. The fact is either a story the Design phase lists, the
 * learner's own story record from the Requirements phase, or another line of
 * the same design. Every branch needs a fact before it fires, which is the
 * discipline `apps/api/src/feedback/conformance.ts` states at its
 * `contradiction()`: a line the editor cannot check is never called a
 * contradiction.
 *
 * The vocabulary (`CLAIMS_*`, `CLAIM_HEDGE`, `claimAsserted`,
 * `claimSentences`) comes from `@learnsdlc/shared`, which the review reads
 * too. A second, differently tuned set of patterns would make the editor and
 * the review disagree about the same sentence, which is the one thing this
 * feature must not do.
 *
 * Pure: no React, no fetch, no clock, no randomness. The same inputs always
 * give the same list, in the same order: operation order, then rule order.
 */
import {
  CLAIM_HEDGE,
  CLAIMS_LOW_FIRST,
  CLAIMS_NO_ERRORS,
  CLAIMS_NO_INPUTS,
  CLAIMS_NO_ORDER,
  CLAIMS_TODAY_OVERDUE,
  claimAsserted,
  claimSentences,
  type Design,
  type DesignStory,
} from '@learnsdlc/shared';
import { readStoryRecord } from '../requirements/story';
import { benefitPhrase, capabilityPhrase, personaPhrase } from '../requirements/storySentence';
import { baseName } from './model';

/**
 * One operation as the rules read it: each list of the record joined into one
 * line, and the ordering or boundary clause the operation's note holds.
 */
type EngineOperation = {
  name: string;
  satisfies: string;
  inputs: string;
  returns: string;
  errors: string;
  ordering?: string;
  boundary?: string;
};

/** Which extra clause an operation owes, by its name: a filter states its ordering, an overdue report its boundary. */
const owedClause = (name: string): 'ordering' | 'boundary' | null => {
  const base = baseName(name).toLowerCase();
  return base.includes('filter') ? 'ordering' : base.includes('overdue') ? 'boundary' : null;
};

/**
 * The clauses an operation's note holds. A note the fold wrote from an older
 * board labels each clause ("ordering: high first; example: ..."), and a
 * labelled clause is read as what it says it is, whatever the label's case.
 * Text before the first label is unlabelled: it is the clause the operation's
 * name owes, else its ordering, unless a label already says that clause. A
 * note with no label at all is the clause the name owes, if it owes one.
 */
function noteClauses(name: string, note: string | undefined): Pick<EngineOperation, 'ordering' | 'boundary'> {
  const text = note?.trim() ?? '';
  if (!text) return {};
  const label = /(?:^|;\s*)(ordering|boundary|example):\s*/gi;
  const marks = [...text.matchAll(label)];
  if (marks.length === 0) {
    const owed = owedClause(name);
    return owed ? { [owed]: text } : {};
  }
  const out: Pick<EngineOperation, 'ordering' | 'boundary'> = {};
  marks.forEach((m, i) => {
    const key = m[1].toLowerCase();
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index ?? text.length : text.length;
    if (key === 'ordering' || key === 'boundary') out[key] = text.slice(from, to).trim();
  });
  const leading = text.slice(0, marks[0].index ?? 0).trim();
  const unlabelled = owedClause(name) ?? 'ordering';
  if (leading && out[unlabelled] === undefined) out[unlabelled] = leading;
  return out;
}

/** The record as the rules read it, once: lists joined with ", " (the spec's one tolerance), the note as its clauses. */
const engineOperations = (design: Design): EngineOperation[] =>
  design.operations.map((o) => ({
    name: o.name,
    satisfies: o.satisfies.join(', '),
    inputs: o.inputs.join(', '),
    returns: o.returns,
    errors: o.errors.join(', '),
    ...noteClauses(o.name, o.note),
  }));

/** Every entity's attributes, as the model's fields: only a field's name is read. */
const engineFields = (design: Design): { name: string }[] =>
  design.entities.flatMap((e) => e.attributes.map((a) => ({ name: a.name })));

/** Which extra clause this operation owes: the one its note labels, else the one its name owes. */
function extraKey(op: EngineOperation): 'ordering' | 'boundary' | null {
  const base = baseName(op.name).toLowerCase();
  if (op.ordering !== undefined || base.includes('filter')) return 'ordering';
  if (op.boundary !== undefined || base.includes('overdue')) return 'boundary';
  return null;
}

/** One story, or one acceptance criterion, as a fact a warning can quote. */
export interface StoryFact {
  /** US-3, or US-4/AC-2 for a criterion of the learner's own story. */
  id: string;
  /** The story half of the id, so a rule can ask what an operation claims. */
  storyId: string;
  /** The whole line, tidied to one line. */
  text: string;
  /** True for the learner's own story record, false for a story the phase lists. */
  own: boolean;
}

export type WarningRule = 'ordering' | 'boundary' | 'errors' | 'model' | 'signature';

export interface ContractWarning {
  /** Stable across re-renders: `${ruleId}:${operation}`. The test id and the React key. */
  id: string;
  rule: WarningRule;
  /** The operation's base name, e.g. getOverdue. */
  operation: string;
  /** The learner's own words that triggered it, quoted back. */
  said: string;
  /** The fact it contradicts: a story's or a criterion's words, or another line of the design. */
  against: string;
  /** The story or criterion id, or null for a contract-against-itself warning. */
  criterionId: string | null;
  /** The whole warning, one or two sentences, ready to render. */
  text: string;
}

export interface WarningSources {
  design: Design;
  facts: StoryFact[];
  /**
   * The error codes the API contract's catalogue declares
   * (`shared/contract/api.json`), when the caller has read it. A code is never
   * a field, so the model rule skips every one of them. Optional: without it
   * the rule still skips the codes the design's own error lines name and the
   * shapes an error code is written in (`isErrorCodeShape`).
   */
  errorCodes?: readonly string[];
}

/** Six warnings is already a lot to settle; more than twelve is a wall. */
const MAX_WARNINGS = 12;

const tidy = (value: string): string => value.replace(/`/g, '').replace(/\s+/g, ' ').trim();

/**
 * The stories the design is checked against: the stories the Design phase
 * lists (`PhaseDetail.design.stories`), each its title and its line under its
 * own id, then the learner's own story record from the Requirements phase when
 * the caller has it (`ownRecord`, the text of `requirements/story.json`). The
 * record is read and never graded here, and a story the phase already lists
 * keeps the phase's line. Nothing else is read: no backlog file, no markdown.
 *
 * From the record come the story itself (its title and its As a / I want /
 * So that sentence, under the story's own id) and each criterion. Its
 * out-of-scope lines are not facts: each says what the story does not
 * promise, so a contract that matches its words contradicts nothing, and the
 * rules below would read it the other way round.
 */
export function storyFacts(stories: DesignStory[], ownRecord: string | undefined): StoryFact[] {
  const out: StoryFact[] = [];
  const push = (id: string, text: string, own: boolean) => {
    const flat = tidy(text);
    if (!id || !flat) return;
    if (out.some((f) => f.id === id)) return;
    out.push({ id, storyId: id.split('/')[0], text: flat, own });
  };

  for (const s of stories) push(s.id, [s.title.trim(), s.line.trim()].filter(Boolean).join('. '), false);
  const story = ownRecord?.trim() ? readStoryRecord(ownRecord) : null;
  if (story?.id) {
    // Each phrase from the one composer, so a part that already holds "a", "I want" or "so that" is not doubled.
    const sentence = [personaPhrase(story.persona), capabilityPhrase(story.capability), benefitPhrase(story.benefit)]
      .filter(Boolean)
      .join(', ');
    push(story.id, [story.title.trim(), sentence].filter(Boolean).join('. '), true);
    for (const c of story.criteria) {
      const said = [
        c.given ? `Given ${c.given}` : '',
        c.when ? `when ${c.when}` : '',
        c.then ? `then ${c.then}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      push(`${story.id}/${c.id}`, said, true);
    }
  }
  return out;
}

/** The story ids the facts know about, in order, for the pickers. */
export function storyIdsOf(facts: StoryFact[]): string[] {
  const seen: string[] = [];
  for (const f of facts) if (!seen.includes(f.storyId)) seen.push(f.storyId);
  return seen;
}

/* ------------------------------ the vocabulary ----------------------------- */
/* Copied verbatim from apps/api/src/feedback/conformance.ts (58, 358-379). */

/** The sentence that triggered, so the warning can quote the learner's words. */
const claimed = (value: string, pattern: RegExp): string =>
  tidy(claimSentences(value).find((s) => pattern.test(s) && !CLAIM_HEDGE.test(s)) ?? value);

/* -------------------------------- the facts -------------------------------- */

/**
 * "high tasks come before medium": the ordering the backlog pins. Written
 * against the shipped US-3/AC-4 and against the way a learner rephrases it.
 * Exported so the API's pack spec holds TaskTrackr's story lines to this very
 * pattern, not a copy of it.
 */
export const FACT_HIGH_FIRST =
  /\bhigh(est)?\b[^.;\n]{0,40}\bbefore\b[^.;\n]{0,24}\bmedium\b|\bhigh(est)? priority (first|before)\b|\bdescending priority\b/i;
/**
 * A criterion that says a task due today is still open. The window is wide
 * because a criterion is a whole Given/when/then sentence, not a clause.
 */
const FACT_TODAY_NOT_OVERDUE =
  /\bdue today\b[^.;\n]{0,80}\b(not overdue|is not late|still open|not late)\b|\bnot\b[^.;\n]{0,24}\boverdue\b[^.;\n]{0,24}\btoday\b/i;
/**
 * A criterion that says a task due today counts as overdue. Read with the
 * hedge guard, or "then it is not overdue" would satisfy it too.
 */
const FACT_TODAY_OVERDUE =
  /\bdue today\b[^.;\n]{0,80}\b(is|are|counts? as|becomes?)\b[^.;\n]{0,16}\boverdue\b/i;
/**
 * A criterion that expects a failure. The pack states failures as HTTP codes
 * ("answers 404 with the code `task_not_found`"), so the words alone are
 * not enough. Exported for the same pack spec as `FACT_HIGH_FIRST`.
 */
export const FACT_EXPECTS_ERROR =
  /\berrors?\b|\brejects?\b|\braises?\b|\brefus\w+\b|\binvalid\w*\b|\bnot_found\b|\b4\d\d\b|\bwith the code\b/i;
/** The contract's own "strictly before today" half, for the design-against-itself rule. */
const SAYS_STRICTLY_BEFORE = /\bstrictly before\b|\bbefore today\b|\b<\s*today\b/i;

/* ------------------------------- the tokens -------------------------------- */

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CAMEL = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;

/**
 * Tokens that look like a field but are not one: the words the clauses
 * themselves are written in, the ids every operation takes, and the error codes
 * the pack's catalogue declares. Kept short and explicit on purpose: the rule
 * that uses it is the loosest here, and a stop list that grows is a rule that has stopped
 * being about the model.
 */
const NOT_A_FIELD = new Set([
  'task_id',
  'taskid',
  'list_id',
  'listid',
  'is_done',
  'isdone',
  'key_error',
  'keyerror',
  'value_error',
  'valueerror',
  'not_found',
  'notfound',
  'task_not_found',
  'tasknotfound',
  'invalid_title',
  'invalidtitle',
  'invalid_priority',
  'invalidpriority',
  'invalid_status',
  'invalidstatus',
  'http_status',
  'httpstatus',
  'json',
  'todo',
]);

/** `due_date` and `dueDate` are the same field to a reader, so they are here too. */
const flatten = (token: string): string => token.toLowerCase().replace(/_/g, '');

/** `listNotFound` read as `list_not_found`, so one set of shapes covers both spellings. */
const snakeOf = (token: string): string => token.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * The shapes an error code is written in: `list_not_found`, `invalid_date`,
 * `duplicate_title`, `version_conflict`, `forbidden`, `unauthorized` (and
 * their camel spellings). A contract names such a code to say what fails, so
 * the model rule never reads one as a missing field.
 */
const ERROR_CODE_SHAPE = /^(?:[a-z0-9_]+_not_found|invalid_[a-z0-9_]+|duplicate_[a-z0-9_]+|[a-z0-9_]+_conflict|forbidden|unauthorized)$/;

export const isErrorCodeShape = (token: string): boolean => ERROR_CODE_SHAPE.test(snakeOf(token));

/** Whatever stood inside the parentheses of the declared signature. */
function paramsOf(name: string): string {
  const open = name.indexOf('(');
  const close = name.lastIndexOf(')');
  if (open === -1 || close < open) return '';
  return name.slice(open + 1, close).trim();
}

/* -------------------------------- the rules -------------------------------- */

interface Draft {
  ruleId: string;
  rule: WarningRule;
  said: string;
  against: string;
  criterionId: string | null;
  text: string;
}

const extraOf = (op: EngineOperation, key: 'ordering' | 'boundary'): string =>
  ((key === 'ordering' ? op.ordering : op.boundary) ?? '').trim();

function orderingWarning(op: EngineOperation, base: string, facts: StoryFact[]): Draft | null {
  if (extraKey(op) !== 'ordering') return null;
  const clause = extraOf(op, 'ordering');
  if (!clause) return null;
  const fact = facts.find((f) => FACT_HIGH_FIRST.test(f.text));
  if (!fact) return null;
  if (claimAsserted(clause, CLAIMS_LOW_FIRST)) {
    return {
      ruleId: 'ordering',
      rule: 'ordering',
      said: claimed(clause, CLAIMS_LOW_FIRST),
      against: fact.text,
      criterionId: fact.id,
      text: `${base} orders low priority first, but ${fact.id} says high priority tasks come before medium. One of the two has to change.`,
    };
  }
  if (claimAsserted(clause, CLAIMS_NO_ORDER)) {
    return {
      ruleId: 'ordering',
      rule: 'ordering',
      said: claimed(clause, CLAIMS_NO_ORDER),
      against: fact.text,
      criterionId: fact.id,
      text: `${base} says the order does not matter, but ${fact.id} pins one: high priority tasks come before medium.`,
    };
  }
  return null;
}

function boundaryWarning(op: EngineOperation, base: string, facts: StoryFact[]): Draft | null {
  if (extraKey(op) !== 'boundary') return null;
  const clause = extraOf(op, 'boundary');
  if (!clause) return null;
  if (claimAsserted(clause, CLAIMS_TODAY_OVERDUE)) {
    const fact = facts.find((f) => FACT_TODAY_NOT_OVERDUE.test(f.text));
    if (!fact) return null;
    return {
      ruleId: 'boundary',
      rule: 'boundary',
      said: claimed(clause, CLAIMS_TODAY_OVERDUE),
      against: fact.text,
      criterionId: fact.id,
      text: `${base} puts a task due today in the overdue set, but ${fact.own ? 'your ' : ''}${fact.id} says a task due today is not overdue.`,
    };
  }
  // The mirror: the contract excludes today, the story includes it. Same rule,
  // same weight: a learner who wrote the story is as likely to have meant the
  // other boundary.
  if (SAYS_STRICTLY_BEFORE.test(clause)) {
    const fact = facts.find((f) => FACT_TODAY_OVERDUE.test(f.text) && !CLAIM_HEDGE.test(f.text));
    if (!fact) return null;
    return {
      ruleId: 'boundary',
      rule: 'boundary',
      said: tidy(clause),
      against: fact.text,
      criterionId: fact.id,
      text: `${base} leaves a task due today out of the overdue set, but ${fact.own ? 'your ' : ''}${fact.id} says a task due today is overdue.`,
    };
  }
  return null;
}

/** The contract against itself: the boundary line and the returns line disagree. */
function boundaryReturnsWarning(op: EngineOperation, base: string): Draft | null {
  if (extraKey(op) !== 'boundary') return null;
  const clause = extraOf(op, 'boundary');
  if (!clause || !op.returns.trim()) return null;
  if (claimAsserted(clause, CLAIMS_TODAY_OVERDUE) && SAYS_STRICTLY_BEFORE.test(op.returns)) {
    return {
      ruleId: 'boundary-returns',
      rule: 'boundary',
      said: claimed(clause, CLAIMS_TODAY_OVERDUE),
      against: tidy(op.returns),
      criterionId: null,
      text: `${base} returns tasks due strictly before today, but its boundary rule puts a task due today in the overdue set.`,
    };
  }
  return null;
}

function errorsWarning(op: EngineOperation, base: string, facts: StoryFact[]): Draft | null {
  const clause = op.errors.trim();
  if (!clause || !claimAsserted(clause, CLAIMS_NO_ERRORS)) return null;
  // "Errors: none; a task with no due date is simply excluded" is a real
  // contract, so the fact has to come from a criterion this operation claims:
  // never from the wording alone. An operation that claims no story stays quiet.
  // Split rather than substring-match: "US-25" contains "US-2", and a warning
  // that quotes the wrong story is worse than no warning.
  const claims = op.satisfies.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  if (claims.length === 0) return null;
  const fact = facts.find(
    (f) => claims.includes(f.storyId) && FACT_EXPECTS_ERROR.test(f.text),
  );
  if (!fact) return null;
  return {
    ruleId: 'errors',
    rule: 'errors',
    said: claimed(clause, CLAIMS_NO_ERRORS),
    against: fact.text,
    criterionId: fact.id,
    text: `${base} says it raises nothing, but ${fact.id} expects a failure it has to name.`,
  };
}

/**
 * Every error code the design itself names: each token of every operation's
 * error line, plus the contract catalogue's codes when the caller has them.
 * An error line names what fails, never what the model holds.
 */
function errorCodesOf(operations: EngineOperation[], catalogue: readonly string[] | undefined): Set<string> {
  const codes = new Set<string>();
  for (const code of catalogue ?? []) if (code.trim()) codes.add(flatten(code.trim()));
  for (const op of operations) {
    // One entry per code the line names: the record joins them with commas,
    // and a learner writes "or" and semicolons too. An entry's first snake or
    // camel word is its code; a later word is a code only when it is written
    // in a code's shape. So "invalid_date when due_date is not a date" yields
    // invalid_date and leaves due_date to the model check, which still warns
    // when the model lacks it (a field the entry mentions must not be
    // swallowed as a code).
    for (const entry of op.errors.split(/[,;\n]|\s\bor\b\s/)) {
      const [first, ...rest] = tokensOf(entry);
      if (first) codes.add(flatten(first));
      for (const token of rest) if (isErrorCodeShape(token)) codes.add(flatten(token));
    }
  }
  return codes;
}

/** The snake and camel words of a clause, in the order they are written. */
function tokensOf(text: string): string[] {
  const found: { at: number; token: string }[] = [];
  for (const re of [SNAKE, CAMEL]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) found.push({ at: m.index, token: m[0] });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.token);
}

function modelWarning(
  op: EngineOperation,
  base: string,
  fields: { name: string }[],
  operations: EngineOperation[],
  errorCodes: Set<string>,
): Draft | null {
  // A model with nothing but the pinned id row is not yet a model to check a
  // contract against, and warning on every token of a contract written before
  // the model is the fastest way to teach a learner to ignore this box.
  if (fields.length < 2) return null;
  const known = new Set<string>();
  for (const f of fields) if (f.name.trim()) known.add(flatten(f.name.trim()));
  for (const other of operations) known.add(flatten(baseName(other.name)));
  for (const p of paramsOf(op.name).split(/[,\s]+/)) if (p) known.add(flatten(p.replace(/[^\w]/g, '')));

  // The error line is not read: it names the codes an operation answers with,
  // and a code is never a field (`list_not_found` and `invalid_date` are not
  // fields the task model lacks). A code quoted in another clause
  // is skipped too, by the design's own codes, the catalogue's, or its shape.
  const clauses = [op.inputs, op.returns, op.ordering ?? '', op.boundary ?? ''];
  for (const value of clauses) {
    for (const re of [SNAKE, CAMEL]) {
      re.lastIndex = 0;
      for (let m = re.exec(value); m; m = re.exec(value)) {
        const token = m[0];
        const flat = flatten(token);
        if (NOT_A_FIELD.has(flat) || known.has(flat)) continue;
        if (errorCodes.has(flat) || isErrorCodeShape(token)) continue;
        return {
          ruleId: 'model',
          rule: 'model',
          said: token,
          against: fields.map((f) => f.name).filter(Boolean).join(', '),
          criterionId: null,
          text: `${base} reads ${token}, but the task model has no ${token} field.`,
        };
      }
    }
  }
  return null;
}

function signatureWarning(op: EngineOperation, base: string): Draft | null {
  const clause = op.inputs.trim();
  const params = paramsOf(op.name);
  if (!clause || !params || !claimAsserted(clause, CLAIMS_NO_INPUTS)) return null;
  return {
    ruleId: 'signature',
    rule: 'signature',
    said: claimed(clause, CLAIMS_NO_INPUTS),
    against: op.name,
    criterionId: null,
    // The API's own sentence, word for word, so a learner reads one sentence in
    // two places (`conformance.ts`, the inputs branch of `contradiction()`).
    text: `The design says ${base} takes no arguments, but the same block declares ${base}(${params}).`,
  };
}

/**
 * Every contradiction the editor can stand behind, in operation order and then
 * rule order. Empty is a real answer, and it is the answer for the scaffold as
 * it ships.
 */
export function contractWarnings(sources: WarningSources): ContractWarning[] {
  const { design, facts } = sources;
  const operations = engineOperations(design);
  const fields = engineFields(design);
  const errorCodes = errorCodesOf(operations, sources.errorCodes);
  const out: ContractWarning[] = [];
  for (const op of operations) {
    const base = baseName(op.name);
    if (!base) continue;
    const drafts = [
      orderingWarning(op, base, facts),
      boundaryWarning(op, base, facts),
      boundaryReturnsWarning(op, base),
      errorsWarning(op, base, facts),
      modelWarning(op, base, fields, operations, errorCodes),
      signatureWarning(op, base),
    ];
    for (const d of drafts) {
      if (!d) continue;
      out.push({
        id: `${d.ruleId}:${base}`,
        rule: d.rule,
        operation: base,
        said: d.said,
        against: d.against,
        criterionId: d.criterionId,
        text: d.text,
      });
      if (out.length >= MAX_WARNINGS) return out;
    }
  }
  return out;
}
