import { config } from '../config';
import { EXPLANATION_ASSESSMENT_PROMPT, explanationAssessmentResponseSchema, explanationEvidence, parseModelExplanationAssessment, UNDERSTANDING_DIMENSIONS } from './explanation-assessment';
import { explanationReaskNote } from './explanation-reask';
import { AI_CALL_LABELS } from './model-call-timing';
import { OpenAiProvider } from './openai.provider';

// All fetches are test doubles. These cover transport/schema recovery, not real
// provider outages or semantic quality.
describe('Explanation structured-output transport and recovery', () => {
  const answer = 'Only the note changes. This preserves the fields. Compare both versions; execution remains unverified.';
  const valid = { dimensions: UNDERSTANDING_DIMENSIONS.map(key => ({ key, met: true, finding: 'supported', learnerEvidenceIds: ['E1', 'E2', 'E3'] })) };
  const schema = explanationAssessmentResponseSchema(answer);
  const completion = (content: string, finishReason = 'stop') => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 31, completion_tokens: 17 } }) }) as Response;
  const failure = (status: number) => ({ ok: false, status, headers: new Headers(), text: async () => 'Untrusted upstream body' }) as Response;
  const original = { fetch: global.fetch, model: config.openaiModel, effort: config.openaiReasoningEffort, base: config.openaiBaseUrl, key: config.openaiApiKey, concurrency: process.env.AI_MAX_CONCURRENCY };
  beforeEach(() => {
    config.openaiModel = 'gpt-5.6-luna'; config.openaiReasoningEffort = 'none'; config.openaiBaseUrl = 'https://api.openai.com/v1'; config.openaiApiKey = 'test-only';
    process.env.AI_MAX_CONCURRENCY = '1'; global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = original.fetch; config.openaiModel = original.model; config.openaiReasoningEffort = original.effort; config.openaiBaseUrl = original.base; config.openaiApiKey = original.key;
    if (original.concurrency === undefined) delete process.env.AI_MAX_CONCURRENCY; else process.env.AI_MAX_CONCURRENCY = original.concurrency;
  });
  const review = async (provider: OpenAiProvider) => {
    const result = await provider.structured(EXPLANATION_ASSESSMENT_PROMPT, { learnerAnswer: answer, answerEvidence: explanationEvidence(answer) }, 900, undefined, schema);
    return { ...result, assessment: parseModelExplanationAssessment(result.value, answer) };
  };
  it('requests a strict bounded schema using the exact configured hosted model and excerpt IDs', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(completion(JSON.stringify(valid)));
    expect((await review(new OpenAiProvider())).assessment.adequate).toBe(true);
    const [url, request] = (global.fetch as jest.Mock).mock.calls[0]; const body = JSON.parse(request.body);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body).toMatchObject({ model: 'gpt-5.6-luna', reasoning_effort: 'none', response_format: { type: 'json_schema', json_schema: { ...schema, strict: true } } });
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.response_format.json_schema.schema.properties.dimensions.items.properties.learnerEvidenceIds.items.enum).toEqual(['E1', 'E2', 'E3']);
    // The assessor asks for the model's most likely verdict, so the
    // same explanation of the same proposal gets the same verdict on a repeat.
    expect(body).toHaveProperty('temperature', 0);
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('seed');
  });
  // Temperature 0 belongs to the explanation assessor's call site
  // alone. Every other label sends no temperature to a gpt-5 model, even with
  // the assessor's own schema, so the value follows the site and not the bytes.
  it.each(AI_CALL_LABELS.filter(label => label !== 'agentic.explanation'))('sends no temperature on %s, the assessor\'s schema notwithstanding', async label => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(completion(JSON.stringify(valid)));
    await new OpenAiProvider().structured(EXPLANATION_ASSESSMENT_PROMPT, { learnerAnswer: answer }, 4500, undefined, schema, label);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'gpt-5.6-luna', reasoning_effort: 'none', max_completion_tokens: 4500 });
    expect(body).not.toHaveProperty('temperature');
  });
  it('sends temperature 0 on the assessor\'s site by its label and by its schema, and nowhere else in the same provider', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue(completion(JSON.stringify(valid)));
    const provider = new OpenAiProvider();
    const data = { learnerAnswer: answer, answerEvidence: explanationEvidence(answer) };
    await provider.structured(EXPLANATION_ASSESSMENT_PROMPT, data, 4500, undefined, schema, 'agentic.explanation');
    await provider.structured('Evaluate the intent.', { prompt: 'Help.' }, 900);
    await provider.structured(EXPLANATION_ASSESSMENT_PROMPT, data, 4500, undefined, schema);
    const bodies = fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body));
    expect(bodies.map(body => body.temperature)).toEqual([0, undefined, 0]);
    expect(bodies[0]).toEqual(bodies[2]);
    // The value sits beside the gpt-5 parameters and leaves them as they were.
    expect(Object.keys(bodies[0])).toEqual(['model', 'messages', 'reasoning_effort', 'max_completion_tokens', 'temperature', 'response_format']);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });
  it('keeps temperature 0 on the one retry after a 429, which is the same request', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), text: async () => '' } as Response)
      .mockResolvedValueOnce(completion(JSON.stringify(valid)));
    await new OpenAiProvider().structured(EXPLANATION_ASSESSMENT_PROMPT, { learnerAnswer: answer }, 4500, undefined, schema, 'agentic.explanation');
    const [first, retry] = fetchMock.mock.calls.map(([, request]) => request.body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first).temperature).toBe(0);
    expect(retry).toBe(first);
  });
  it('leaves a model outside gpt-5 on its own sampling, the assessor included', async () => {
    config.openaiModel = 'gpt-4o-mini';
    (global.fetch as jest.Mock).mockResolvedValueOnce(completion(JSON.stringify(valid)));
    await new OpenAiProvider().structured(EXPLANATION_ASSESSMENT_PROMPT, { learnerAnswer: answer }, 4500, undefined, schema, 'agentic.explanation');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'gpt-4o-mini', temperature: 0.4, max_tokens: 4500 });
    expect(body).not.toHaveProperty('reasoning_effort');
  });
  it.each(['disconnect', 'timeout', 'http-500', 'schema-unsupported', 'malformed-json', 'truncated', 'extra-prose'])('releases the provider slot after %s and accepts a separate explicit retry', async mode => {
    const fetchMock = global.fetch as jest.Mock;
    if (mode === 'disconnect') fetchMock.mockRejectedValueOnce(new Error('Disconnected'));
    if (mode === 'timeout') fetchMock.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { name: 'TimeoutError' }));
    if (mode === 'http-500') fetchMock.mockResolvedValueOnce(failure(500));
    if (mode === 'schema-unsupported') fetchMock.mockResolvedValueOnce(failure(400));
    if (mode === 'malformed-json') fetchMock.mockResolvedValueOnce(completion('{'));
    if (mode === 'truncated') fetchMock.mockResolvedValueOnce(completion(JSON.stringify(valid), 'length'));
    if (mode === 'extra-prose') fetchMock.mockResolvedValueOnce(completion(JSON.stringify({ ...valid, feedback: 'Copy this reference solution' })));
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(valid)));
    const provider = new OpenAiProvider();
    await expect(review(provider)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(provider.queued).toBe(0);
    expect((await review(provider)).assessment.adequate).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(provider.queued).toBe(0);
    for (const [, request] of fetchMock.mock.calls) expect(JSON.parse(request.body).response_format.type).toBe('json_schema');
  });
  it('sends a re-ask as the first request byte for byte plus one trailing system note, under the same schema, ceiling and model', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(valid))).mockResolvedValueOnce(completion(JSON.stringify(valid)));
    const provider = new OpenAiProvider();
    const data = { learnerAnswer: answer, answerEvidence: explanationEvidence(answer) };
    await provider.structured(EXPLANATION_ASSESSMENT_PROMPT, data, 4500, undefined, schema, 'agentic.explanation');
    const note = explanationReaskNote({ code: 'inconsistent_finding', keys: ['verification'] });
    const second = await provider.structured(EXPLANATION_ASSESSMENT_PROMPT, data, 4500, undefined, schema, 'agentic.explanation', note);
    expect(parseModelExplanationAssessment(second.value, answer).adequate).toBe(true);
    const [first, reask] = fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body));
    expect(first.temperature).toBe(0);
    expect(reask.temperature).toBe(0);
    expect(first.messages).toHaveLength(2);
    expect(first.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(reask.messages).toEqual([...first.messages, { role: 'system', content: note }]);
    const { messages: _first, ...firstRest } = first; const { messages: _reask, ...reaskRest } = reask;
    expect(reaskRest).toEqual(firstRest);
    expect(JSON.stringify(reask.messages.at(-1))).not.toContain(answer.slice(0, 20));
  });
  it('sends no note, and the same two messages whether the note is left out or undefined', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(valid))).mockResolvedValueOnce(completion(JSON.stringify(valid)));
    const provider = new OpenAiProvider();
    const data = { learnerAnswer: answer, answerEvidence: explanationEvidence(answer) };
    await provider.structured(EXPLANATION_ASSESSMENT_PROMPT, data, 4500, undefined, schema, 'agentic.explanation');
    await provider.structured(EXPLANATION_ASSESSMENT_PROMPT, data, 4500, undefined, schema, 'agentic.explanation', undefined);
    const [a, b] = fetchMock.mock.calls.map(([, request]) => request.body);
    expect(b).toBe(a);
    expect(JSON.parse(a).messages).toHaveLength(2);
  });
  it('refuses an empty evidence vocabulary before a provider request exists', () => {
    expect(() => explanationAssessmentResponseSchema(' \n')).toThrow('No learner answer evidence');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
