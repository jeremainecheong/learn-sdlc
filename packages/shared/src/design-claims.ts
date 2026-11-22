/**
 * The vocabulary that finds a design contract line stating the opposite of a
 * fact: the claim patterns, the hedge words that walk a sentence back, and the
 * sentence splitter they are read through.
 *
 * The review (`apps/api/src/feedback/conformance.ts`) and the Design editor's
 * live warnings (`apps/web/components/workspace/panels/design/contradictions.ts`)
 * must agree about the same sentence, so both read these patterns from here.
 * Each pattern is case-insensitive and has no global flag, so `test` keeps no
 * state between calls.
 */

/**
 * Words that walk a sentence back, so a contradiction pattern must not fire on
 * it. Deliberately narrow: "none" and "no" are how a learner states the
 * negative claim being looked for, so they cannot also be the hedge that hides
 * it.
 */
export const CLAIM_HEDGE = /\b(never|not|isn't|doesn't|won't|unless|rather than|instead of|except)\b/i;

/** The operation raises nothing. */
export const CLAIMS_NO_ERRORS =
  /^\s*(none|n\/a|nothing)\b|\bno errors?\b|\bnothing is raised\b|\bcannot fail\b|\braises? nothing\b|\bthrows? nothing\b/i;

/** The operation takes no input. Only a leading "none" counts: `keyword=None` in a signature must not. */
export const CLAIMS_NO_INPUTS =
  /^\s*(none|n\/a|nothing)\b|\bno (arguments?|args|inputs?|parameters?)\b|\btakes (nothing|no arguments?|no args|no inputs?|no parameters?)\b/i;

/** The operation returns nothing. */
export const CLAIMS_NO_RETURN =
  /^\s*(none|null|nothing|void)\s*[.;]?\s*$|\breturns? (nothing|none|null|void|no value)\b|\bno return value\b|\breturn type is void\b/i;

/**
 * "Due today is overdue" only. A correct contract also puts `today` next to
 * `overdue` ("overdue means the due date is before today"), so the subject has
 * to be the task that is due today, or the comparison has to be the wrong one.
 */
export const CLAIMS_TODAY_OVERDUE =
  /\b(due|dated)\s+today\b[^.;\n]{0,30}\b(is|are|counts? as|becomes?)\b[^.;\n]{0,20}\boverdue\b|\btoday\b\s+(is|counts as)\s+overdue\b|<=\s*today\b|\bon or before today\b|\btoday\b[^.;\n]{0,10}\binclusive\b|\binclusive of today\b/i;

/** Lowest priority first. */
export const CLAIMS_LOW_FIRST =
  /\b(low(est)?|ascending)\b[^.;\n]{0,30}\bfirst\b|\bascending (priority|order)\b|\bpriority ascending\b/i;

/** No meaningful order. */
export const CLAIMS_NO_ORDER =
  /\b(insertion|id) order\b|\bby id only\b|\bunordered\b|\bno particular order\b|\bany order\b/i;

/** A contract line's sentences: split after `.`, `;`, `!` or `?` and at line breaks, trimmed, blanks dropped. */
export const claimSentences = (value: string): string[] =>
  value
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** True when some sentence of `value` matches `pattern` without a hedge walking it back. */
export const claimAsserted = (value: string, pattern: RegExp): boolean =>
  claimSentences(value).some((sentence) => pattern.test(sentence) && !CLAIM_HEDGE.test(sentence));
