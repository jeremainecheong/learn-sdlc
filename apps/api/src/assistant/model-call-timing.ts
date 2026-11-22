import { performance } from 'node:perf_hooks';
import {
  aiGateWait,
  aiModelCallDuration,
  aiModelCallHeaders,
  aiModelCallOutputTokens,
  aiReviewRejections,
} from '../observability/metrics';
import { AI_OPERATION_KINDS, type AiOperationKind } from './operation-tracker';

/**
 * Where one model call's time went, and nothing else.
 *
 * Every label a series or a log line can carry is decided here, from a set
 * fixed in code: the call site, the enclosing AI operation and the outcome. No
 * prompt, completion, learner, account or request identifier reaches either,
 * the sample below has nowhere to put one, and `bounded` drops anything that
 * is not already in the set even when a caller is wrong.
 */

/**
 * Every call site that reaches a model, one constant each.
 *
 * The two agentic calls carry no schema and go through the same method, so
 * they are named here rather than derived: one classifies an intent inside a
 * few hundred tokens and the other retypes a whole file inside thousands.
 * They are the two ends of the product's longest wait, and a shared series
 * would measure neither.
 */
export const AI_CALL_LABELS = [
  'guided.draft',
  'guided.review',
  'interview.answer',
  'interview.review',
  'grading.review',
  'agentic.classify',
  'agentic.generate',
  // The edit-list generation, only while AI_AGENTIC_EDIT_LIST is not off.
  'agentic.generate.edits',
  'agentic.explanation',
  'structured.other',
] as const;
export type AiCallLabel = typeof AI_CALL_LABELS[number];

/**
 * The completion-token ceiling each call is sent with (`max_completion_tokens`,
 * or `max_tokens` for a model outside the gpt-5 family). These are part of the
 * request every golden records, so a change here is a change to every body of
 * that call. `structured.other` is the ceiling of a structured call that names
 * none of its own.
 */
export const MAX_COMPLETION_TOKENS: Readonly<Record<AiCallLabel, number>> = Object.freeze({
  'guided.draft': 400,
  'guided.review': 2200,
  'interview.answer': 220,
  'interview.review': 2200,
  'grading.review': 4000,
  'agentic.classify': 3000,
  'agentic.generate': 9000,
  'agentic.generate.edits': 9000,
  'agentic.explanation': 4500,
  'structured.other': 3000,
});

export const AI_CALL_OUTCOMES = ['ok', 'http_error', 'rate_limited', 'timeout', 'aborted', 'invalid', 'error'] as const;
export type AiCallOutcome = typeof AI_CALL_OUTCOMES[number];

const AI_CALL_OPERATIONS = [...AI_OPERATION_KINDS, 'none'] as const;

/**
 * The strict schemas `structured()` is actually called with. A schema
 * name is a string chosen by a caller, so it is never passed through as a
 * label: an unknown name is the catch-all instead, which keeps the series
 * count fixed however many gates are added later. A call site that knows
 * which call it is names itself from the set above; this is the fallback for
 * one that does not.
 */
const STRUCTURED_SCHEMA_CALLS: Readonly<Record<string, AiCallLabel>> = {
  learner_understanding_v6: 'agentic.explanation',
};

export function structuredCallLabel(schemaName?: string): AiCallLabel {
  return typeof schemaName === 'string' && Object.prototype.hasOwnProperty.call(STRUCTURED_SCHEMA_CALLS, schemaName)
    ? STRUCTURED_SCHEMA_CALLS[schemaName]
    : 'structured.other';
}

/** One attempt, as measured. A null is a number this attempt never produced. */
export interface ModelCallSample {
  call: AiCallLabel;
  operation: AiOperationKind | 'none';
  attempt: 1 | 2;
  gateWaitMs: number;
  headersMs: number | null;
  totalMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  status: number | null;
  outcome: AiCallOutcome;
  /**
   * Prompt tokens the provider reports it served from its
   * prefix cache (`usage.prompt_tokens_details.cached_tokens`). A count only;
   * null, or absent, when the provider reported none.
   */
  cachedTokens?: number | null;
}

