/**
 * What a proposal changed, measured twice: in lines, and in what the bytes say.
 *
 * Line churn alone is the wrong number for this product. The generation call
 * is required to return complete revised file contents, so a whole-file reflow is the normal output, and for a JSON
 * artefact the line count is then dominated by formatting. A reflow reported as
 * "421 removed, 23 added" hides both the field that was added and the paragraph
 * that was deleted.
 *
 * So each file gets two numbers:
 *
 * - **line churn**, `adds + dels`, taken from the line diff the page already
 *   draws and never recomputed here, so the summary cannot disagree with the
 *   table beneath it;
 * - **meaning**, which is field differences for a `.json` file both of whose
 *   copies parse, and differing word occurrences for everything else.
 *
 * Honest limits, because the copy on screen has to be true at every instant:
 *
 * - The word count is a **multiset difference**, not an edit distance.
 *   Rewrapped or reindented prose scores 0, and so do the same words in a
 *   different order. That is the right reading for the reflow question, it is
 *   O(n) so it is safe to recompute while the learner types, and the copy says
 *   "word occurrences" rather than pretending to measure meaning.
 * - Array elements are matched by an identity key only when every element on
 *   both sides carries one uniquely; otherwise by index. Identity matching
 *   would make a pure reordering invisible, and order carries meaning (an
 *   acceptance criterion is addressed by its position), so an element that kept
 *   its identity and lost its place is reported as `moved` and counted, by its
 *   rank among the elements present in both copies rather than by its index in
 *   either, so the two numbers are comparable with each other and cannot read
 *   "2 → 2". Rank comparison is O(n) and can name more moved elements than a
 *   minimal edit script would; it never names fewer, and silence is the failure
 *   this module exists to prevent.
 * - Nothing here calls a change unrelated, wrong or invented. It reports
 *   arithmetic and field paths. The learner judges.
 *
 * Pure: no React, no fetch, no clock, no storage.
 */

import { isObject } from '@learnsdlc/shared';

/** Churned lines below which a proposal is small enough to simply read. */
export const CHURN_MIN_LINES = 40;
/** Churned lines per measured difference before the churn is worth a warning. */
export const CHURN_RATIO = 8;
/** Leaves compared before a comparison reports itself unmeasured. */
export const MAX_LEAVES = 20_000;
/** Nesting depth walked before a comparison reports itself unmeasured. */
export const MAX_DEPTH = 64;
/** Field rows drawn per group before "…and n more fields." */
export const MAX_FIELD_ROWS = 50;
/** Characters of an identity value kept inside a field path. */
export const MAX_IDENTITY_CHARS = 60;
/** Above this a request is a stored envelope rather than something typed. */
export const MAX_REQUEST_CHARS = 65_536;

export type MeaningKind = 'json-fields' | 'word-occurrences' | 'unmeasured';
export type JsonParseState = 'not-json' | 'both' | 'saved-only' | 'proposed-only' | 'neither';

export interface FieldChange {
  /** A canonical leaf path, or for a move the element's identified path. */
  path: string;
  /** The saved side's serialised leaf, or a moved element's 1-based rank. */
  before?: string;
  /** The proposed side's serialised leaf, or its new 1-based rank. */
  after?: string;
}

export interface StructuralDiff {
  added: FieldChange[];
  removed: FieldChange[];
  changed: FieldChange[];
  /**
   * Elements that kept their identity and lost their place in an array. Both
   * positions are ranks among the entries present in both copies, so they are
   * comparable with each other and always differ.
   */
  moved: FieldChange[];
  count: number;
  /** A cap was hit, so the lists are partial and must not be drawn as complete. */
  truncated: boolean;
}

export interface ChangeAnalysis {
  path: string;
  adds: number;
  dels: number;
  lineChurn: number;
  meaning: number;
  meaningKind: MeaningKind;
  structural: StructuralDiff | null;
  jsonParse: JsonParseState;
  churnFlag: boolean;
}

export interface ProposalChurn {
  lineChurn: number;
  meaning: number;
  /** Files that were both changed and measurable. */
  files: number;
  kind: MeaningKind | 'mixed' | 'none';
  flag: boolean;
}

type JsonObject = Record<string, unknown>;


/**
 * A scalar, or a container with nothing in it: the smallest thing one path can
 * name. An empty object or array is a leaf on purpose, so "this ledger became
 * empty" is a visible change rather than silence.
 */
function leafOf(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : null;
  if (isObject(value)) return Object.keys(value).length === 0 ? '{}' : null;
  return JSON.stringify(value) ?? 'null';
}

