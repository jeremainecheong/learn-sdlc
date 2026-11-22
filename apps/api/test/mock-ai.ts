import type { PhaseContent } from '../src/content/content.types';
import type { ReviewInput } from '../src/assistant/provider.types';

/** Deterministic TEST DOUBLE for API/DB authorization and orchestration tests.
 * This is not semantic assessment coverage: it says nothing about what a hosted provider would answer.
 */
export const mockAiForRoutes = {
  available: true,
  name: 'mock-ai',
  chat: jest.fn(async (ctx: any) => ({ provider: 'mock-ai', content: `${ctx.instructorNotes?.length ? `Your instructor's note for this class: ${ctx.instructorNotes.join(' ')}\n` : ''}Which observable boundary would distinguish the expected behavior from a failure?`, tokensIn: 1, tokensOut: 1 })),
  interview: jest.fn(async (brief: any, _project: string, _question: string, settled: string[]) => {
    const fact = brief.facts.find((f: any) => !settled.includes(f.id));
    return { provider: 'mock-ai', content: fact ? fact.answer : brief.unknownReply, tokensIn: 1, tokensOut: 1 };
  }),
  reviewInterview: jest.fn(async (input: { answer: string; brief: { facts: Array<{ id: string; answer: string }> } }) => ({ safe: true, failedChecks: [], supportedFactIds: input.brief.facts.filter(fact => fact.answer === input.answer).map(fact => fact.id), tokensIn: 0, tokensOut: 0 })),
  review: jest.fn(async (phase: PhaseContent, input: ReviewInput) => {
    const met = input.checks.length > 0 && input.checks.every(c => c.status === 'passed' || c.status === 'info');
    // Teacher-authored projects: the evidence is counted against the
    // rubric the GATE is counted against, which is the task's where there is
    // one. `strictTaskEvidencePassed` demands exact coverage, so a double that
    // answered the phase's union of criteria would fail every task of a split
    // phase for a reason that is about the double. On a sole task
    // `task.rubric` IS `phase.rubric`, so nothing else in the suite moves.
    const rubric = input.task?.rubric ?? phase.rubric;
    return {
      provider: 'mock-ai', verdict: met ? 'pass' : 'needs_revision', summary: 'Mocked semantic review for route persistence and authority tests.',
      strengths: [], improvements: met ? [] : ['Revise the failing evidence.'], processNote: 'Provider is explicitly mocked in this integration suite.',
      criteriaEvidence: rubric.criteria.map(c => ({ key: c.key, met, evidence: 'Synthetic semantic finding; automated checks execute separately.', issue: met ? '' : 'A required check failed.', nextStep: met ? '' : 'Revise the identified check.' })),
      tokensIn: 1, tokensOut: 1,
    };
  }),
};
