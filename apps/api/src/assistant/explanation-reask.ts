/**
 * The explanation re-ask: what the API may tell the explanation assessor
 * about its own refused answer, and nothing more.
 *
 * `parseModelExplanationAssessment` refuses an answer it cannot read as a
 * valid assessment: a dimension whose met value and finding disagree
 * (`inconsistent_finding`), a met dimension citing nothing, an evidence id the
 * answer does not have, a missing or repeated dimension, a field the schema
 * does not allow. Ending the learner's explanation there as
 * `assessment_unavailable` would waste an answer that came back in seconds, so
 * the API asks once more inside the same explanation call, and this file
 * writes the one note the second request adds.
 *
 * The gate is the same for both: the second answer is judged by the same parser, an
 * explanation is approved only by a valid assessment whose every dimension is
 * met, and a second refusal fails the turn as a first one would without the
 * re-ask. An approval is
 * never invented here, and the note is neutral: it never says which way any
 * dimension should go.
 *
 * What may reach the note: fixed copy and the gate's own four dimension keys,
 * printed as `UNDERSTANDING_DIMENSIONS` spells them. Never the refused answer's
 * keys, findings or evidence ids as it wrote them, and never a word of the
 * learner's explanation (the first request already carried it unchanged).
 *
 * Like `explanation-assessment.ts`, this module imports nothing that could
 * reach a decorator or a database.
 */
import { reaskFits } from './re-ask';
import { UNDERSTANDING_DIMENSIONS, UNDERSTANDING_FINDINGS, explanationAssessmentFailure, explanationEvidence } from './explanation-assessment';

type Dimension = typeof UNDERSTANDING_DIMENSIONS[number];

export interface ExplanationRefusal {
  /** The parser's own fixed classification (`explanationAssessmentFailure`). */
  code: string;
  /** The gate's dimension keys the refusal concerns, in the gate's order; may be empty. */
  keys: Dimension[];
}

interface Row { key?: unknown; met?: unknown; finding?: unknown; learnerEvidenceIds?: unknown }

const rowsOf = (answer: unknown): Row[] => {
  const dimensions = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>).dimensions : undefined;
  return Array.isArray(dimensions) ? dimensions.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
};
const ids = (row: Row): unknown[] | null => (Array.isArray(row.learnerEvidenceIds) ? row.learnerEvidenceIds : null);

/**
 * Which of the gate's dimensions a refused answer shows the refusal on, read
 * with the parser's own predicates (`parseExplanationAssessment` and
 * `parseModelExplanationAssessment`) from the answer the parser refused.
 * Every dimension that shows it is named, not only the first the parser
 * stopped at; a key the gate does not have is never named.
 */
export function readExplanationRefusal(error: unknown, answer: unknown, explanation: string): ExplanationRefusal {
  const code = explanationAssessmentFailure(error);
  const rows = rowsOf(answer);
  const named = (pick: (row: Row) => boolean): Dimension[] => {
    const hit = new Set(rows.filter(pick).map(row => row.key));
    return UNDERSTANDING_DIMENSIONS.filter(key => hit.has(key));
  };
  // A key the answer did not give exactly once, or gave with a met value that is not true or false.
  const misshapen = (): Dimension[] => UNDERSTANDING_DIMENSIONS.filter(key => {
    const own = rows.filter(row => row.key === key);
    return own.length !== 1 || typeof own[0].met !== 'boolean';
  });
  const units = new Set(explanationEvidence(explanation).map(unit => unit.id));
  switch (code) {
    case 'inconsistent_finding':
      return { code, keys: named(row => !UNDERSTANDING_FINDINGS.includes(row.finding as typeof UNDERSTANDING_FINDINGS[number]) || row.met !== (row.finding === 'supported') ||
        (row.key === 'consistency' && row.finding === 'missing') || (row.key !== 'consistency' && row.finding === 'assessment_override')) };
    case 'missing_positive_evidence':
      return { code, keys: named(row => row.met === true && ids(row)?.length === 0) };
    case 'missing_adverse_claim':
      return { code, keys: named(row => row.finding !== 'missing' && row.met === false && ids(row)?.length === 0) };
    case 'unknown_learner_evidence_reference':
      return { code, keys: named(row => { const cited = ids(row); return !cited || cited.some(id => typeof id !== 'string' || !units.has(id)); }) };
    case 'incomplete_dimensions':
    case 'malformed_dimension':
      return { code, keys: misshapen() };
    default:
      return { code, keys: [] };
  }
}

