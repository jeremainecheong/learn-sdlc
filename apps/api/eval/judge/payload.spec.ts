import { KNOWN_MODELS } from '../contracts';
import { judgeContext, renderOutput } from './payload';
import { absoluteSystemPrompt, parseAbsolute, parsePairwise, pairwiseSystemPrompt } from './rubrics';

/* Judges are blind: nothing a judge reads names a model, a family or a provider. */
describe('judge payloads are blind', () => {
  const c = {
    id: 'case-1', jobType: 'mentor-turn', schemaVersion: 1, source: {}, tags: { project: 'starter', phase: 'requirements' },
    input: { mentorContext: { message: 'Where do I start?', workspace: { 'requirements/story.json': '{"id":"SH-5","title":"My story"}' }, history: [] } },
    reference: { expected: { expectation: 'one next step', guardrails: ['no artefact'] } },
  } as never;
  const raw = { modelKey: 'llama33-70b', caseId: 'case-1', jobType: 'mentor-turn', product: { useCase: 'mentor', delivered: true, reply: 'Which sentence of the brief names the borrower?' }, calls: [] };

  it('carries no model key, provider or family name', () => {
    const text = JSON.stringify({ context: judgeContext(c), output: renderOutput(c, raw as never) }) + absoluteSystemPrompt('mentor') + pairwiseSystemPrompt('mentor');
    for (const slot of KNOWN_MODELS) {
      expect(text).not.toContain(slot.key);
      expect(text).not.toContain(slot.modelId);
    }
    expect(text).not.toMatch(/\b(llama|mistral|ministral|qwen|deepseek|nova|claude|gpt-oss|gpt-5|openai|bedrock|anthropic)\b/i);
  });

  it('parses judgements strictly', () => {
    const ok = { scores: { diagnostic_accuracy: { score: 4, justification: 'x' }, actionability: { score: 3, justification: 'x' }, no_solution_dump: { score: 5, justification: 'x' }, tone: { score: 4, justification: 'x' } } };
    expect(parseAbsolute('mentor', ok).tone.score).toBe(4);
    expect(() => parseAbsolute('mentor', { scores: { ...ok.scores, tone: { score: 6, justification: 'x' } } })).toThrow();
    expect(() => parseAbsolute('mentor', { scores: { ...ok.scores, tone: { score: 4, justification: ' ' } } })).toThrow();
    expect(parsePairwise({ winner: 'B', justification: 'y' }).winner).toBe('B');
    expect(() => parsePairwise({ winner: 'C' })).toThrow();
  });
});