/**
 * The wait for a provider slot, started when the caller joins the queue and
 * read when its work begins. Kept apart from the call's own clock on purpose:
 * queueing behind the gate is not time the model spent answering.
 */
export function startGateWait(): () => number {
  const queuedAt = performance.now();
  return () => Math.max(0, performance.now() - queuedAt);
}

/**
 * One attempt's monotonic clock. performance.now() rather than Date.now() so a
 * clock adjustment cannot turn a four-second call into a negative one.
 *
 * Honest reading of `headersMs`: these completions do not stream, so the
 * upstream holds the response until the whole reply exists and the headers
 * time is expected to land close to the total. It separates network, queueing
 * and upstream admission from body transfer. It is not a time to first token,
 * and a dashboard must not present it as one.
 */
export class ModelCallTimer {
  private sentAt: number | null = null;
  private headersAt: number | null = null;

  constructor(
    private readonly call: AiCallLabel,
    private readonly operation: AiOperationKind | 'none',
    private readonly attempt: 1 | 2,
    private readonly gateWaitMs: number,
  ) {}

  /** The request is going out now. An assignment only, so it cannot throw. */
  sent(): void {
    this.sentAt = performance.now();
  }

  /** The response headers are in; the body may still be arriving. */
  headers(): void {
    this.headersAt = performance.now();
  }

  /** False until the request is on the wire: a configuration failure before that is not a model call. */
  get started(): boolean {
    return this.sentAt !== null;
  }

  sample(
    outcome: AiCallOutcome,
    reported: { status?: number | null; tokensIn?: number | null; tokensOut?: number | null; cachedTokens?: number | null } = {},
  ): ModelCallSample {
    const sentAt = this.sentAt ?? performance.now();
    return {
      call: this.call,
      operation: this.operation,
      attempt: this.attempt,
      gateWaitMs: this.gateWaitMs,
      headersMs: this.headersAt === null ? null : this.headersAt - sentAt,
      totalMs: performance.now() - sentAt,
      tokensIn: reported.tokensIn ?? null,
      tokensOut: reported.tokensOut ?? null,
      status: reported.status ?? null,
      outcome,
      cachedTokens: reported.cachedTokens ?? null,
    };
  }
}

const fixed = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

/** Labels reduced to the fixed sets, whatever a caller handed over. */
function bounded(sample: ModelCallSample): ModelCallSample {
  return {
    ...sample,
    call: fixed(AI_CALL_LABELS, sample.call, 'structured.other'),
    operation: fixed(AI_CALL_OPERATIONS, sample.operation, 'none'),
    outcome: fixed(AI_CALL_OUTCOMES, sample.outcome, 'error'),
    attempt: sample.attempt === 2 ? 2 : 1,
  };
}

const milliseconds = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? 'none' : String(Math.max(0, Math.round(value)));
const tokens = (value: number | null): string =>
  value === null || !Number.isSafeInteger(value) || value < 0 ? 'none' : String(value);
const httpStatus = (value: number | null): string =>
  value !== null && Number.isInteger(value) && value >= 100 && value <= 599 ? String(value) : 'none';

/**
 * One line per attempt, in a shape that greps and parses the same way every
 * time. It carries integers and fixed tokens only, so an operator reading the
 * log sees where the wait went without seeing anyone's work.
 *
 * `cachedTokens` is appended last, so every field before
 * it keeps its position for a reader that splits on spaces.
 */
export function aiCallLogLine(sample: ModelCallSample): string {
  const row = bounded(sample);
  return `ai_call call=${row.call} operation=${row.operation} attempt=${row.attempt}` +
    ` gateWaitMs=${milliseconds(row.gateWaitMs)} headersMs=${milliseconds(row.headersMs)} totalMs=${milliseconds(row.totalMs)}` +
    ` tokensIn=${tokens(row.tokensIn)} tokensOut=${tokens(row.tokensOut)} status=${httpStatus(row.status)} outcome=${row.outcome}` +
    ` cachedTokens=${tokens(row.cachedTokens ?? null)}`;
}

