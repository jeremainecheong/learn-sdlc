import { SpendGuard, costOf, tokensFromBytes } from '../budget';
import { newCall, unitStore, unitIsTransient, type CallRecord, type UnitContext } from '../capture';
import { evalClientConfig, evalConverseSend, harnessFault, resetAwsLoginNeeded, resetHarnessFault } from './aws';

/*
 * Billing and outcome of failed Converse calls: a call with no reported usage
 * is charged its worst case.
 */
const PRICE = { priceIn: 1, priceOut: 5 };

function harness() {
  const guard = new SpendGuard(45, 0);
  const record = newCall('grading.review', 1);
  const ctx: UnitContext = {
    unitId: 'u', modelKey: 'm', caseId: 'c', jobType: 'review-design', calls: [record], current: record,
    budget: {
      reserve: (bytes, maxTokens) => { const w = costOf(PRICE, tokensFromBytes(bytes), maxTokens); guard.reserve(w); return w; },
      settle: (reserved, tin, tout) => { const a = tin === null || tout === null ? reserved : costOf(PRICE, tin, tout); guard.settle(reserved, a); return a; },
    },
  };
  return { guard, record, ctx };
}

const input = { modelId: 'amazon.nova-micro-v1:0', messages: [{ role: 'user', content: [{ text: 'hi' }] }], inferenceConfig: { maxTokens: 1000 } } as never;
const awsError = (name: string, status?: number) => Object.assign(new Error(name), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

describe('evalConverseSend: what a failed call costs', () => {
  beforeEach(() => resetAwsLoginNeeded());

  it('charges our own deadline abort its worst case, in the guard and on the record', async () => {
    const { guard, record, ctx } = harness();
    const ac = new AbortController();
    ac.abort();
    const send = evalConverseSend({ maxOutputTokens: 4096, inner: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
    await expect(unitStore.run(ctx, () => send(input, ac.signal))).rejects.toThrow();
    expect(record.reservedUsd).toBeGreaterThan(0);
    expect(guard.spent).toBeCloseTo(record.reservedUsd, 12);
    expect(record.costUsd).toBeCloseTo(record.reservedUsd, 12);
    expect(guard.committed).toBeCloseTo(record.reservedUsd, 12);
  });

  it('charges nothing for a ValidationException (refused before inference)', async () => {
    const { guard, record, ctx } = harness();
    const send = evalConverseSend({ maxOutputTokens: 4096, inner: async () => { throw awsError('ValidationException', 400); } });
    await expect(unitStore.run(ctx, () => send(input, new AbortController().signal))).rejects.toThrow();
    expect(guard.spent).toBe(0);
    expect(guard.committed).toBe(0);
    expect(record.costUsd).toBe(0);
  });

  it('charges a socket reset (no status) its worst case and calls it a transport failure', async () => {
    const { guard, record, ctx } = harness();
    const send = evalConverseSend({ maxOutputTokens: 4096, inner: async () => { throw Object.assign(new Error('socket hang up'), { name: 'Error', code: 'ECONNRESET' }); } });
    await expect(unitStore.run(ctx, () => send(input, new AbortController().signal))).rejects.toThrow();
    expect(record.costUsd).toBeCloseTo(record.reservedUsd, 12);
    expect(guard.spent).toBeCloseTo(record.reservedUsd, 12);
    expect(record.outcome).toBe('transport');
  });

  it('charges a 5xx its worst case and calls it a server error; a ModelErrorException is the model', async () => {
    const a = harness();
    const s5 = evalConverseSend({ maxOutputTokens: 4096, inner: async () => { throw awsError('InternalServerException', 500); } });
    await expect(unitStore.run(a.ctx, () => s5(input, new AbortController().signal))).rejects.toThrow();
    expect(a.record.outcome).toBe('server_error');
    expect(a.record.costUsd).toBeCloseTo(a.record.reservedUsd, 12);
    const b = harness();
    const me = evalConverseSend({ maxOutputTokens: 4096, inner: async () => { throw awsError('ModelErrorException', 424); } });
    await expect(unitStore.run(b.ctx, () => me(input, new AbortController().signal))).rejects.toThrow();
    expect(b.record.outcome).not.toBe('server_error');
    expect(b.record.outcome).not.toBe('transport');
  });

  it('counts reasoning blocks in the answer', async () => {
    const { record, ctx } = harness();
    const send = evalConverseSend({
      maxOutputTokens: 4096,
      reasoning: { policy: 'minimum', fields: null },
      inner: async () => ({ output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'hmm' } } }, { text: 'OK' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }) as never,
    });
    await unitStore.run(ctx, () => send(input, new AbortController().signal));
    expect(record.reasoningBlocks).toBe(1);
    expect(record.responseText).toBe('OK');
  });
});

/*
 * Thinking is off for every Bedrock model.
 * Every response is checked; reasoning from a model whose switch is "off" (or
 * that has no thinking mode) is a harness fault that stops the run, never a
 * model result. gpt-oss runs at its minimum and is allowed to reason. The
 * request must carry exactly the model's documented switch.
 */
describe('evalConverseSend: the reasoning-off assertion', () => {
  beforeEach(() => { resetAwsLoginNeeded(); resetHarnessFault(); });
  const reasoningAnswer = async () => ({ output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: '[REDACTED]' } } }, { text: 'OK' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 40, totalTokens: 43 } }) as never;
  const plain = async () => ({ output: { message: { role: 'assistant', content: [{ text: 'OK' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }) as never;
  const offInput = { ...(input as object), additionalModelRequestFields: { enable_thinking: false } } as never;

  it('stops on a reasoningContent block from a model whose switch is off, and bills the call', async () => {
    const { record, ctx, guard } = harness();
    const send = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'off', fields: { enable_thinking: false } }, inner: reasoningAnswer });
    await expect(unitStore.run(ctx, () => send(offInput, new AbortController().signal))).rejects.toThrow(/harness fault/);
    expect(record.outcome).toBe('harness_fault');
    expect(harnessFault()).toMatch(/reasoning/);
    expect(guard.spent).toBeGreaterThan(0);
  });

  it('stops on a reasoning-token count or a non-empty <think> block from a model with no thinking mode', async () => {
    const a = harness();
    const tokens = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'none', fields: null }, inner: async () => ({ output: { message: { content: [{ text: 'OK' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, reasoningTokens: 12 } }) as never });
    await expect(unitStore.run(a.ctx, () => tokens(input, new AbortController().signal))).rejects.toThrow(/harness fault/);
    resetHarnessFault();
    const b = harness();
    const think = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'none', fields: null }, inner: async () => ({ output: { message: { content: [{ text: '<think>let me see</think>OK' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }) as never });
    await expect(unitStore.run(b.ctx, () => think(input, new AbortController().signal))).rejects.toThrow(/harness fault/);
  });

  it('refuses every later call once a fault is set, before anything is sent or billed', async () => {
    const a = harness();
    const bad = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'none', fields: null }, inner: reasoningAnswer });
    await expect(unitStore.run(a.ctx, () => bad(input, new AbortController().signal))).rejects.toThrow(/harness fault/);
    const b = harness();
    let sent = 0;
    const next = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'none', fields: null }, inner: async () => { sent += 1; return plain(); } });
    await expect(unitStore.run(b.ctx, () => next(input, new AbortController().signal))).rejects.toThrow(/harness fault/);
    expect(sent).toBe(0);
    expect(b.guard.spent).toBe(0);
  });

  it('lets gpt-oss reason at its minimum and records it', async () => {
    const { record, ctx } = harness();
    const send = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'minimum', fields: { reasoning_effort: 'low' } }, inner: reasoningAnswer });
    await unitStore.run(ctx, () => send({ ...(input as object), additionalModelRequestFields: { reasoning_effort: 'low' } } as never, new AbortController().signal));
    expect(record.reasoningBlocks).toBe(1);
    expect(record.outcome).not.toBe('harness_fault');
    expect(harnessFault()).toBeNull();
  });

  it('refuses a request that does not carry exactly the model\'s documented switch (nothing sent)', async () => {
    const { ctx, guard } = harness();
    let sent = 0;
    const send = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'off', fields: { reasoningConfig: { type: 'disabled' } } }, inner: async () => { sent += 1; return plain(); } });
    await expect(unitStore.run(ctx, () => send(input, new AbortController().signal))).rejects.toThrow(/harness fault/);
    expect(sent).toBe(0);
    expect(guard.spent).toBe(0);
    resetHarnessFault();
    const ok = harness();
    const good = evalConverseSend({ maxOutputTokens: 4096, reasoning: { policy: 'off', fields: { reasoningConfig: { type: 'disabled' } } }, inner: plain });
    await unitStore.run(ok.ctx, () => good({ ...(input as object), additionalModelRequestFields: { reasoningConfig: { type: 'disabled' } } } as never, new AbortController().signal));
    expect(ok.record.reasoningFieldsSent).toBe('{"reasoningConfig":{"type":"disabled"}}');
    expect(ok.record.neutralSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('unitIsTransient', () => {
  const call = (label: string, outcome: CallRecord['outcome'], attempt = 1): CallRecord => ({ ...newCall(label, attempt), outcome });
  it('is transient when an infrastructure failure was not recovered by a later attempt of the same call', () => {
    expect(unitIsTransient([call('grading.review', 'transport')])).toBe(true);
    expect(unitIsTransient([call('agentic.classify', 'ok'), call('agentic.generate', 'server_error')])).toBe(true);
    expect(unitIsTransient([call('grading.review', 'rate_limited'), call('grading.review', 'rate_limited', 2)])).toBe(true);
  });
  it('is not transient when the product retry recovered, or when the model itself failed', () => {
    expect(unitIsTransient([call('grading.review', 'rate_limited'), call('grading.review', 'ok', 2)])).toBe(false);
    expect(unitIsTransient([call('grading.review', 'invalid')])).toBe(false);
    expect(unitIsTransient([call('grading.review', 'timeout')])).toBe(false);
    expect(unitIsTransient([])).toBe(false);
  });
});

describe('installOpenAiFetch: a thrown fetch is charged on the record too', () => {
  it('records the worst case as the unit cost when the fetch throws', async () => {
    const { config } = require('../../src/config');
    const before = globalThis.fetch;
    globalThis.fetch = (async () => { throw Object.assign(new Error('ECONNRESET'), { name: 'TypeError' }); }) as never;
    try {
      const { installOpenAiFetch } = require('./openai-fetch');
      installOpenAiFetch();
      config.openaiBaseUrl = 'http://127.0.0.1:9/v1';
      const { guard, record, ctx } = harness();
      await expect(unitStore.run(ctx, () => fetch('http://127.0.0.1:9/v1/chat/completions', { method: 'POST', body: JSON.stringify({ max_completion_tokens: 500 }) }))).rejects.toThrow();
      expect(record.reservedUsd).toBeGreaterThan(0);
      expect(record.costUsd).toBeCloseTo(record.reservedUsd, 12);
      expect(guard.spent).toBeCloseTo(record.reservedUsd, 12);
      expect(record.outcome).toBe('transport');
    } finally {
      globalThis.fetch = before;
    }
  });
});

/* The eval's own SDK client: endpoint pinned, SDK retries off, one HTTP/2 session reused. */
describe('evalClientConfig', () => {
  it('ignores configured endpoint URLs, keeps SDK retries off and reuses one HTTP/2 session', () => {
    const cfg = evalClientConfig('us-east-1', (async () => ({})) as never);
    expect(cfg).toMatchObject({ region: 'us-east-1', maxAttempts: 1, ignoreConfiguredEndpointUrls: true, requestHandler: { disableConcurrentStreams: false } });
    expect('endpoint' in cfg).toBe(false);
  });
});
