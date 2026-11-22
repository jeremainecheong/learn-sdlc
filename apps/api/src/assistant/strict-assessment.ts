import type { AiRubricReview } from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';

export interface SemanticAssessment {
  adequate: boolean;
  feedback: string;
  questions: string[];
}

export function parseAssessment(value: unknown): SemanticAssessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid assessment object');
  const row = value as Record<string, unknown>;
  if (typeof row.adequate !== 'boolean' || typeof row.feedback !== 'string' || !row.feedback.trim() ||
      !Array.isArray(row.questions) || row.questions.some(q => typeof q !== 'string' || !q.trim())) {
    throw new Error('Incomplete semantic assessment');
  }
  if (!row.adequate && row.questions.length === 0) throw new Error('Rejected assessment requires an actionable question');
  return { adequate: row.adequate, feedback: row.feedback.trim(), questions: row.questions as string[] };
}

/** No coercion: missing evidence and contradictory provider responses never earn a verdict. */
export function parseStrictReview(value: unknown, phase: PhaseContent): Omit<AiRubricReview, 'provider'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review object');
  const row = value as Record<string, unknown>;
  if (row.verdict !== 'pass' && row.verdict !== 'needs_revision') throw new Error('Missing binary verdict');
  for (const name of ['summary', 'processNote']) {
    if (typeof row[name] !== 'string' || !(row[name] as string).trim()) throw new Error(`Missing ${name}`);
  }
  for (const name of ['strengths', 'improvements']) {
    if (!Array.isArray(row[name]) || (row[name] as unknown[]).some(v => typeof v !== 'string')) throw new Error(`Invalid ${name}`);
  }
  if (!Array.isArray(row.criteriaEvidence) || row.criteriaEvidence.length !== phase.rubric.criteria.length || row.criteriaEvidence.length === 0) {
    throw new Error('Every rubric criterion needs explicit evidence');
  }
  const expected = new Set(phase.rubric.criteria.map(c => c.key));
  for (const criterion of row.criteriaEvidence) {
    if (!criterion || typeof criterion !== 'object' || !expected.delete(criterion.key) || typeof criterion.met !== 'boolean' ||
        typeof criterion.evidence !== 'string' || !criterion.evidence.trim() || typeof criterion.issue !== 'string' ||
        typeof criterion.nextStep !== 'string') throw new Error('Malformed criterion evidence');
    if (!criterion.met && (!criterion.issue.trim() || !criterion.nextStep.trim())) throw new Error('Unmet evidence requires an issue and next step');
    if (criterion.met && criterion.issue.trim()) throw new Error('Contradictory criterion evidence');
  }
  const allMet = row.criteriaEvidence.every(c => c.met);
  if ((row.verdict === 'pass') !== allMet) throw new Error('Verdict contradicts criterion evidence');
  if (!allMet && !(row.improvements as string[]).length) throw new Error('Revision requires actionable feedback');
  return {
    summary: (row.summary as string).trim(), strengths: row.strengths as string[], improvements: row.improvements as string[],
    processNote: (row.processNote as string).trim(), verdict: row.verdict, criteriaEvidence: row.criteriaEvidence,
  };
}
