import {
  aiGateWait,
  aiModelCallDuration,
  aiModelCallHeaders,
  aiModelCallOutputTokens,
  aiReviewRejections,
  renderMetrics,
} from '../observability/metrics';
import { explanationAssessmentResponseSchema } from './explanation-assessment';
import {
  AI_CALL_LABELS,
  ModelCallTimer,
  aiCallLogLine,
  observeAiCall,
  observeRefusedGateWait,
  recordReviewRejection,
  REVIEW_REJECTION_CHECKS,
  startGateWait,
  structuredCallLabel,
  type ModelCallSample,
} from './model-call-timing';

const sample = (over: Partial<ModelCallSample> = {}): ModelCallSample => ({
  call: 'guided.draft', operation: 'guided', attempt: 1, gateWaitMs: 0,
  headersMs: 4012.4, totalMs: 4100.6, tokensIn: 812, tokensOut: 143, status: 200, outcome: 'ok',
  ...over,
});

/** The whole line, top to bottom: fixed tokens and integers, nothing else. */
const LINE = /^ai_call call=[a-z][a-z.]* operation=[a-z]+ attempt=[12] gateWaitMs=(?:none|\d+) headersMs=(?:none|\d+) totalMs=(?:none|\d+) tokensIn=(?:none|\d+) tokensOut=(?:none|\d+) status=(?:none|\d{3}) outcome=[a-z_]+ cachedTokens=(?:none|\d+)$/;

describe('the ai_call log line', () => {
  it('renders one stable key=value line per attempt', () => {
    expect(aiCallLogLine(sample())).toBe(
      'ai_call call=guided.draft operation=guided attempt=1 gateWaitMs=0 headersMs=4012 totalMs=4101 tokensIn=812 tokensOut=143 status=200 outcome=ok cachedTokens=none',
    );
  });

  it('says none rather than zero for a number the call never produced', () => {
    const line = aiCallLogLine(sample({
      operation: 'none', attempt: 2, headersMs: null, tokensIn: null, tokensOut: null, status: null, outcome: 'timeout',
    }));
    expect(line).toBe(
      'ai_call call=guided.draft operation=none attempt=2 gateWaitMs=0 headersMs=none totalMs=4101 tokensIn=none tokensOut=none status=none outcome=timeout cachedTokens=none',
    );
    expect(line).toMatch(LINE);
  });

  // The prompt tokens the provider says it served from
  // its prefix cache, last on the line so every field before it keeps its
  // place. A count only, and `none` when the provider did not report one.
  it('carries the cached prompt tokens the provider reported, last, and none when it reported none', () => {
    expect(aiCallLogLine(sample({ cachedTokens: 640 }))).toBe(
      'ai_call call=guided.draft operation=guided attempt=1 gateWaitMs=0 headersMs=4012 totalMs=4101 tokensIn=812 tokensOut=143 status=200 outcome=ok cachedTokens=640',
    );
    expect(aiCallLogLine(sample({ cachedTokens: 0 }))).toMatch(/ cachedTokens=0$/);
    expect(aiCallLogLine(sample({ cachedTokens: null }))).toMatch(/ cachedTokens=none$/);
    for (const bad of [-1, 2.5, Number.NaN, 'SENTINEL' as never]) {
      const line = aiCallLogLine(sample({ cachedTokens: bad }));
      expect(line).toMatch(LINE);
      expect(line).toMatch(/ cachedTokens=none$/);
    }
    expect(new ModelCallTimer('guided.draft', 'guided', 1, 0).sample('ok', { cachedTokens: 12 }).cachedTokens).toBe(12);
    expect(new ModelCallTimer('guided.draft', 'guided', 1, 0).sample('ok').cachedTokens).toBeNull();
  });

  it('admits nothing but the fixed sets and integers, whatever it is handed', () => {
    const sentinel = 'SENTINEL-LEARNER-TEXT';
    const line = aiCallLogLine(sample({
      call: `guided.draft ${sentinel}` as never,
      operation: sentinel as never,
      outcome: `ok ${sentinel}` as never,
      attempt: 9 as never,
      gateWaitMs: Number.NaN,
      headersMs: -5,
      totalMs: Number.POSITIVE_INFINITY,
      tokensIn: 41.5,
      tokensOut: -1,
      status: 7000,
    }));
    expect(line).toMatch(LINE);
    expect(line).not.toContain(sentinel);
    expect(line).toContain('call=structured.other');
    expect(line).toContain('operation=none');
    expect(line).toContain('outcome=error');
    expect(line).toContain('attempt=1');
    expect(line).toContain('gateWaitMs=none');
    expect(line).toContain('headersMs=0');
    expect(line).toContain('totalMs=none');
    expect(line).toContain('tokensIn=none');
    expect(line).toContain('tokensOut=none');
    expect(line).toContain('status=none');
  });
});