/** The two leaves that stand for a container with nothing in it. */
const EMPTY_CONTAINERS = new Set(['{}', '[]']);
/** What a container with something in it is called beside an empty one. */
const containerKind = (node: unknown) => (Array.isArray(node) ? '[…]' : '{…}');

/** A path segment that cannot be confused with the syntax around it. */
const escapeSegment = (segment: string) => segment.replace(/([\\.[\]=])/g, '\\$1');
const childPath = (parent: string, segment: string) => (parent === '' ? segment : `${parent}.${segment}`);
const indexPath = (parent: string, index: number) => `${parent}[${index}]`;
const identityPath = (parent: string, key: string, value: string) =>
  `${parent}[${escapeSegment(key)}=${escapeSegment(value.slice(0, MAX_IDENTITY_CHARS))}]`;

/** Keys an array's elements may be matched by, in order of preference. */
const IDENTITY_KEYS = ['id', 'key', 'name', 'path', 'operationId', 'code'] as const;

/** Every element's value for `key`, as text, or null when it cannot identify. */
function identityValues(rows: JsonObject[], key: string): string[] | null {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value);
    if (!text || seen.has(text)) return null;
    seen.add(text);
    values.push(text);
  }
  return values;
}

function identityKey(saved: unknown[], proposed: unknown[]): string | null {
  if (!saved.every(isObject) || !proposed.every(isObject)) return null;
  for (const key of IDENTITY_KEYS) {
    if (identityValues(saved as JsonObject[], key) && identityValues(proposed as JsonObject[], key)) return key;
  }
  return null;
}