/** An unmeasurable duration lands as zero rather than turning a sum into NaN. */
const seconds = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0) / 1000;

/**
 * The same attempt as four series. Wrapped whole: a registry failure belongs
 * to the observer, never to the learner request it was describing.
 */
export function observeAiCall(sample: ModelCallSample): void {
  try {
    const { call, operation, outcome, attempt, headersMs, totalMs, gateWaitMs, tokensOut } = bounded(sample);
    aiModelCallDuration.observe({ call, operation, outcome }, seconds(totalMs));
    if (headersMs !== null && Number.isFinite(headersMs)) aiModelCallHeaders.observe({ call, operation }, seconds(headersMs));
    // One gate acquisition per completion, so a 429 retry does not add a
    // second, zero-length wait to the queueing histogram.
    if (attempt === 1) aiGateWait.observe({ call, operation }, seconds(gateWaitMs));
    // Unreported usage stays out rather than arriving as a run of zeros.
    if (tokensOut !== null && Number.isSafeInteger(tokensOut) && tokensOut >= 0) aiModelCallOutputTokens.observe({ call }, tokensOut);
  } catch {
    // Nothing here is worth failing a call for.
  }
}

/**
 * A wait that never became a call: the gate refused the caller past its
 * deadline, the line was already at its ceiling, or the caller was cancelled
 * while it queued. There is no attempt left to carry the sample, so it is
 * observed on its own and into the same series, the histogram is the time
 * callers spend queued behind the gate, and leaving the refusals out would
 * truncate it at exactly the waits worth seeing.
 */
export function observeRefusedGateWait(call: AiCallLabel, operation: AiOperationKind | 'none', waitMs: number): void {
  try {
    aiGateWait.observe({
      call: fixed(AI_CALL_LABELS, call, 'structured.other'),
      operation: fixed(AI_CALL_OPERATIONS, operation, 'none'),
    }, seconds(waitMs));
  } catch {
    // As above: a wait nobody measured is not a request that failed.
  }
}

/**
 * The `check` label's frozen values, the Guided review's
 * three keys, the stakeholder review's two others, and `other` for anything
 * else. A semantic rejection carries review keys only; a malformed or
 * unavailable review is a hard failure that never reaches this counter, so
 * the interview's failure codes are not label values. Order matters: it is
 * the order `recordReviewRejection` picks the one label from.
 */
export const REVIEW_REJECTION_CHECKS = Object.freeze(['limited_step', 'grounded', 'learner_reasoning', 'relevant', 'no_artifact', 'other'] as const);
export type ReviewRejectionCheck = typeof REVIEW_REJECTION_CHECKS[number];

/**
 * A model answer a reviewer refused. Two attempts are all that can happen.
 *
 * The increment rule: **once per refused answer, never once per
 * failed check.** An answer that failed two checks is still one refused
 * answer, so it adds one, labelled with the first of its failed checks in
 * `REVIEW_REJECTION_CHECKS` order, and a sum over `check` is the number of
 * refused answers. The per-check split is therefore "the first check that
 * failed", not "every check that failed". A list that names no known check,
 * empty, unknown, or not a list, is `other`, so no caller's string ever
 * becomes a label value.
 */
export function recordReviewRejection(surface: 'interview' | 'guided', attempt: number, failedChecks: readonly string[]): void {
  try {
    const failed = Array.isArray(failedChecks) ? failedChecks : [];
    const check: ReviewRejectionCheck = REVIEW_REJECTION_CHECKS.find((key) => key !== 'other' && failed.includes(key)) ?? 'other';
    aiReviewRejections.inc({ surface, attempt: attempt === 2 ? '2' : '1', check });
  } catch {
    // As above: the turn has already been withheld on its own terms.
  }
}