export const EXPLANATION_REASK_OPEN = 'Your previous answer to this explanation review was refused because the server could not read it as a valid assessment, so no assessment was recorded.';
export const EXPLANATION_REASK_CLOSE = 'Judge every dimension again from learnerAnswer, the reference and the evidence alone; this note does not say which way any dimension should go. Then return an answer that agrees with itself: exactly the four dimensions, each key once, and no other field; met is true exactly when finding is supported; consistency never takes missing, and only consistency may take assessment_override; a met dimension cites at least one learnerEvidenceIds entry, and an unmet dimension whose finding is not missing cites the learner statement it judged; learnerEvidenceIds are only answerEvidence ids.';

const PLAIN = 'It did not follow the answer schema';
const SENTENCE: Record<string, string> = {
  invalid_object: 'It was not one object holding the dimensions list',
  incomplete_dimensions: 'It did not return exactly four dimensions',
  invalid_dimension: 'One of its dimensions was not an object',
  malformed_dimension: 'It did not give each dimension key exactly once with a true or false met',
  unknown_learner_evidence_reference: 'It cited learnerEvidenceIds that are not answerEvidence ids',
  missing_positive_evidence: 'It marked a dimension met without citing any learnerEvidenceIds',
  unexpected_output_field: 'It returned a field the schema does not allow',
  inconsistent_finding: 'Its met value and its finding disagree, or a dimension took a finding it may not take',
  missing_adverse_claim: 'It marked a dimension not met, with a finding other than missing, without citing the learner statement it judged',
};

/** The second request's one added note: fixed copy and the gate's own keys. */
export function explanationReaskNote(refusal: ExplanationRefusal): string {
  const sentence = Object.prototype.hasOwnProperty.call(SENTENCE, refusal.code) ? SENTENCE[refusal.code] : PLAIN;
  const keys = UNDERSTANDING_DIMENSIONS.filter(key => refusal.keys.includes(key));
  return `${EXPLANATION_REASK_OPEN}\n${sentence}${keys.length ? `; the dimensions concerned: ${keys.join(', ')}` : ''}.\n${EXPLANATION_REASK_CLOSE}`;
}

/**
 * The least of the Agentic route's 55 s budget that must be left for the
 * second ask to be sent: ten seconds of margin plus the explanation call at
 * its slowest. Measured over 109 calls, `agentic.explanation` took 2.3 s at
 * the median, 3.1 s at p95 and 3.9 s at most, so 14 s is 10 s plus the maximum
 * rounded up, above 10 s plus the p95. The ask itself is still cut off by the
 * route's own deadline; the budget is never raised.
 */
export const EXPLANATION_REASK_FLOOR_MS = 14_000;

/** The margin above the first ask's own duration (the floor's own ten seconds). */
export const EXPLANATION_REASK_MARGIN_MS = 10_000;

/**
 * Whether the second ask may be sent: at least the floor, and at least
 * as long as the first ask itself took plus the margin, must be left of the
 * route's budget. A slow first ask (a queue at the AI gate, a slow provider)
 * says a second may be as slow, and one that cannot finish would only make
 * the learner wait to the deadline for the same failed explanation. The same
 * shape as the route's regeneration check, which also weighs its first call.
 */
export const explanationReaskFits = (remainingMs: number, firstMs: number): boolean =>
  reaskFits(remainingMs, firstMs, EXPLANATION_REASK_FLOOR_MS, EXPLANATION_REASK_MARGIN_MS);