/** Which fields differ between two parsed values, by path rather than by line. */
export function structuralDiff(saved: unknown, proposed: unknown): StructuralDiff {
  const out: StructuralDiff = { added: [], removed: [], changed: [], moved: [], count: 0, truncated: false };
  let spent = 0;
  const spend = () => {
    spent += 1;
    if (spent > MAX_LEAVES) {
      out.truncated = true;
      return false;
    }
    return true;
  };

  /** Every leaf of a subtree that exists on one side only. */
  const collect = (node: unknown, path: string, depth: number, sink: FieldChange[], side: 'before' | 'after') => {
    if (out.truncated) return;
    if (depth > MAX_DEPTH) {
      out.truncated = true;
      return;
    }
    const leaf = leafOf(node);
    if (leaf !== null) {
      if (!spend()) return;
      sink.push(side === 'before' ? { path, before: leaf } : { path, after: leaf });
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        collect(node[index], indexPath(path, index), depth + 1, sink, side);
        if (out.truncated) return;
      }
      return;
    }
    for (const [key, item] of Object.entries(node as JsonObject)) {
      collect(item, childPath(path, escapeSegment(key)), depth + 1, sink, side);
      if (out.truncated) return;
    }
  };

  const walkArrays = (savedRows: unknown[], proposedRows: unknown[], path: string, depth: number) => {
    const key = identityKey(savedRows, proposedRows);
    if (key === null) {
      const shared = Math.min(savedRows.length, proposedRows.length);
      for (let index = 0; index < shared; index += 1) {
        walk(savedRows[index], proposedRows[index], indexPath(path, index), depth + 1);
        if (out.truncated) return;
      }
      for (let index = shared; index < savedRows.length; index += 1) {
        collect(savedRows[index], indexPath(path, index), depth + 1, out.removed, 'before');
        if (out.truncated) return;
      }
      for (let index = shared; index < proposedRows.length; index += 1) {
        collect(proposedRows[index], indexPath(path, index), depth + 1, out.added, 'after');
        if (out.truncated) return;
      }
      return;
    }
    const savedAt = new Map<string, number>();
    const proposedAt = new Map<string, number>();
    savedRows.forEach((row, index) => savedAt.set(String((row as JsonObject)[key]), index));
    proposedRows.forEach((row, index) => proposedAt.set(String((row as JsonObject)[key]), index));
    for (const [identity, index] of savedAt) {
      const match = proposedAt.get(identity);
      const segment = identityPath(path, key, identity);
      if (match === undefined) collect(savedRows[index], segment, depth + 1, out.removed, 'before');
      else walk(savedRows[index], proposedRows[match], segment, depth + 1);
      if (out.truncated) return;
    }
    for (const [identity, index] of proposedAt) {
      if (savedAt.has(identity)) continue;
      collect(proposedRows[index], identityPath(path, key, identity), depth + 1, out.added, 'after');
      if (out.truncated) return;
    }
    // Order is meaning. An element that survived and changed its rank among the
    // other survivors is reported, never absorbed into silence.
    //
    // Both numbers are that rank, never the element's absolute index: a removal
    // ahead of an element and an insertion behind it cancel in the index, and a
    // row reading "position 2 → 2" would contradict itself. The emitting rule
    // has already established the two ranks differ, so by construction they do.
    const before = [...savedAt.keys()].filter(identity => proposedAt.has(identity));
    const after = [...proposedAt.keys()].filter(identity => savedAt.has(identity));
    const afterRank = new Map(after.map((identity, rank) => [identity, rank]));
    for (let rank = 0; rank < before.length; rank += 1) {
      const identity = before[rank];
      if (after[rank] === identity) continue;
      if (!spend()) return;
      out.moved.push({
        path: identityPath(path, key, identity),
        before: String(rank + 1),
        after: String((afterRank.get(identity) ?? rank) + 1),
      });
    }
  };

  const walk = (savedNode: unknown, proposedNode: unknown, path: string, depth: number) => {
    if (out.truncated) return;
    if (depth > MAX_DEPTH) {
      out.truncated = true;
      return;
    }
    const savedLeaf = leafOf(savedNode);
    const proposedLeaf = leafOf(proposedNode);
    if (savedLeaf !== null && proposedLeaf !== null) {
      if (!spend()) return;
      if (savedLeaf !== proposedLeaf) out.changed.push({ path, before: savedLeaf, after: proposedLeaf });
      return;
    }
    // A container that was emptied was not added, and one that gained its first
    // entry was not removed: the container itself changed, and the leaves it
    // lost or gained are listed beside it. Calling either side an addition
    // would print a row naming the whole document as the thing added, and count
    // one removal twice.
    if (savedLeaf !== null) {
      if (!spend()) return;
      if (EMPTY_CONTAINERS.has(savedLeaf)) out.changed.push({ path, before: savedLeaf, after: containerKind(proposedNode) });
      else out.removed.push({ path, before: savedLeaf });
      collect(proposedNode, path, depth, out.added, 'after');
      return;
    }
    if (proposedLeaf !== null) {
      if (!spend()) return;
      if (EMPTY_CONTAINERS.has(proposedLeaf)) out.changed.push({ path, before: containerKind(savedNode), after: proposedLeaf });
      else out.added.push({ path, after: proposedLeaf });
      collect(savedNode, path, depth, out.removed, 'before');
      return;
    }
    if (Array.isArray(savedNode) !== Array.isArray(proposedNode)) {
      collect(savedNode, path, depth, out.removed, 'before');
      collect(proposedNode, path, depth, out.added, 'after');
      return;
    }
    if (Array.isArray(savedNode) && Array.isArray(proposedNode)) {
      walkArrays(savedNode, proposedNode, path, depth);
      return;
    }
    const savedFields = savedNode as JsonObject;
    const proposedFields = proposedNode as JsonObject;
    const keys = [...Object.keys(savedFields), ...Object.keys(proposedFields).filter(key => !(key in savedFields))];
    for (const key of keys) {
      const segment = childPath(path, escapeSegment(key));
      if (key in savedFields && key in proposedFields) walk(savedFields[key], proposedFields[key], segment, depth + 1);
      else if (key in savedFields) collect(savedFields[key], segment, depth + 1, out.removed, 'before');
      else collect(proposedFields[key], segment, depth + 1, out.added, 'after');
      if (out.truncated) return;
    }
  };

  walk(saved, proposed, '', 0);
  out.count = out.added.length + out.removed.length + out.changed.length + out.moved.length;
  return out;
}

const tokensOf = (text: string) => text.replace(/\r\n?/g, '\n').split(/\s+/).filter(Boolean);

/**
 * How many word occurrences differ: a multiset difference, so rewrapping and
 * reindenting score 0, and so does reordering the same words.
 */
export function tokenBagDelta(saved: string, proposed: string): number {
  const counts = new Map<string, number>();
  for (const token of tokensOf(saved)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of tokensOf(proposed)) counts.set(token, (counts.get(token) ?? 0) - 1);
  let delta = 0;
  for (const count of counts.values()) delta += Math.abs(count);
  return delta;
}

