import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type { InterviewBrief, PhaseContent } from '../../src/content/content.types';
import {
  OpenAiProvider,
  ProviderUsageError,
  composeChatMessages,
  composeInterviewMessages,
  composeReviewMessages,
  reviewResponseSchema,
  type ChatMessage,
} from '../../src/assistant/openai.provider';
import { composeInterviewReviewMessages, interviewReviewSchema } from '../../src/assistant/interview-review';
import { GUIDED_REVIEW_KEYS } from '../../src/assistant/guided-review';
import { assessmentFailure } from '../../src/assistant/assessment-failure';
import { stakeholderFailureCode } from '../../src/assistant/interview.service';
import type { MentorContext, ReviewInput } from '../../src/assistant/provider.types';
import { BedrockProvider, converseRouteActive } from './bedrock.provider';
import type { BedrockSettings } from './bedrock-settings';
import {
  EMPTY_TURN,
  EVAL_TEMPERATURE,
  HISTORY_OPENER,
  JSON_ONLY_LINE,
  chatResponseOfConverse,
  converseOfChatBody,
  fromConverseOutput,
  toConverseInput,
  type ConverseSend,
} from './converse';

/*
 * The harness's Bedrock provider: the product's OpenAiProvider with its
 * transport answered by Converse. No test here reaches the network: the send
 * is a fake, and the fetch below the Converse route refuses every request, so
 * a model call that escaped the route would fail the test that made it.
 */

// The gate is sized when a provider is constructed: one completion at a time, as the evaluation runs.
process.env.AI_MAX_CONCURRENCY = '1';

const below: string[] = [];
globalThis.fetch = (async (url: string | URL | Request) => {
  below.push(String(url));
  throw new Error('the fetch below the Converse route was reached');
}) as typeof fetch;

const MODEL = 'us.amazon.nova-micro-v1:0';
const settings = (over: Partial<BedrockSettings> = {}): BedrockSettings => ({ modelId: MODEL, ...over });

/** A Converse answer in the shape the SDK hands back. */
const answer = (text: string | null, over: Partial<ConverseCommandOutput> & { stop?: string } = {}): ConverseCommandOutput => ({
  $metadata: { httpStatusCode: 200 },
  output: { message: { role: 'assistant', content: text === null ? [] : [{ text }] } },
  stopReason: (over.stop ?? 'end_turn') as ConverseCommandOutput['stopReason'],
  usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
  metrics: { latencyMs: 5 },
  ...over,
} as ConverseCommandOutput);

/** An SDK service error the way the SDK throws it. */
const awsError = (name: string, status?: number, message = `${name} from upstream`) =>
  Object.assign(new Error(message), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}), $fault: 'client' });

type Sent = { input: ConverseCommandInput; signal: AbortSignal };
const fakeSend = (reply: (input: ConverseCommandInput, at: number, signal: AbortSignal) => Promise<ConverseCommandOutput> | ConverseCommandOutput) => {
  const sent: Sent[] = [];
  const send: ConverseSend = async (input, signal) => {
    sent.push({ input, signal });
    return reply(input, sent.length, signal);
  };
  return { send, sent };
};

const systemText = (input: ConverseCommandInput) => (input.system ?? []).map((block) => (block as { text: string }).text).join('\n');
const isGuidanceReview = (input: ConverseCommandInput) => JSON.stringify(input).includes('candidateEvidence');
const approvedGuidance = JSON.stringify({ revealedDecisions: [], remainingReasoning: { description: 'One concrete boundary remains for the learner to reason about.', substantive: true, candidateEvidenceIds: ['G1'] }, checks: GUIDED_REVIEW_KEYS.map((key) => ({ key, met: true, candidateEvidenceIds: ['G1'], reason: 'A limited observation and relevant learner question.' })) });
const withheldGuidance = JSON.stringify({ revealedDecisions: [{ decision: 'The draft supplied every required condition.', resolvesAssignedWork: true, candidateEvidenceIds: ['G1'] }], remainingReasoning: { description: 'Only syntax assembly remains.', substantive: true, candidateEvidenceIds: ['G1'] }, checks: GUIDED_REVIEW_KEYS.map((key) => ({ key, met: key !== 'limited_step', candidateEvidenceIds: ['G1'], reason: 'The draft resolved the assigned work.' })) });

