import { createHash, timingSafeEqual } from 'crypto';
import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from 'prom-client';
import { aiOperationSnapshot } from '../assistant/operation-tracker';
import { resolveMetricsToken } from '../config/observability';
import { bearerToken } from '../auth/bearer';

/**
 * Prometheus metrics on prom-client's default registry.
 *
 * Every metric is looked up before it is created: the registry is a
 * process-wide singleton while Jest loads this module once per test file, and
 * prom-client throws on a duplicate name.
 */
function registered<T>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

export const httpRequestDuration = registered(
  'http_request_duration_seconds',
  () =>
    new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds by method, matched route pattern and status code.',
      labelNames: ['method', 'route', 'status'] as const,
      // From sub-10ms reads up to the minute a request can spend waiting on a
      // model call or a sandbox job: with buckets stopping at 10s everything
      // slower would land in +Inf, which is exactly where the slow surfaces are.
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60],
    }),
);

// Fresh process-local observations, behind the existing metrics-token boundary.
// Includes disconnected requests whose retained work has not yet settled.
registered('ai_operations_active', () => new Gauge({
  name: 'ai_operations_active',
  help: 'Unsettled AI operations, including learner queue and retained timeout tails.',
  labelNames: ['kind'] as const,
  collect() { for (const row of aiOperationSnapshot()) this.set({ kind: row.kind }, row.active); },
}));
registered('ai_operation_oldest_seconds', () => new Gauge({
  name: 'ai_operation_oldest_seconds',
  help: 'Monotonic age of the oldest unsettled AI operation by kind; zero when idle.',
  labelNames: ['kind'] as const,
  collect() { for (const row of aiOperationSnapshot()) this.set({ kind: row.kind }, row.oldestSeconds); },
}));

// Where the learner's wait actually goes. Every label value comes from a small
// set fixed in code ('call' is the call site, 'operation' is
// currentAiOperationKind(), 'outcome' is one of ok, http_error, rate_limited,
// timeout, aborted, invalid, error) so a series can never carry a prompt, a
// completion, an account or a request identifier.
const MODEL_CALL_BUCKETS = [0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120];

export const aiModelCallDuration = registered(
  'ai_model_call_duration_seconds',
  () =>
    new Histogram({
      name: 'ai_model_call_duration_seconds',
      help: 'One model call end to end, by call site, enclosing AI operation and outcome.',
      labelNames: ['call', 'operation', 'outcome'] as const,
      buckets: MODEL_CALL_BUCKETS,
    }),
);

export const aiModelCallHeaders = registered(
  'ai_model_call_headers_seconds',
  () =>
    new Histogram({
      name: 'ai_model_call_headers_seconds',
      help: 'Request sent to response headers received, so a slow start is told apart from a long reply.',
      labelNames: ['call', 'operation'] as const,
      buckets: MODEL_CALL_BUCKETS,
    }),
);

export const aiGateWait = registered(
  'ai_gate_wait_seconds',
  () =>
    new Histogram({
      name: 'ai_gate_wait_seconds',
      // Three things a dashboard cannot see in the labels, so they are said
      // here instead. The samples are not one kind of event: a wait the gate
      // turned away is observed by observeRefusedGateWait into this same
      // series, a caller refused because the line was already at its ceiling
      // never queued at all, and a caller the gate admitted whose request is
      // never sent is dropped by the provider's record() with its wait on it.
      help:
        'Time queued behind the AI gate before a call starts. Near zero for one learner alone. ' +
        'Three caveats: a wait the gate refused is observed here exactly like a served one, ' +
        'so the count is not a count of model calls; a refusal because the line was already full ' +
        'never waited, so it lands as a near-zero sample; and an admitted call that fails ' +
        'before its request is sent records no wait at all.',
      labelNames: ['call', 'operation'] as const,
      buckets: [0.005, 0.05, 0.25, 1, 2.5, 5, 10, 20, 30, 60, 120],
    }),
);