function parseJson(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

const flagged = (kind: MeaningKind, lineChurn: number, meaning: number) =>
  kind !== 'unmeasured' && lineChurn >= CHURN_MIN_LINES && lineChurn >= CHURN_RATIO * Math.max(meaning, 1);

/**
 * One file's two numbers. `churn` is the line diff the page already computed.
 * A file with no saved copy is unmeasured: there is nothing for its bytes to be
 * mostly a reformatting of.
 */
export function analyseChange(
  path: string,
  saved: string | undefined,
  proposed: string,
  churn: { adds: number; dels: number },
): ChangeAnalysis {
  const base = { path, adds: churn.adds, dels: churn.dels, lineChurn: churn.adds + churn.dels };
  if (saved === undefined) {
    return { ...base, meaning: 0, meaningKind: 'unmeasured', structural: null, jsonParse: 'not-json', churnFlag: false };
  }
  const words = () => {
    const meaning = tokenBagDelta(saved, proposed);
    return { meaning, meaningKind: 'word-occurrences' as const, structural: null, churnFlag: flagged('word-occurrences', base.lineChurn, meaning) };
  };
  if (!path.toLowerCase().endsWith('.json')) return { ...base, ...words(), jsonParse: 'not-json' };
  const savedValue = parseJson(saved);
  const proposedValue = parseJson(proposed);
  const jsonParse: JsonParseState = savedValue.ok && proposedValue.ok ? 'both'
    : savedValue.ok ? 'saved-only' : proposedValue.ok ? 'proposed-only' : 'neither';
  if (jsonParse !== 'both') return { ...base, ...words(), jsonParse };
  const structural = structuralDiff(savedValue.value, proposedValue.value);
  const meaningKind: MeaningKind = structural.truncated ? 'unmeasured' : 'json-fields';
  return {
    ...base, meaning: structural.count, meaningKind, structural, jsonParse,
    churnFlag: flagged(meaningKind, base.lineChurn, structural.count),
  };
}

/** The whole proposal, counting only the files that changed and were measured. */
export function proposalChurn(analyses: ChangeAnalysis[]): ProposalChurn {
  const measured = analyses.filter(analysis => analysis.meaningKind !== 'unmeasured' && analysis.lineChurn > 0);
  const lineChurn = measured.reduce((total, analysis) => total + analysis.lineChurn, 0);
  const meaning = measured.reduce((total, analysis) => total + analysis.meaning, 0);
  const kinds = new Set(measured.map(analysis => analysis.meaningKind));
  return {
    lineChurn,
    meaning,
    files: measured.length,
    kind: measured.length === 0 ? 'none' : kinds.size > 1 ? 'mixed' : [...kinds][0],
    flag: measured.some(analysis => analysis.churnFlag) || (lineChurn >= 200 && lineChurn >= CHURN_RATIO * Math.max(meaning, 1)),
  };
}

/**
 * The learner's own sentence in which they asked for a narrow change, verbatim,
 * or null.
 *
 * It answers one observable question (did the learner themself ask for a
 * narrow change, in these words?) and never infers a line budget from free
 * text. A stored chat context envelope is JSON rather than a request, so it is
 * refused outright rather than quoted back as something the learner wrote.
 *
 * What is returned is a **whole sentence**, never the matched phrase alone. A
 * bare fragment drops whatever governs it: "Add a 409 to completeTask and don't
 * change anything else" would be quoted as "don't change", which loses the
 * scope and reads as a blanket prohibition, and "I don't change my approach
 * lightly, but rewrite the whole module" would be quoted the same way for a
 * request that asked for the opposite. A sentence the learner wrote can be put
 * in quotation marks under their name. A fragment of one cannot.
 */
const NARROW_PHRASES = [
  'change nothing else',
  'changing nothing else',
  'nothing else',
  'do not change',
  "don't change",
  'don’t change',
  'without changing',
  'only the',
  'only this',
  'only that',
  'just the',
  'one line',
  'a single line',
  'a single field',
];

/** Where one sentence of a typed request ends and the next begins. */
const SENTENCE_BREAK = /[.!?;\n\r]/;
/** Longer than this is a paragraph, and a notice quotes no paragraphs. */
const MAX_QUOTE_CHARS = 200;

export function narrowRequestSentence(request: string | undefined | null): string | null {
  if (!request || request.length > MAX_REQUEST_CHARS) return null;
  try {
    const value: unknown = JSON.parse(request);
    if (value && typeof value === 'object') return null;
  } catch {
    /* A learner's request is plain text. */
  }
  const haystack = request.toLowerCase();
  let best: { at: number; length: number } | null = null;
  for (const phrase of NARROW_PHRASES) {
    const at = haystack.indexOf(phrase);
    if (at < 0) continue;
    if (!best || phrase.length > best.length) best = { at, length: phrase.length };
  }
  if (!best) return null;
  let start = 0;
  for (let index = best.at - 1; index >= 0; index -= 1) {
    if (SENTENCE_BREAK.test(request[index])) { start = index + 1; break; }
  }
  let end = request.length;
  for (let index = best.at + best.length; index < request.length; index += 1) {
    if (SENTENCE_BREAK.test(request[index])) { end = index + 1; break; }
  }
  const sentence = request.slice(start, end).trim();
  return sentence.length === 0 || sentence.length > MAX_QUOTE_CHARS ? null : sentence;
}
