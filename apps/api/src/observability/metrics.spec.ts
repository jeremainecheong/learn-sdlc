import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter } from 'events';
import * as promClient from 'prom-client';
import request from 'supertest';
import { AppModule } from '../app.module';
import {
  AI_CALL_LABELS,
  type AiCallOutcome,
  ModelCallTimer,
  observeAiCall,
  observeRefusedGateWait,
  startGateWait,
} from '../assistant/model-call-timing';
import { OpenAiProvider } from '../assistant/openai.provider';
import { RunGate, SandboxBusyError } from '../execution/run-gate';
import { requestLogging } from './logger';
import {
  aiGateWait,
  aiModelCallDuration,
  aiModelCallHeaders,
  aiModelCallOutputTokens,
  aiReviewRejections,
  httpRequestDuration,
  metricsAccess,
  observeHttpRequest,
  recordJobOutcome,
  renderMetrics,
  sandboxExecutionDuration,
  setQueueDepthSource,
} from './metrics';
import { MetricsController } from './metrics.controller';

describe('metricsAccess', () => {
  it('is open in development and closed in production when no token is chosen', () => {
    expect(metricsAccess(undefined, { NODE_ENV: 'development' })).toBe('ok');
    expect(metricsAccess(undefined, {})).toBe('ok');
    expect(metricsAccess(undefined, { NODE_ENV: 'production' })).toBe('disabled');
  });

  it('requires the exact bearer everywhere once a token is set', () => {
    const env = { NODE_ENV: 'development', METRICS_TOKEN: 's3cret' };
    expect(metricsAccess(undefined, env)).toBe('bad-token');
    expect(metricsAccess('Bearer wrong', env)).toBe('bad-token');
    expect(metricsAccess('Bearer s3cre', env)).toBe('bad-token');
    expect(metricsAccess('Basic s3cret', env)).toBe('bad-token');
    expect(metricsAccess('Bearer s3cret', env)).toBe('ok');
  });
});

describe('metric feeds', () => {
  afterEach(() => setQueueDepthSource(null));

  it('records request latency by matched route from the logging middleware', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const middleware = requestLogging(logger as never);

    const hit = (req: Record<string, unknown>, statusCode: number) => {
      const res = Object.assign(new EventEmitter(), { statusCode, setHeader: jest.fn() });
      middleware({ headers: {}, ...req } as never, res as never, () => undefined);
      res.emit('finish');
    };
    hit({ method: 'GET', originalUrl: '/api/v1/phases/abc', route: { path: '/api/v1/phases/:id' } }, 200);
    hit({ method: 'GET', originalUrl: '/wp-admin.php' }, 404);

    const text = await renderMetrics();
    expect(text).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/v1/phases/:id",status="200"} 1',
    );
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="unmatched",status="404"} 1');
  });

  it('counts job outcomes by kind', async () => {
    recordJobOutcome('run', 'failed');
    recordJobOutcome('submission', 'completed');
    recordJobOutcome('submission', 'completed');
    const text = await renderMetrics();
    expect(text).toContain('jobs_processed_total{kind="run",status="failed"} 1');
    expect(text).toContain('jobs_processed_total{kind="submission",status="completed"} 2');
  });

  it('samples queue depth on scrape and does not hang on a dead queue', async () => {
    setQueueDepthSource(async () => ({ waiting: 3, active: 1 }));
    expect(await renderMetrics()).toContain('queue_depth{state="waiting"} 3');

    setQueueDepthSource(() => new Promise(() => undefined));
    const startedAt = Date.now();
    const text = await renderMetrics();
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(text).toContain('queue_depth{state="waiting"} 3');
  }, 5000);
});

describe('GET /metrics', () => {
  const savedEnv = { METRICS_TOKEN: process.env.METRICS_TOKEN, NODE_ENV: process.env.NODE_ENV };
  let app: INestApplication;
  let http: unknown;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [MetricsController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses without the token, and with a wrong one', async () => {
    process.env.METRICS_TOKEN = 's3cret';
    observeHttpRequest('GET', '/probe', 200, 0.01);
    await request(http as never).get('/metrics').expect(401);
    await request(http as never).get('/metrics').set('authorization', 'Bearer nope').expect(401);
  });

  it('serves Prometheus text with the token', async () => {
    process.env.METRICS_TOKEN = 's3cret';
    const res = await request(http as never).get('/metrics').set('authorization', 'Bearer s3cret').expect(200);
    // Express re-orders the parameters when it appends the charset.
    expect(res.headers['content-type']).toMatch(/^text\/plain;.*version=0\.0\.4/);
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toContain('# TYPE jobs_processed_total counter');
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });

  it('is disabled outright in production without a token', async () => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'production';
    const res = await request(http as never).get('/metrics').expect(401);
    expect(res.body.message).toContain('METRICS_TOKEN');
  });

  it('is open in development without a token', async () => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'development';
    await request(http as never).get('/metrics').expect(200);
  });
});