const context = (over: Partial<MentorContext> = {}): MentorContext =>
  ({
    phase: { assistant: { systemPrompt: 'You are the mentor for Requirements.' } },
    message: 'How do I start?',
    interactionCount: 0,
    topicUseCounts: {},
    signals: { todosRemaining: [], lastFailedChecks: [] },
    ...over,
  }) as MentorContext;

const reviewPhase = {
  title: 'Requirements',
  rubric: { passThreshold: 70, criteria: [{ key: 'clarity', title: 'Clarity', weight: 50, description: 'Is every criterion testable?' }] },
} as unknown as PhaseContent;
const reviewInput = (over: Partial<ReviewInput> = {}): ReviewInput =>
  ({
    criteria: [{ title: 'Clarity', score: 80 }],
    checks: [{ status: 'failed', label: 'Story format', detail: 'no persona named' }],
    workspace: { 'requirements.md': 'Given an overdue task, when the report opens, then it appears.' },
    overall: 74, hints: 2, ranBeforeSubmit: true,
    ...over,
  }) as ReviewInput;
const review = (evidence: string) => JSON.stringify({ summary: 'All requirements evidenced.', strengths: ['Specific boundary'], improvements: [], processNote: 'Source was reviewed.', verdict: 'pass', criteriaEvidence: [{ key: 'clarity', met: true, evidence, issue: '', nextStep: '' }] });

const brief = {
  stakeholder: { name: 'Priya', role: 'Operations lead' },
  persona: 'A busy operations lead.',
  facts: [{ id: 'overdue', topic: 'Overdue tasks', answer: 'Overdue tasks are those past their due date.' }],
  unknownAnswer: 'I have not decided that yet.',
} as unknown as InterviewBrief;

const captureLogs = () => {
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return {
    all: () => [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((call) => call.map(String).join(' ')),
    calls: () => log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('ai_call ')),
    warnings: () => warn.mock.calls.map((call) => String(call[0])),
  };
};
const field = (line: string, key: string): string => line.match(new RegExp(`(?:^| )${key}=(\\S+)`))![1];

const messages = (...rows: Array<[ChatMessage['role'], string]>): ChatMessage[] => rows.map(([role, content]) => ({ role, content }));

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.OPENAI_TIMEOUT_MS;
  expect(below).toEqual([]);
});

/* ------------------------------ request shaping ----------------------------- */

