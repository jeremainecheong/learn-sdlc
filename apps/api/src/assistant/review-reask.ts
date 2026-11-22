/**
 * The review re-ask: what the API may tell the reviewer about its own
 * refused answer, and nothing more.
 *
 * `parseStrictReview` refuses an answer that contradicts its own criterion
 * evidence (a pass over an unmet criterion, a needs_revision over every
 * criterion met, a met criterion carrying an issue, an unmet one without an
 * issue and a next step, a revision with no improvement). Ending the review
 * there as "Review unavailable" would waste an answer that came back in
 * seconds, so the API asks the reviewer once more inside the same review, and
 * this file writes the one note the second briefing adds.
 *
 * The integrity rule is the same for both: the second answer is judged by the
 * same parser and the same grounding checks, and a second refusal leaves the
 * review unavailable, as a first one would without the re-ask. A verdict is never invented here; the note is
 * neutral and never says which way a criterion should go.
 *
 * What may reach the note: fixed copy and the rubric's own criterion keys.
 * Never the first answer's summary, evidence, issues, improvements or keys as
 * it wrote them (a key is kept only when the rubric has it, and is printed as
 * the rubric spells it).
 */

export type ReviewContradictionKind =
  | 'pass_with_unmet'
  | 'revision_with_all_met'
  | 'met_with_issue'
  | 'unmet_without_issue'
  | 'revision_without_improvements';

export interface ReviewContradiction {
  kind: ReviewContradictionKind;
  /** Rubric keys, in the rubric's order; never empty. */
  keys: string[];
}

/** The parser's consistency refusals, word for word (`strict-assessment.ts`). */
const CONSISTENCY_REFUSALS = new Set([
  'Unmet evidence requires an issue and next step',
  'Contradictory criterion evidence',
  'Verdict contradicts criterion evidence',
  'Revision requires actionable feedback',
]);

interface Row { key: unknown; met: unknown; issue: unknown; nextStep: unknown }

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Which contradiction a refused answer shows, read with the parser's own
 * predicates from the answer the parser refused; null for any refusal that is
 * not a consistency one (a malformed, incomplete or ungrounded answer is not
 * re-asked) and whenever the answer does not show what its message names.
 */
export function readReviewContradiction(message: string, answer: unknown, rubricKeys: readonly string[]): ReviewContradiction | null {
  if (!CONSISTENCY_REFUSALS.has(message)) return null;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const value = answer as Record<string, unknown>;
  if (!Array.isArray(value.criteriaEvidence)) return null;
  const rows = value.criteriaEvidence.filter((row): row is Row => !!row && typeof row === 'object');
  const named = (pick: (row: Row) => boolean): string[] => {
    const hit = new Set(rows.filter(pick).map(row => row.key));
    return rubricKeys.filter(key => hit.has(key));
  };
  const found = (kind: ReviewContradictionKind, keys: string[]): ReviewContradiction | null => (keys.length ? { kind, keys } : null);
  const allMet = rows.length > 0 && rows.every(row => row.met === true);
  switch (message) {
    case 'Unmet evidence requires an issue and next step':
      return found('unmet_without_issue', named(row => row.met === false && (!text(row.issue) || !text(row.nextStep))));
    case 'Contradictory criterion evidence':
      return found('met_with_issue', named(row => row.met === true && !!text(row.issue)));
    case 'Verdict contradicts criterion evidence':
      if (value.verdict === 'pass' && !allMet) return found('pass_with_unmet', named(row => row.met !== true));
      if (value.verdict === 'needs_revision' && allMet) return found('revision_with_all_met', named(row => row.met === true));
      return null;
    default: // 'Revision requires actionable feedback'
      if (allMet || !Array.isArray(value.improvements) || value.improvements.length) return null;
      return found('revision_without_improvements', named(row => row.met !== true));
  }
}

export const REVIEW_REASK_OPEN = 'Your previous answer to this review was refused because it contradicted itself, so no verdict was recorded.';
export const REVIEW_REASK_CLOSE = 'Judge every criterion again from the submitted evidence alone; this note does not say which way any criterion should go. Then make the answer agree with itself: a met criterion names no issue; an unmet criterion names an issue and a next step, and the answer lists at least one improvement; the verdict is pass only when every criterion is met, otherwise needs_revision.';

const SENTENCE: Record<ReviewContradictionKind, string> = {
  pass_with_unmet: 'It gave the verdict pass while it marked these criteria not met',
  revision_with_all_met: 'It gave the verdict needs_revision while it marked every criterion met',
  met_with_issue: 'It marked these criteria met while it named an issue for them',
  unmet_without_issue: 'It marked these criteria not met without naming both an issue and a next step',
  revision_without_improvements: 'It marked these criteria not met but listed no improvement',
};

/** The second briefing's one added note: fixed copy and the rubric keys. */
export function reviewReaskNote(contradiction: ReviewContradiction): string {
  return `${REVIEW_REASK_OPEN}\n${SENTENCE[contradiction.kind]}: ${contradiction.keys.join(', ')}.\n${REVIEW_REASK_CLOSE}`;
}

const CARRIED = Symbol('reviewContradiction');

/** The refusal keeps its message and class; the contradiction rides beside it. */
export function withReviewContradiction<E extends Error>(error: E, contradiction: ReviewContradiction | null): E {
  if (contradiction) Object.defineProperty(error, CARRIED, { value: contradiction, enumerable: false });
  return error;
}

export function reviewContradictionOf(error: unknown): ReviewContradiction | null {
  return error instanceof Error ? ((error as unknown as Record<symbol, ReviewContradiction | undefined>)[CARRIED] ?? null) : null;
}

/**
 * The least of the review's window that must be left for the second ask to
 * be sent. Measured over 69 calls, the review call took 5.7 s at the median,
 * 8.0 s at p95 and 10.1 s at most, so ten seconds is room for a typical answer; the
 * ask itself is still cut off at the window's end.
 */
export const REVIEW_REASK_FLOOR_MS = 10_000;

/** Why a second ask was ended: the review's window ran out. Classified as a provider failure, never a verdict. */
export const REVIEW_REASK_DEADLINE = 'AI review re-ask ran past the review window';