/**
 * prom-client keeps the configured label names on the instance and freezes the
 * bucket bounds as `upperBounds`, so the registered metric is where the shared
 * instrumentation contract can be checked without observing anything.
 */
interface RegisteredShape {
  name: string;
  labelNames: readonly string[];
  upperBounds?: readonly number[];
}
const shapeOf = (metric: unknown): RegisteredShape => metric as RegisteredShape;

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60];
const MODEL_CALL_BUCKETS = [0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120];

describe('latency instrumentation contract', () => {
  it('measures an HTTP request past the ten seconds an AI turn overruns', () => {
    expect(shapeOf(httpRequestDuration).upperBounds).toEqual(HTTP_BUCKETS);
  });

  it('registers each model-call and sandbox metric once, with the agreed labels and buckets', () => {
    expect(shapeOf(aiModelCallDuration)).toMatchObject({
      name: 'ai_model_call_duration_seconds',
      labelNames: ['call', 'operation', 'outcome'],
      upperBounds: MODEL_CALL_BUCKETS,
    });
    expect(shapeOf(aiModelCallHeaders)).toMatchObject({
      name: 'ai_model_call_headers_seconds',
      labelNames: ['call', 'operation'],
      upperBounds: MODEL_CALL_BUCKETS,
    });
    expect(shapeOf(aiGateWait)).toMatchObject({
      name: 'ai_gate_wait_seconds',
      labelNames: ['call', 'operation'],
      upperBounds: [0.005, 0.05, 0.25, 1, 2.5, 5, 10, 20, 30, 60, 120],
    });
    expect(shapeOf(aiModelCallOutputTokens)).toMatchObject({
      name: 'ai_model_call_output_tokens',
      labelNames: ['call'],
      upperBounds: [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800],
    });
    expect(shapeOf(aiReviewRejections)).toMatchObject({
      name: 'ai_review_rejections_total',
      labelNames: ['surface', 'attempt', 'check'],
    });
    expect(shapeOf(sandboxExecutionDuration)).toMatchObject({
      name: 'sandbox_execution_duration_seconds',
      labelNames: ['purpose', 'outcome'],
      upperBounds: [0.5, 1, 2.5, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120],
    });
    for (const metric of [aiModelCallDuration, aiModelCallHeaders, aiGateWait,
      aiModelCallOutputTokens, aiReviewRejections, sandboxExecutionDuration]) {
      expect(promClient.register.getSingleMetric(shapeOf(metric).name)).toBe(metric);
    }
  });

  it('exposes the new series through the same scrape, under call labels from the fixed set', async () => {
    // The label values are the constants the call sites pass, so this is the
    // one worked example of a series an operator will really scrape.
    aiModelCallDuration.observe({ call: 'guided.draft', operation: 'guided', outcome: 'ok' }, 12);
    aiModelCallHeaders.observe({ call: 'guided.draft', operation: 'guided' }, 1.5);
    aiGateWait.observe({ call: 'grading.review', operation: 'grading' }, 0.01);
    aiModelCallOutputTokens.observe({ call: 'guided.draft' }, 900);
    aiReviewRejections.inc({ surface: 'interview', attempt: '2', check: 'relevant' });
    sandboxExecutionDuration.observe({ purpose: 'run', outcome: 'ok' }, 3);

    const text = await renderMetrics();
    expect(text).toContain('# TYPE ai_model_call_duration_seconds histogram');
    expect(text).toContain(
      'ai_model_call_duration_seconds_count{call="guided.draft",operation="guided",outcome="ok"} 1',
    );
    expect(text).toContain('ai_model_call_headers_seconds_count{call="guided.draft",operation="guided"} 1');
    expect(text).toContain('ai_gate_wait_seconds_count{call="grading.review",operation="grading"} 1');
    expect(text).toContain('ai_model_call_output_tokens_sum{call="guided.draft"} 900');
    expect(text).toContain('# TYPE ai_review_rejections_total counter');
    expect(text).toContain('ai_review_rejections_total{surface="interview",attempt="2",check="relevant"} 1');
    expect(text).toContain('sandbox_execution_duration_seconds_count{purpose="run",outcome="ok"} 1');
    // prom-client validates label names and never their values, so the
    // vocabulary is only bounded as long as every call site passes one of the
    // constants. The scrape is where that is visible: a series naming a call
    // site that does not exist in code is a label no dashboard can read.
    const scrapedCalls = [...text.matchAll(/call="([^"]*)"/g)].map(([, value]) => value);
    expect(scrapedCalls.length).toBeGreaterThan(0);
    expect([...new Set(scrapedCalls)].filter(value => !(AI_CALL_LABELS as readonly string[]).includes(value)))
      .toEqual([]);
  });

  it('hands a second load of the module the metrics already on the registry', () => {
    let reloaded!: typeof import('./metrics');
    jest.isolateModules(() => {
      // The registry is the hazard, not the module: a fresh copy has to find
      // what the first copy registered instead of registering the names again.
      jest.doMock('prom-client', () => promClient);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      reloaded = require('./metrics');
    });
    jest.dontMock('prom-client');

    expect(reloaded.httpRequestDuration).toBe(httpRequestDuration);
    expect(reloaded.aiModelCallDuration).toBe(aiModelCallDuration);
    expect(reloaded.aiModelCallHeaders).toBe(aiModelCallHeaders);
    expect(reloaded.aiGateWait).toBe(aiGateWait);
    expect(reloaded.aiModelCallOutputTokens).toBe(aiModelCallOutputTokens);
    expect(reloaded.aiReviewRejections).toBe(aiReviewRejections);
    expect(reloaded.sandboxExecutionDuration).toBe(sandboxExecutionDuration);
  });
});

