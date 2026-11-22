import type { FeedbackReport, PhaseRubric } from '@learnsdlc/shared';

/**
 * A report the strict-evidence gate accepts for a task marked by `rubric`:
 * `strict_binary`, every criterion met with evidence, every check passed, and
 * a green suite. The shape `advance`'s `strictPass` asks for, so a
 * revision carrying it is the "reviewed pass" the door opens on.
 */
export function strictlyReviewed(rubric: PhaseRubric): FeedbackReport {
  return {
    assessmentMode: 'strict_binary',
    passed: true,
    checks: [{ id: 'fixture', label: 'Fixture check', status: 'passed', detail: 'The door test isolates the gate.' }],
    tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
    aiReview: {
      provider: 'mock-ai',
      verdict: 'pass',
      criteriaEvidence: rubric.criteria.map((criterion) => ({
        key: criterion.key,
        met: true,
        evidence: 'Fixture evidence for the door test only.',
        issue: '',
        nextStep: '',
      })),
    },
  } as unknown as FeedbackReport;
}