describe('toConverseInput: the request a Converse call sends', () => {
  it('lifts every leading system message into system blocks, in order, and maps the turns one to one', () => {
    const input = toConverseInput(messages(['system', 'Rule one.'], ['system', 'Rule two.'], ['user', 'Hello.'], ['assistant', 'Hi.'], ['user', 'Question?']), 400, false, settings());
    expect(input.system).toEqual([{ text: 'Rule one.' }, { text: 'Rule two.' }]);
    expect(input.messages).toEqual([
      { role: 'user', content: [{ text: 'Hello.' }] },
      { role: 'assistant', content: [{ text: 'Hi.' }] },
      { role: 'user', content: [{ text: 'Question?' }] },
    ]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 400, temperature: EVAL_TEMPERATURE });
  });

  it('refuses a system message after a turn rather than reorder it', () => {
    expect(() => toConverseInput(messages(['system', 'Rule.'], ['user', 'Hi.'], ['system', 'Late rule.'], ['user', 'Again.']), 400, false, settings())).toThrow('system message after a turn');
  });

  it('merges consecutive same-role turns into one message with several blocks', () => {
    const input = toConverseInput(messages(['system', 'Rule.'], ['user', 'One.'], ['user', 'Two.']), 400, false, settings());
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'One.' }, { text: 'Two.' }] }]);
  });

  it('opens with a fixed user line when the history window starts on an assistant turn', () => {
    const input = toConverseInput(messages(['system', 'Rule.'], ['assistant', 'Earlier reply.'], ['user', 'Now?']), 400, false, settings());
    expect(input.messages![0]).toEqual({ role: 'user', content: [{ text: HISTORY_OPENER }] });
    expect(input.messages![1].role).toBe('assistant');
  });

  it('refuses a conversation that does not end on the learner, an empty block and an unknown role', () => {
    expect(() => toConverseInput(messages(['user', 'Hi.'], ['assistant', 'Yes.']), 400, false, settings())).toThrow('must end on a user turn');
    expect(() => toConverseInput(messages(['user', '   ']), 400, false, settings())).toThrow('empty text block');
    expect(() => toConverseInput(messages(['system', ''], ['user', 'Hi.']), 400, false, settings())).toThrow('empty text block');
    expect(() => toConverseInput([{ role: 'tool', content: 'x' } as never], 400, false, settings())).toThrow('unknown role');
  });

  it('stands a fixed line in for a blank earlier turn, and never sends the learner\'s own last turn blank', () => {
    const input = toConverseInput(messages(['system', 'Rule.'], ['user', '   '], ['assistant', ''], ['user', 'And now?']), 400, false, settings());
    expect(input.messages).toEqual([
      { role: 'user', content: [{ text: EMPTY_TURN }] },
      { role: 'assistant', content: [{ text: EMPTY_TURN }] },
      { role: 'user', content: [{ text: 'And now?' }] },
    ]);
    expect(() => toConverseInput(messages(['user', 'Hi.'], ['assistant', 'Yes.'], ['user', ' ']), 400, false, settings())).toThrow('empty text block');
  });

  it('asks for a schema-bound answer in one trusted system block, last', () => {
    const schema = { name: 'learning_rubric_review', schema: { type: 'object', properties: { verdict: { type: 'string' } } } };
    const input = toConverseInput(messages(['system', 'Rule.'], ['user', 'Evidence.']), 4000, schema, settings());
    expect(input.system).toHaveLength(2);
    expect((input.system![1] as { text: string }).text).toBe(
      `${JSON_ONLY_LINE} It must validate against this JSON Schema.\n<<<RESPONSE_SCHEMA name=learning_rubric_review\n${JSON.stringify(schema.schema)}\nRESPONSE_SCHEMA>>>`,
    );
    expect(input.toolConfig).toBeUndefined();
  });

  it('asks for plain JSON with one line when no schema is named, and adds nothing for text', () => {
    expect(toConverseInput(messages(['system', 'Rule.'], ['user', 'Data.']), 3000, true, settings()).system).toEqual([{ text: 'Rule.' }, { text: JSON_ONLY_LINE }]);
    expect(toConverseInput(messages(['system', 'Rule.'], ['user', 'Data.']), 220, false, settings()).system).toEqual([{ text: 'Rule.' }]);
  });

  it('keeps a fixed key order and sends the reasoning switch only when the model has one', () => {
    const plain = toConverseInput(messages(['system', 'Rule.'], ['user', 'Data.']), 100, true, settings());
    expect(Object.keys(plain)).toEqual(['modelId', 'system', 'messages', 'inferenceConfig']);
    const off = toConverseInput(messages(['system', 'Rule.'], ['user', 'Data.']), 100, true, settings({ additionalModelRequestFields: { reasoning_effort: 'low' } }));
    expect(Object.keys(off)).toEqual(['modelId', 'system', 'messages', 'inferenceConfig', 'additionalModelRequestFields']);
    expect(JSON.stringify(plain)).toBe(JSON.stringify(toConverseInput(messages(['system', 'Rule.'], ['user', 'Data.']), 100, true, settings())));
  });

  it('maps every real composer, and the learner\'s material never reaches a system block', () => {
    const interviewInput = { answer: 'Overdue tasks are past their due date.', question: 'Which tasks count as overdue?', claimedFactIds: [], brief };
    for (const [composed, json] of [
      [composeChatMessages(context()), false],
      [composeInterviewMessages(brief, 'TaskTrackr', 'Which tasks count as overdue?', []), false],
      [composeInterviewReviewMessages(interviewInput), interviewReviewSchema(interviewInput)],
      [composeReviewMessages(reviewPhase, reviewInput()), reviewResponseSchema(reviewPhase, reviewInput())],
    ] as const) {
      const input = toConverseInput(composed as ChatMessage[], 100, json as never, settings());
      expect(input.system!.length).toBeGreaterThanOrEqual(1);
      expect(input.messages![input.messages!.length - 1].role).toBe('user');
      expect(systemText(input)).not.toContain('Given an overdue task');
    }
  });
});