/**
 * A scraped HELP line, as an operator reads it. prom-client escapes the string
 * onto one line, so this is the whole of what the metric says about itself.
 */
const helpLine = (text: string, metric: string): string =>
  text.split('\n').find(line => line.startsWith(`# HELP ${metric} `)) ?? '';

/**
 * How many samples one series carries right now, zero before its first. The
 * registry is process-wide and this file never resets it, so a count is the
 * file-wide total for that label pair: what a test can state is the change it
 * made itself, which no test added later can disturb.
 */
const sampleCount = (text: string, series: string): number => {
  const line = text.split('\n').find(row => row.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
};

/**
 * `record()` is private on the provider, and its `if (!timer?.started) return`
 * is the behaviour the last test below is about, so this is the one call into
 * it: testing the guard through anything else tests something else.
 */
type PrivateRecorder = { record(timer: ModelCallTimer | undefined, outcome: AiCallOutcome): void };

/**
 * `ai_gate_wait_seconds` is the one series whose samples are not all the same
 * kind of event, and the difference is invisible in the labels: a dashboard
 * reading it as "queueing behind the gate, per model call" is wrong three ways.
 * Each test below drives the real code path and then requires the help text an
 * operator scrapes to admit what that path did.
 */
describe('the gate-wait help text states what the series really holds', () => {
  it('records a refused wait in the same series as a served one, and says so', async () => {
    const series = 'ai_gate_wait_seconds_count{call="guided.review",operation="guided"}';
    const before = sampleCount(await renderMetrics(), series);

    observeAiCall({
      call: 'guided.review', operation: 'guided', attempt: 1,
      gateWaitMs: 2000, headersMs: null, totalMs: 2100,
      tokensIn: null, tokensOut: null, status: null, outcome: 'ok',
    });
    observeRefusedGateWait('guided.review', 'guided', 2000);

    const text = await renderMetrics();
    // Two samples, one series, and nothing in it says which call happened.
    // Stated as the change these two calls made, not as the file-wide total.
    expect(sampleCount(text, series) - before).toBe(2);
    expect(helpLine(text, 'ai_gate_wait_seconds')).toMatch(/refused[^;]*like a served one/i);
  });

  it('lands a queue-full refusal as a near-zero sample, and says so', async () => {
    // On the clock the gate wait is read from, not the machine's.
    // `startGateWait` reads `performance.now()`, so on the wall clock a slow
    // or busy runner could spend 5 ms between the refusal and its observation
    // and fail a claim about the gate that was true. The clock below moves
    // only when this test moves it (and it moves
    // two whole seconds while the slot is held, before the slot is released)
    // so "near zero" is decided by WHEN the refusal arrived, never by how fast
    // the machine was: a refusal that waited for the slot reads 2 s, and one
    // that never joined the line reads exactly nothing.
    const series = { call: 'interview.review', operation: 'interview' };
    const label = `call="${series.call}",operation="${series.operation}"`;
    const read = (text: string, name: string): number => sampleCount(text, `${name}{${label}}`);
    const lowest = (text: string): number => sampleCount(text, `ai_gate_wait_seconds_bucket{le="0.005",${label}}`);
    const before = await renderMetrics();

    let clock = 1_000;
    const clockSpy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    let refusedAfterMs: number | null = null;
    let refusal: unknown;
    try {
      const gate = new RunGate(1, { maxWaiting: 0 });
      let release!: () => void;
      const held = gate.run(() => new Promise<void>(resolve => { release = resolve; }));

      const waited = startGateWait();
      const attempt = gate.run(async () => 'ran').then(
        () => null,
        (err: unknown) => {
          // Read the moment the refusal reaches the caller, as the provider
          // does in its own `catch` (`openai.provider.ts`, `observeRefusedGateWait`).
          refusedAfterMs = waited();
          return err;
        },
      );
      // Every turn the refusal could take to arrive on its own, then the held
      // call runs for two seconds and only then gives its slot up.
      await new Promise(resolve => setImmediate(resolve));
      clock += 2_000;
      release();
      await held;
      refusal = await attempt;
    } finally {
      clockSpy.mockRestore();
    }
    observeRefusedGateWait('interview.review', 'interview', refusedAfterMs ?? Number.NaN);

    // The line was already at its ceiling, so this caller never joined it.
    expect(refusal).toBeInstanceOf(SandboxBusyError);
    expect((refusal as SandboxBusyError).reason).toBe('queue-full');
    // It was refused before a single tick of the held call's two seconds.
    expect(refusedAfterMs).toBe(0);

    const text = await renderMetrics();
    // One sample, of nothing, in the lowest bucket an operator reads: stated
    // as the change this test made, so no other case in the file can move it.
    expect(read(text, 'ai_gate_wait_seconds_count') - read(before, 'ai_gate_wait_seconds_count')).toBe(1);
    expect(text).toContain(`ai_gate_wait_seconds_sum{${label}} `);
    expect(read(text, 'ai_gate_wait_seconds_sum') - read(before, 'ai_gate_wait_seconds_sum')).toBe(0);
    expect(lowest(text) - lowest(before)).toBe(1);
    expect(helpLine(text, 'ai_gate_wait_seconds')).toMatch(/line was already full[^;]*near-zero/i);
  });

  it('loses the wait of an admitted call that never sent its request, and says so', async () => {
    // openai.provider.ts's record() returns early on a timer that never
    // started, so this caller's queueing is observed nowhere: it was admitted,
    // so it is not a refusal either. Both halves drive the real record(): the
    // second reaches the histogram through it, so the absence in the first is
    // the early return and not the test failing to reach the code at all.
    const series = 'ai_gate_wait_seconds_count{call="interview.answer",operation="interview"}';
    const provider = new OpenAiProvider() as unknown as PrivateRecorder;
    // record() logs one line per measured attempt; the assertions are the metrics.
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const timer = new ModelCallTimer('interview.answer', 'interview', 1, 3000);
      expect(timer.started).toBe(false);

      provider.record(timer, 'error');
      const dropped = await renderMetrics();
      expect(dropped).not.toMatch(/ai_gate_wait_seconds_count\{call="interview\.answer"/);
      expect(sampleCount(dropped, series)).toBe(0);
      expect(helpLine(dropped, 'ai_gate_wait_seconds')).toMatch(/before its request is sent records no wait/i);

      timer.sent();
      expect(timer.started).toBe(true);
      provider.record(timer, 'ok');
      expect(sampleCount(await renderMetrics(), series)).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('GET /metrics through the real guard chain', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('needs no JWT and lives at the root, not under api/v1', async () => {
    const http = app.getHttpServer();
    await request(http).get('/metrics').expect(200);
    await request(http).get('/api/v1/metrics').expect(404);
    await request(http).get('/api/v1/analytics/me').expect(401);
  });
});