describe('the fixed call label set', () => {
  it('is small, unique and free of anything a prompt could reach', () => {
    expect(new Set(AI_CALL_LABELS).size).toBe(AI_CALL_LABELS.length);
    expect(AI_CALL_LABELS.length).toBeLessThanOrEqual(12);
    for (const label of AI_CALL_LABELS) expect(label).toMatch(/^[a-z][a-z.]{1,30}$/);
    expect(AI_CALL_LABELS).toContain('structured.other');
  });

  it('maps the one strict schema name that exists today and refuses to pass any other through', () => {
    const schema = explanationAssessmentResponseSchema('I removed the inclusive comparison and tested the boundary.');
    expect(structuredCallLabel(schema.name)).toBe('agentic.explanation');
    for (const name of [undefined, '', 'learner_understanding_v5', 'constructor', '__proto__', 'toString',
      `learner_understanding_v6 ${'x'.repeat(5000)}`]) {
      expect(structuredCallLabel(name)).toBe('structured.other');
    }
  });

  it('only ever answers with a label from the set', () => {
    for (const name of [undefined, 'learner_understanding_v6', 'anything else']) {
      expect(AI_CALL_LABELS).toContain(structuredCallLabel(name));
    }
  });

  it('names the two agentic calls no schema name can tell apart, and derives neither', () => {
    // The intent classification and the whole-file rewrite share one method
    // and one absent schema, and differ by an order of magnitude in output.
    // Pooling them measures neither, so each has its own constant.
    expect(AI_CALL_LABELS).toContain('agentic.classify');
    expect(AI_CALL_LABELS).toContain('agentic.generate');
    // The edit-list generation is its own series;
    // its fallback keeps the whole-file label, so the baseline stays like for like.
    expect(AI_CALL_LABELS).toContain('agentic.generate.edits');
    expect(AI_CALL_LABELS).toHaveLength(10);
    // Neither is reachable from a schema name: the call site supplies it.
    for (const name of ['agentic.classify', 'agentic.generate']) expect(structuredCallLabel(name)).toBe('structured.other');
  });
});

describe('ModelCallTimer', () => {
  it('counts nothing until the request is actually on the wire', () => {
    const timer = new ModelCallTimer('grading.review', 'grading', 1, 0);
    expect(timer.started).toBe(false);
    timer.sent();
    expect(timer.started).toBe(true);
  });

  it('measures headers inside the total, and reports no headers when none arrived', () => {
    const timer = new ModelCallTimer('grading.review', 'grading', 1, 12);
    timer.sent();
    timer.headers();
    const withHeaders = timer.sample('ok', { status: 200, tokensIn: 7, tokensOut: 3 });
    expect(withHeaders.headersMs).toBeGreaterThanOrEqual(0);
    expect(withHeaders.totalMs).toBeGreaterThanOrEqual(withHeaders.headersMs!);
    expect(withHeaders).toMatchObject({ call: 'grading.review', operation: 'grading', attempt: 1, gateWaitMs: 12, status: 200, tokensIn: 7, tokensOut: 3, outcome: 'ok' });

    const failed = new ModelCallTimer('grading.review', 'grading', 2, 0);
    failed.sent();
    expect(failed.sample('timeout')).toMatchObject({ headersMs: null, status: null, tokensIn: null, tokensOut: null, outcome: 'timeout' });
  });

  it('keeps a reported zero rather than turning it into an unknown', () => {
    const timer = new ModelCallTimer('interview.answer', 'interview', 1, 0);
    timer.sent();
    expect(timer.sample('ok', { status: 200, tokensIn: 0, tokensOut: 0 })).toMatchObject({ tokensIn: 0, tokensOut: 0 });
  });

  it('times the gate wait monotonically from the moment the caller queued', () => {
    const waited = startGateWait();
    expect(waited()).toBeGreaterThanOrEqual(0);
    expect(waited()).toBeLessThan(5000);
  });
});