describe('converseOfChatBody: the product\'s request body read back', () => {
  const body = (over: Record<string, unknown>) => JSON.stringify({ model: 'any', messages: messages(['system', 'Rule.'], ['user', 'Data.']), ...over });

  it('takes the output allowance under either name the product uses', () => {
    expect(converseOfChatBody(body({ max_completion_tokens: 900, reasoning_effort: 'none' }), settings()).input.inferenceConfig).toEqual({ maxTokens: 900, temperature: EVAL_TEMPERATURE });
    expect(converseOfChatBody(body({ max_tokens: 700, temperature: 0 }), settings()).input.inferenceConfig).toEqual({ maxTokens: 700, temperature: EVAL_TEMPERATURE });
    expect(() => converseOfChatBody(body({}), settings())).toThrow('names no output allowance');
  });

  it('reads the response format: a named schema, any JSON object, or text', () => {
    const schema = { type: 'object', properties: {} };
    expect(converseOfChatBody(body({ max_tokens: 1, response_format: { type: 'json_schema', json_schema: { name: 'x', schema, strict: true } } }), settings()).json).toEqual({ name: 'x', schema });
    expect(converseOfChatBody(body({ max_tokens: 1, response_format: { type: 'json_object' } }), settings()).json).toBe(true);
    expect(converseOfChatBody(body({ max_tokens: 1 }), settings()).json).toBe(false);
    expect(() => converseOfChatBody(body({ max_tokens: 1, response_format: { type: 'grammar' } }), settings())).toThrow('unknown response format');
  });
});

/* ------------------------------- the response ------------------------------- */

describe('fromConverseOutput and chatResponseOfConverse: what a Converse answer becomes', () => {
  it('joins the text blocks and drops reasoning blocks, keeping their tokens in the usage', () => {
    const parsed = fromConverseOutput(answer(null, {
      output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'thinking' } } } as never, { text: 'One ' }, { text: 'answer.' }] } },
      usage: { inputTokens: 10, outputTokens: 99, totalTokens: 109 },
    }), false);
    expect(parsed).toEqual({ content: 'One answer.', stopReason: 'end_turn', usage: { tokensIn: 10, tokensOut: 99 }, cachedTokens: null });
  });

  it('reports usage only when both counts are safe non-negative integers, and the cached count beside it', () => {
    expect(fromConverseOutput(answer('x', { usage: { inputTokens: -1, outputTokens: 3, totalTokens: 2 } }), false).usage).toBeNull();
    expect(fromConverseOutput(answer('x', { usage: undefined }), false).usage).toBeNull();
    expect(fromConverseOutput(answer('x', { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadInputTokens: 4 } }), false)).toMatchObject({ usage: { tokensIn: 5, tokensOut: 3 }, cachedTokens: 4 });
  });

  it('unwraps exactly one whole-answer Markdown fence on a JSON call and repairs nothing else', () => {
    expect(fromConverseOutput(answer('```json\n{"a":1}\n```'), true).content).toBe('{"a":1}');
    expect(fromConverseOutput(answer('```\n{"a":1}\n```'), true).content).toBe('{"a":1}');
    expect(fromConverseOutput(answer('Here it is:\n```json\n{"a":1}\n```'), true).content).toBe('Here it is:\n```json\n{"a":1}\n```');
    expect(fromConverseOutput(answer('```json\n{"a":1}\n```\n```json\n{"b":2}\n```'), true).content).toContain('{"b":2}');
    // A text call keeps its fences: a mentor reply may quote code.
    expect(fromConverseOutput(answer('```json\n{"a":1}\n```'), false).content).toBe('```json\n{"a":1}\n```');
  });

  it('finishes a whole answer with stop and passes any other stop reason on', () => {
    const whole = JSON.parse(chatResponseOfConverse({ content: 'x', stopReason: 'end_turn', usage: { tokensIn: 1, tokensOut: 2 }, cachedTokens: 3 }));
    expect(whole).toEqual({ choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } });
    expect(JSON.parse(chatResponseOfConverse({ content: 'x', stopReason: 'max_tokens', usage: null, cachedTokens: null }))).toEqual({ choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'max_tokens' }] });
  });
});