export const aiModelCallOutputTokens = registered(
  'ai_model_call_output_tokens',
  () =>
    new Histogram({
      name: 'ai_model_call_output_tokens',
      help: 'Completion tokens a call returned, by call site. A count of tokens, never their text.',
      labelNames: ['call'] as const,
      buckets: [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800],
    }),
);

export const aiReviewRejections = registered(
  'ai_review_rejections_total',
  () =>
    new Counter({
      name: 'ai_review_rejections_total',
      help:
        'Model answers a reviewer refused, by surface, attempt and check. An attempt of 2 is a repaired turn. ' +
        'One count per refused answer, labelled by the first check it failed, so a sum over check is the number of refused answers.',
      labelNames: ['surface', 'attempt', 'check'] as const,
    }),
);

export const sandboxExecutionDuration = registered(
  'sandbox_execution_duration_seconds',
  () =>
    new Histogram({
      name: 'sandbox_execution_duration_seconds',
      help: 'One sandbox execution as the API waits for it, by purpose and outcome. Includes the fresh machine every job gets.',
      labelNames: ['purpose', 'outcome'] as const,
      buckets: [0.5, 1, 2.5, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120],
    }),
);

export const jobsProcessed = registered(
  'jobs_processed_total',
  () =>
    new Counter({
      name: 'jobs_processed_total',
      help: 'Queue jobs finished by kind and outcome. Every failed attempt counts, including ones the queue retries.',
      labelNames: ['kind', 'status'] as const,
    }),
);

export type QueueDepthSource = () => Promise<Record<string, number>>;

let queueDepthSource: QueueDepthSource | null = null;
const QUEUE_DEPTH_TIMEOUT_MS = 1000;

export const queueDepth = registered(
  'queue_depth',
  () =>
    new Gauge({
      name: 'queue_depth',
      help: 'Jobs in the durable queue by state. Sampled on scrape; absent without the Redis backend.',
      labelNames: ['state'] as const,
      async collect() {
        if (!queueDepthSource) return;
        try {
          const counts = await withTimeout(queueDepthSource(), QUEUE_DEPTH_TIMEOUT_MS);
          for (const [state, count] of Object.entries(counts)) this.set({ state }, count);
        } catch {
          // A slow or dead Redis must not turn a scrape into a hang. The last
          // sample stands; /health/ready is where the outage is reported.
        }
      },
    }),
);

/**
 * The promise's answer, or a rejection `timed out after <ms>ms` when it takes
 * longer. The timer is cleared either way, so a fast answer leaves nothing
 * holding the event loop open.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Registered by the durable queue once it exists; null again on shutdown. */
export function setQueueDepthSource(source: QueueDepthSource | null): void {
  queueDepthSource = source;
}

export function observeHttpRequest(method: string, route: string, status: number, seconds: number): void {
  httpRequestDuration.observe({ method, route, status: String(status) }, seconds);
}

export function recordJobOutcome(kind: string, status: 'completed' | 'failed'): void {
  jobsProcessed.inc({ kind, status });
}

export const metricsContentType = register.contentType;

export function renderMetrics(): Promise<string> {
  return register.metrics();
}

export type MetricsAccess = 'ok' | 'bad-token' | 'disabled';

/**
 * METRICS_TOKEN set: every scrape must present it as a bearer token. Unset:
 * open in development, closed in production: process memory, route
 * latencies and queue depth are not for the public internet, and a
 * deployment that never chose a token should not be publishing them.
 */
export function metricsAccess(
  authorization: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MetricsAccess {
  const token = resolveMetricsToken(env);
  if (!token) return env.NODE_ENV === 'production' ? 'disabled' : 'ok';
  const presented = bearerToken(authorization) ?? '';
  return secretsEqual(presented, token) ? 'ok' : 'bad-token';
}

/** Compared as digests so neither the token's length nor its bytes leak through timing. */
function secretsEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// Process CPU, memory, event-loop lag and GC pauses. Guarded like the rest.
if (!register.getSingleMetric('process_cpu_user_seconds_total')) collectDefaultMetrics();