describe('observing one model call', () => {
  beforeEach(() => {
    aiModelCallDuration.reset();
    aiModelCallHeaders.reset();
    aiGateWait.reset();
    aiModelCallOutputTokens.reset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('records each series against the agreed labels', async () => {
    observeAiCall(sample({ totalMs: 4100, headersMs: 4012, gateWaitMs: 250, tokensOut: 143 }));
    const text = await renderMetrics();
    expect(text).toContain('ai_model_call_duration_seconds_count{call="guided.draft",operation="guided",outcome="ok"} 1');
    expect(text).toContain('ai_model_call_duration_seconds_sum{call="guided.draft",operation="guided",outcome="ok"} 4.1');
    expect(text).toContain('ai_model_call_headers_seconds_sum{call="guided.draft",operation="guided"} 4.012');
    expect(text).toContain('ai_gate_wait_seconds_sum{call="guided.draft",operation="guided"} 0.25');
    expect(text).toContain('ai_model_call_output_tokens_sum{call="guided.draft"} 143');
  });

  it('leaves out the series a call has no measurement for', async () => {
    observeAiCall(sample({ headersMs: null, tokensIn: null, tokensOut: null, status: null, outcome: 'timeout' }));
    const text = await renderMetrics();
    expect(text).toContain('ai_model_call_duration_seconds_count{call="guided.draft",operation="guided",outcome="timeout"} 1');
    expect(text).not.toContain('ai_model_call_headers_seconds_count{call="guided.draft"');
    expect(text).not.toContain('ai_model_call_output_tokens_count{call="guided.draft"');
  });

  it('counts one gate wait per completion, not one per attempt', async () => {
    observeAiCall(sample({ attempt: 1, gateWaitMs: 300, status: 429, outcome: 'rate_limited', tokensIn: null, tokensOut: null }));
    observeAiCall(sample({ attempt: 2, gateWaitMs: 0 }));
    const text = await renderMetrics();
    expect(text).toContain('ai_gate_wait_seconds_count{call="guided.draft",operation="guided"} 1');
    expect(text).toContain('ai_gate_wait_seconds_sum{call="guided.draft",operation="guided"} 0.3');
    expect(text).toContain('ai_model_call_duration_seconds_count{call="guided.draft",operation="guided",outcome="rate_limited"} 1');
    expect(text).toContain('ai_model_call_duration_seconds_count{call="guided.draft",operation="guided",outcome="ok"} 1');
  });

  it('never lets a broken registry reach the call it is describing', () => {
    jest.spyOn(aiModelCallDuration, 'observe').mockImplementation(() => { throw new Error('registry is gone'); });
    expect(() => observeAiCall(sample())).not.toThrow();
  });

  it('bounds an out-of-range label before it reaches a series', async () => {
    observeAiCall(sample({ call: 'guided.draft; drop=1' as never, operation: 'LEARNER' as never, outcome: 'surprise' as never }));
    const text = await renderMetrics();
    expect(text).toContain('ai_model_call_duration_seconds_count{call="structured.other",operation="none",outcome="error"} 1');
    expect(text).not.toContain('drop=1');
    expect(text).not.toContain('LEARNER');
  });

  it('never poisons a series sum with an unmeasurable duration', async () => {
    observeAiCall(sample({ totalMs: Number.POSITIVE_INFINITY, gateWaitMs: Number.NaN, headersMs: Number.NaN }));
    const text = await renderMetrics();
    expect(text).toContain('ai_model_call_duration_seconds_sum{call="guided.draft",operation="guided",outcome="ok"} 0');
    expect(text).toContain('ai_gate_wait_seconds_sum{call="guided.draft",operation="guided"} 0');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });
});

describe('observing a wait that never became a call', () => {
  beforeEach(() => {
    aiGateWait.reset();
    aiModelCallDuration.reset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('records the queueing of a caller the gate turned away, and nothing else', async () => {
    observeRefusedGateWait('grading.review', 'grading', 21_000);
    const text = await renderMetrics();
    // Without this sample the histogram stops exactly where the wait hurts:
    // the longest waits are the ones that end in a refusal.
    expect(text).toContain('ai_gate_wait_seconds_count{call="grading.review",operation="grading"} 1');
    expect(text).toContain('ai_gate_wait_seconds_sum{call="grading.review",operation="grading"} 21');
    // A refused caller made no model call, so it has no duration to report.
    expect(text).not.toContain('ai_model_call_duration_seconds_count{call="grading.review"');
  });

  it('bounds its labels and its duration like every other observation', async () => {
    observeRefusedGateWait('grading.review; drop=1' as never, 'LEARNER' as never, Number.NaN);
    const text = await renderMetrics();
    expect(text).toContain('ai_gate_wait_seconds_sum{call="structured.other",operation="none"} 0');
    expect(text).not.toContain('drop=1');
    expect(text).not.toContain('LEARNER');
    expect(text).not.toContain('NaN');
  });

  it('never lets a broken registry reach the caller it is describing', () => {
    jest.spyOn(aiGateWait, 'observe').mockImplementation(() => { throw new Error('registry is gone'); });
    expect(() => observeRefusedGateWait('grading.review', 'grading', 10)).not.toThrow();
  });
});

describe('counting a withheld reply', () => {
  beforeEach(() => aiReviewRejections.reset());
  afterEach(() => jest.restoreAllMocks());

  it('counts by surface and bounds the attempt to the two that can happen', async () => {
    recordReviewRejection('guided', 1, ['limited_step']);
    recordReviewRejection('guided', 2, ['limited_step']);
    recordReviewRejection('interview', 99, ['relevant']);
    const text = await renderMetrics();
    expect(text).toContain('ai_review_rejections_total{surface="guided",attempt="1",check="limited_step"} 1');
    expect(text).toContain('ai_review_rejections_total{surface="guided",attempt="2",check="limited_step"} 1');
    // Only a first or a second attempt can happen; anything else is the first.
    expect(text).toContain('ai_review_rejections_total{surface="interview",attempt="1",check="relevant"} 1');
    expect(text).not.toContain('attempt="99"');
  });

  // ONE increment per rejected answer, never one
  // per failed check, so summing the series over `check` gives the number of
  // rejected answers. `check` is the first failed check in the frozen order.
  it('counts one rejected answer once, labelled by the first failed check in the frozen order', async () => {
    expect(REVIEW_REJECTION_CHECKS).toEqual(['limited_step', 'grounded', 'learner_reasoning', 'relevant', 'no_artifact', 'other']);
    expect(Object.isFrozen(REVIEW_REJECTION_CHECKS)).toBe(true);
    const inc = jest.spyOn(aiReviewRejections, 'inc');
    // Two checks failed, listed in the reviewer's order: still one answer, one count.
    recordReviewRejection('guided', 1, ['learner_reasoning', 'limited_step']);
    recordReviewRejection('interview', 2, ['no_artifact', 'relevant', 'grounded']);
    expect(inc.mock.calls).toEqual([
      [{ surface: 'guided', attempt: '1', check: 'limited_step' }],
      [{ surface: 'interview', attempt: '2', check: 'grounded' }],
    ]);
    const { values } = await aiReviewRejections.get();
    expect(values.reduce((sum, value) => sum + value.value, 0)).toBe(2);
  });

  it('bounds the check to the frozen set: an unknown, empty or hostile list is other', async () => {
    const inc = jest.spyOn(aiReviewRejections, 'inc');
    recordReviewRejection('guided', 1, []);
    recordReviewRejection('guided', 1, ['SENTINEL-LEARNER-TEXT']);
    recordReviewRejection('interview', 1, 'grounded' as never);
    recordReviewRejection('interview', 1, undefined as never);
    expect(inc.mock.calls.map(([labels]) => (labels as { check: string }).check)).toEqual(['other', 'other', 'other', 'other']);
    expect(JSON.stringify(inc.mock.calls)).not.toContain('SENTINEL');
  });

  it('never lets a broken counter reach the turn it is describing', () => {
    jest.spyOn(aiReviewRejections, 'inc').mockImplementation(() => { throw new Error('registry is gone'); });
    expect(() => recordReviewRejection('guided', 1, ['grounded'])).not.toThrow();
  });
});