/* ------------------------------ the provider ------------------------------- */

describe('BedrockProvider: the product\'s provider with the transport swapped', () => {
  it('is an OpenAiProvider by class and named for its model', () => {
    const provider = new BedrockProvider(settings(), fakeSend(() => answer('x')).send);
    expect(provider).toBeInstanceOf(OpenAiProvider);
    expect(provider.name).toBe(`bedrock:${MODEL}`);
    expect(provider.available).toBe(true);
  });

  it('refuses an ARN or an empty model id, and any extra request field that is not a reasoning-off switch', () => {
    const send = fakeSend(() => answer('x')).send;
    expect(() => new BedrockProvider(settings({ modelId: 'arn:aws:bedrock:us-east-1:000000000000:inference-profile/us.amazon.nova-micro-v1:0' }), send)).toThrow('not an ARN');
    expect(() => new BedrockProvider(settings({ modelId: '' }), send)).toThrow('not an ARN');
    expect(() => new BedrockProvider(settings({ additionalModelRequestFields: { reasoning_effort: 'high' } }), send)).toThrow('reasoning off');
    expect(() => new BedrockProvider(settings({ additionalModelRequestFields: { top_k: 5 } }), send)).toThrow('reasoning off');
    expect(() => new BedrockProvider(settings({ additionalModelRequestFields: { reasoningConfig: { type: 'disabled' } } }), send)).not.toThrow();
    expect(() => new BedrockProvider(settings({ additionalModelRequestFields: { thinking: { type: 'disabled' } } }), send)).not.toThrow();
  });

  it('routes every public method of OpenAiProvider that can make a model call', () => {
    // The members of OpenAiProvider that never call a model. A method added to
    // the product's provider fails this test until it is routed (or listed here).
    const noModelCall = new Set(['constructor', 'waitingAtGate', 'leaveLine', 'record', 'logRateLimits', 'attempt', 'complete']);
    const methods = Object.getOwnPropertyNames(OpenAiProvider.prototype)
      .filter((key) => typeof Object.getOwnPropertyDescriptor(OpenAiProvider.prototype, key)?.value === 'function' && !noModelCall.has(key));
    expect(methods.length).toBeGreaterThan(0);
    for (const key of methods) expect(Object.prototype.hasOwnProperty.call(BedrockProvider.prototype, key)).toBe(true);
  });

  it('leaves a plain OpenAiProvider on the fetch below the route', async () => {
    new BedrockProvider(settings(), fakeSend(() => answer('{}')).send);
    captureLogs();
    expect(converseRouteActive()).toBe(false);
    const held = process.env.OPENAI_API_KEY;
    const plain = new OpenAiProvider();
    const { config } = require('../../src/config') as typeof import('../../src/config');
    const key = config.openaiApiKey;
    config.openaiApiKey = 'placeholder-not-a-key';
    try {
      await expect(plain.structured('Classify.', {})).rejects.toThrow('the fetch below the Converse route was reached');
      expect(below).toEqual([`${config.openaiBaseUrl}/chat/completions`]);
    } finally {
      below.length = 0;
      config.openaiApiKey = key;
      if (held === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = held;
    }
  });

  it('chat: drafts, self-reviews, and returns the reviewed draft with both calls billed', async () => {
    captureLogs();
    const { send, sent } = fakeSend((input) => answer(isGuidanceReview(input) ? approvedGuidance : 'Which boundary applies here?'));
    const reply = await new BedrockProvider(settings(), send).chat(context());
    expect(reply).toMatchObject({ content: 'Which boundary applies here?', tokensIn: 24, tokensOut: 68, provider: `bedrock:${MODEL}` });
    expect(sent).toHaveLength(2);
    expect(systemText(sent[0].input)).not.toContain(JSON_ONLY_LINE);
    expect(systemText(sent[1].input)).toContain(JSON_ONLY_LINE);
  });

  it('chat: a blank row in the stored history still lets the learner talk to the mentor', async () => {
    captureLogs();
    const { send, sent } = fakeSend((input) => answer(isGuidanceReview(input) ? approvedGuidance : 'Which boundary applies here?'));
    const reply = await new BedrockProvider(settings(), send).chat(context({ history: [{ role: 'user', content: '' }, { role: 'assistant', content: 'Tell me more.' }] }));
    expect(reply.content).toBe('Which boundary applies here?');
    expect(JSON.stringify(sent[0].input.messages)).toContain(EMPTY_TURN);
  });

  it('chat: withholds an unsafe draft exactly as the product does', async () => {
    captureLogs();
    let drafts = 0;
    const { send, sent } = fakeSend((input) => answer(isGuidanceReview(input) ? withheldGuidance : `Draft ${++drafts}: which boundary applies here?`));
    await expect(new BedrockProvider(settings(), send).chat(context())).rejects.toThrow('Guided reply review unavailable; draft withheld');
    expect(sent).toHaveLength(4);
  });

  it('interview and reviewInterview: the stakeholder reply and the review schema', async () => {
    captureLogs();
    const { send, sent } = fakeSend(() => answer('Overdue tasks are past their due date.'));
    const provider = new BedrockProvider(settings(), send);
    const reply = await provider.interview(brief, 'TaskTrackr', 'Which tasks count as overdue?', []);
    expect(reply.provider).toBe(`bedrock:${MODEL}`);
    expect(systemText(sent[0].input)).not.toContain(JSON_ONLY_LINE);
    const input = { answer: 'Overdue tasks are past their due date.', question: 'Which tasks count as overdue?', claimedFactIds: [], brief };
    await expect(provider.reviewInterview(input)).rejects.toThrow('Stakeholder review was incomplete or malformed');
    expect(systemText(sent[1].input)).toContain(`<<<RESPONSE_SCHEMA name=${interviewReviewSchema(input).name}\n`);
  });

  it('structured: the product\'s envelope, plain JSON asked for, the learner data in the user turn', async () => {
    captureLogs();
    const { send, sent } = fakeSend(() => answer('{"intent":"proposal"}'));
    const result = await new BedrockProvider(settings(), send).structured('Classify the request.', { request: 'LEARNER-SENTINEL' }, 3000, undefined, undefined, 'agentic.classify');
    expect(result).toEqual({ value: { intent: 'proposal' }, tokensIn: 12, tokensOut: 34 });
    const input = sent[0].input;
    expect(input.inferenceConfig).toEqual({ maxTokens: 3000, temperature: EVAL_TEMPERATURE });
    expect(systemText(input)).toContain('Classify the request.');
    expect(systemText(input)).toContain(JSON_ONLY_LINE);
    expect(systemText(input)).not.toContain('LEARNER-SENTINEL');
    expect(JSON.stringify(input.messages)).toContain('LEARNER-SENTINEL');
  });

  it('structured: the product refuses oversized evidence before anything is sent', async () => {
    const { send, sent } = fakeSend(() => answer('{}'));
    await expect(new BedrockProvider(settings(), send).structured('Classify.', { blob: 'x'.repeat(170_000) })).rejects.toThrow('Assessment context is too large');
    expect(sent).toHaveLength(0);
  });

  it('review: the rubric schema, a grounded pass accepted, an ungrounded pass refused', async () => {
    captureLogs();
    let reply = review('requirements.md describes the boundary.');
    const { send, sent } = fakeSend(() => answer(reply));
    const provider = new BedrockProvider(settings(), send);
    await expect(provider.review(reviewPhase, reviewInput())).resolves.toMatchObject({ verdict: 'pass', provider: `bedrock:${MODEL}`, tokensIn: 12, tokensOut: 34 });
    expect(systemText(sent[0].input)).toContain('<<<RESPONSE_SCHEMA name=learning_rubric_review\n');
    reply = review('The story is clear.');
    await expect(provider.review(reviewPhase, reviewInput())).rejects.toThrow('Passing assessment did not ground every criterion in submitted evidence');
  });

  it.each(['max_tokens', 'model_context_window_exceeded', 'guardrail_intervened', 'content_filtered'])(
    'stop reason %s is refused as incomplete, with its usage kept and the outcome invalid',
    async (stop) => {
      const logs = captureLogs();
      const { send } = fakeSend(() => answer('{"partial":', { stop }));
      const failure = new BedrockProvider(settings(), send).structured('Classify.', {});
      await expect(failure).rejects.toThrow('AI provider stopped before completing its response');
      await expect(failure).rejects.toBeInstanceOf(ProviderUsageError);
      expect(field(logs.calls()[0], 'outcome')).toBe('invalid');
    },
  );

  it('an empty answer is refused as empty', async () => {
    captureLogs();
    const { send } = fakeSend(() => answer('   '));
    await expect(new BedrockProvider(settings(), send).structured('Classify.', {})).rejects.toThrow('AI provider returned an empty response');
  });

  it('throttling buys the product\'s one retry after its blind wait; a second throttle surfaces as HTTP 429', async () => {
    const logs = captureLogs();
    let { send, sent } = fakeSend((_input, at) => { if (at === 1) throw awsError('ThrottlingException', 429); return answer('{"ok":true}'); });
    const started = Date.now();
    await expect(new BedrockProvider(settings(), send).structured('Classify.', {})).resolves.toMatchObject({ value: { ok: true } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(sent).toHaveLength(2);
    expect(logs.calls().map((line) => field(line, 'outcome'))).toEqual(['rate_limited', 'ok']);

    ({ send, sent } = fakeSend(() => { throw awsError('ThrottlingException', 429); }));
    await expect(new BedrockProvider(settings(), send).structured('Classify.', {})).rejects.toThrow(/^openai api returned HTTP 429$/);
    expect(sent).toHaveLength(2);
  });

  it('maps the throttle family by name even without a status, and other names to their status, with no retry', async () => {
    captureLogs();
    for (const [name, status, calls] of [['ServiceQuotaExceededException', 429, 2], ['ModelNotReadyException', 429, 2], ['ServiceUnavailableException', 503, 1], ['ValidationException', 400, 1], ['AccessDeniedException', 403, 1], ['ModelTimeoutException', 408, 1]] as const) {
      const { send, sent } = fakeSend(() => { throw awsError(name); });
      await expect(new BedrockProvider(settings(), send).structured('Classify.', {})).rejects.toThrow(`openai api returned HTTP ${status}`);
      expect(sent).toHaveLength(calls);
    }
  });

  it('times out with the product\'s timeout and message, and records a timeout', async () => {
    process.env.OPENAI_TIMEOUT_MS = '20';
    const logs = captureLogs();
    const { send, sent } = fakeSend((_input, _at, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })), { once: true });
    }));
    const provider = new BedrockProvider(settings(), send);
    await expect(provider.review(reviewPhase, reviewInput())).rejects.toThrow(/^openai api timed out after 20ms$/);
    expect(sent).toHaveLength(1);
    expect(provider.queued).toBe(0);
    expect(field(logs.calls()[0], 'outcome')).toBe('timeout');
  });

  it('rejects with the caller\'s own reason on abort and records it', async () => {
    const logs = captureLogs();
    const controller = new AbortController();
    const reason = new Error('learner left');
    const { send } = fakeSend((_input, _at, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })), { once: true });
      setTimeout(() => controller.abort(reason), 5);
    }));
    await expect(new BedrockProvider(settings(), send).structured('Classify.', {}, 3000, controller.signal)).rejects.toBe(reason);
    expect(field(logs.calls()[0], 'outcome')).toBe('aborted');
  });

  it('a failure with no status is the product\'s network failure, and no upstream message, ARN, key or prompt reaches the error or a log line', async () => {
    const logs = captureLogs();
    const secret = 'arn:aws:bedrock:us-east-1:000000000000:inference-profile/x AKIAABCDEFGHIJKLMNOP aws_secret_access_key=abc/def';
    const { send } = fakeSend(() => { throw Object.assign(new Error(secret), { name: 'NetworkingError' }); });
    const failure = new BedrockProvider(settings(), send).structured('PROMPT-SENTINEL', { request: 'LEARNER-SENTINEL' });
    const error = (await failure.catch((err: Error) => err)) as Error;
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('fetch failed');
    expect((error as { awsErrorName?: string }).awsErrorName).toBe('NetworkingError');
    expect(JSON.stringify({ message: error.message, stack: error.stack, own: { ...error } })).not.toMatch(/000000000000|AKIA|secret|arn:aws/);
    expect(logs.all().join('\n')).not.toMatch(/000000000000|AKIA|secret|arn:aws|PROMPT-SENTINEL|LEARNER-SENTINEL/);
  });

  it('passes the harness\'s own stops through unchanged', async () => {
    captureLogs();
    for (const name of ['HarnessFault', 'BudgetExceeded', 'CredentialsProviderError']) {
      const stop = Object.assign(new Error(`${name} stop`), { name });
      const { send } = fakeSend(() => { throw stop; });
      await expect(new BedrockProvider(settings(), send).structured('Classify.', {})).rejects.toBe(stop);
    }
  });

  it('holds one Converse call in flight at a gate of one: a second caller queues', async () => {
    captureLogs();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { send, sent } = fakeSend(async () => { await gate; return answer('{}'); });
    const provider = new BedrockProvider(settings(), send);
    const first = provider.structured('A.', {});
    const second = provider.structured('B.', {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
    expect(provider.queued).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(sent).toHaveLength(2);
  });

  it('keeps two providers\' calls on their own models when they run at once', async () => {
    captureLogs();
    const a = fakeSend(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return answer('{"from":"a"}'); });
    const b = fakeSend(() => answer('{"from":"b"}'));
    const other = 'qwen.qwen3-32b-v1:0';
    const [ra, rb] = await Promise.all([
      new BedrockProvider(settings(), a.send).structured('A.', {}),
      new BedrockProvider(settings({ modelId: other, additionalModelRequestFields: { enable_thinking: false } }), b.send).structured('B.', {}),
    ]);
    expect([ra.value, rb.value]).toEqual([{ from: 'a' }, { from: 'b' }]);
    expect(a.sent.map((one) => one.input.modelId)).toEqual([MODEL]);
    expect(b.sent.map((one) => [one.input.modelId, one.input.additionalModelRequestFields])).toEqual([[other, { enable_thinking: false }]]);
  });
});

/* -------------------- what reads the provider's failures -------------------- */

describe('the product\'s failure readers classify a Bedrock failure as any provider\'s', () => {
  const failureOf = async (send: ConverseSend, timeoutMs?: string) => {
    if (timeoutMs) process.env.OPENAI_TIMEOUT_MS = timeoutMs;
    return new BedrockProvider(settings(), send).structured('Classify.', {}).catch((err: unknown) => err);
  };

  it('a refusal by status, a timeout and a network failure', async () => {
    captureLogs();
    const refused = await failureOf(async () => { throw awsError('AccessDeniedException', 403); });
    expect(assessmentFailure(refused)).toMatchObject({ code: 'provider_http_error', detail: 'HTTP 403' });
    expect(stakeholderFailureCode(refused)).toBe('provider_http_403');
    const late = await failureOf((_input, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }), '15');
    expect(assessmentFailure(late).code).toBe('provider_timeout');
    expect(stakeholderFailureCode(late)).toBe('provider_timeout');
    const lost = await failureOf(async () => { throw Object.assign(new Error('socket hang up'), { name: 'Error' }); });
    expect(stakeholderFailureCode(lost)).toBe('provider_network');
  });
});
