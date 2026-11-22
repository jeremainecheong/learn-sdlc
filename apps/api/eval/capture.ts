import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-unit capture of every model call, attributed through AsyncLocalStorage
 * so the parallel model lanes never mix records. The transports (the Converse
 * send and the OpenAI fetch) fill a call record; the wrapper around the
 * provider's `attempt()` names it (the product's own call label) and closes it.
 *
 * Raw texts go to `raw/` only, never to stdout.
 */

export type CallOutcome =
  | 'ok' | 'http_error' | 'rate_limited' | 'timeout' | 'error' | 'invalid'
  | 'refusal' | 'context_limit' | 'incomplete' | 'empty' | 'credentials' | 'budget_stop'
  /** Infrastructure, not the model: no HTTP status (DNS, socket reset, sleep): retried on resume, never scored. */
  | 'transport'
  /** A 5xx other than a model error: retried on resume, never scored. */
  | 'server_error'
  /** Reasoning came back from a model whose reasoning is off, or the switch was not sent: the harness's fault, never the model's. */
  | 'harness_fault';

export interface CallRecord {
  label: string;
  attempt: number;
  requestSha256: string | null;
  requestBytes: number | null;
  maxTokensAsked: number | null;
  maxTokensSent: number | null;
  responseText: string | null;
  stopReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cachedTokens: number | null;
  latencyMs: number | null;
  backoffMs: number;
  throttleRetries: number;
  outcome: CallOutcome;
  httpStatus: number | null;
  errorName: string | null;
  fenceNormalised: boolean;
  /** Non-text content blocks in the answer (reasoningContent): shows which models still reason. */
  reasoningBlocks: number;
  /** Reasoning-token count in the usage, if the service reports one. */
  reasoningTokens: number;
  /** The reasoning switch actually sent (canonical JSON), or null. */
  reasoningFieldsSent: string | null;
  /** sha256 of the request less model id, switch and max-tokens clamp: equal across models for the same case. */
  neutralSha256: string | null;
  costUsd: number;
  reservedUsd: number;
}

export interface UnitContext {
  unitId: string;
  modelKey: string;
  caseId: string;
  jobType: string;
  calls: CallRecord[];
  /** Set by the attempt wrapper before the transport runs. */
  current: CallRecord | null;
  /** Replay answers for the dry run, keyed by call label. */
  replay?: (label: string, request: unknown) => string | null;
  /**
   * The live budget for this unit's model: reserve a call's worst case before
   * it is sent (throws BudgetExceeded past the stop), settle to actual usage
   * after (a call with no reported usage is charged its worst case). Returns USD.
   */
  budget?: { reserve(requestBytes: number, maxTokens: number): number; settle(reserved: number, tokensIn: number | null, tokensOut: number | null): number };
}

export const unitStore = new AsyncLocalStorage<UnitContext>();

export function newCall(label: string, attempt: number): CallRecord {
  return {
    label, attempt, requestSha256: null, requestBytes: null, maxTokensAsked: null, maxTokensSent: null,
    responseText: null, stopReason: null, tokensIn: null, tokensOut: null, cachedTokens: null,
    latencyMs: null, backoffMs: 0, throttleRetries: 0, outcome: 'error', httpStatus: null, errorName: null,
    fenceNormalised: false, reasoningBlocks: 0, reasoningTokens: 0, reasoningFieldsSent: null, neutralSha256: null, costUsd: 0, reservedUsd: 0,
  };
}

/** A provider refusal written as text rather than signalled by a stop reason (fixed list, reported separately). */
const REFUSAL_TEXT = /^\s*(?:I(?:'m| am) sorry,? but I can(?:'|no)t|I can(?:'|no)t (?:help|assist) with (?:that|this)|I(?:'m| am) unable to (?:help|assist|comply))/i;

/**
 * Wrap an `OpenAiProvider`-family instance so each `attempt()` opens a call
 * record labelled with the product's own call label (the timer's), and
 * classifies what the attempt returned or threw. The method itself, the
 * product's, runs unchanged.
 */
export function captureAttempts<T extends object>(provider: T): T {
  const proto = Object.getPrototypeOf(provider) as { attempt: (...args: unknown[]) => Promise<any> };
  const original = proto.attempt;
  if (typeof original !== 'function') throw new Error('provider has no attempt() to capture');
  Object.defineProperty(provider, 'attempt', {
    configurable: true,
    value: async function captured(this: unknown, ...args: unknown[]) {
      const ctx = unitStore.getStore();
      const timer = args[4] as { call?: string; attempt?: number } | undefined;
      const record = newCall(String(timer?.call ?? 'structured.other'), Number(timer?.attempt ?? 1));
      record.maxTokensAsked = Number(args[1]);
      if (ctx) { ctx.current = record; ctx.calls.push(record); }
      try {
        const result = await original.apply(provider, args);
        if (result && result.ok === false) {
          const kept: CallOutcome[] = ['context_limit', 'credentials', 'transport', 'server_error', 'harness_fault'];
          record.outcome = kept.includes(record.outcome) ? record.outcome : result.rateLimited ? 'rate_limited' : 'http_error';
        } else if (record.outcome === 'error') {
          record.outcome = 'ok';
          if (record.responseText !== null && REFUSAL_TEXT.test(record.responseText)) record.outcome = 'refusal';
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/harness fault/.test(message)) record.outcome = 'harness_fault';
        else if (record.outcome === 'error' || record.outcome === 'ok') {
          if (/timed out after/.test(message)) record.outcome = 'timeout';
          else if (/stopped before completing/.test(message)) {
            record.outcome = /guardrail|content_filter/.test(record.stopReason ?? '') ? 'refusal'
              : /context_window/.test(record.stopReason ?? '') ? 'context_limit'
                : /length|max_tokens/.test(record.stopReason ?? '') ? 'incomplete' : 'invalid';
          } else if (/empty response/.test(message)) record.outcome = 'empty';
          else if (/budget stop/.test(message)) record.outcome = 'budget_stop';
        }
        throw error;
      } finally {
        if (ctx && ctx.current === record) ctx.current = null;
      }
    },
  });
  return provider;
}

/** Outcomes that say the infrastructure failed, not the model. */
const TRANSIENT_OUTCOMES: ReadonlySet<CallOutcome> = new Set<CallOutcome>(['transport', 'server_error', 'rate_limited']);

/**
 * A unit is transient when one of its calls failed on the infrastructure
 * (no HTTP status, a 5xx, or throttling past every backoff) and no later
 * attempt of the same call label recovered it. Such a unit is neither scored
 * nor counted as an attempt: it is retried on resume.
 */
export function unitIsTransient(calls: readonly CallRecord[]): boolean {
  return calls.some((c, i) => TRANSIENT_OUTCOMES.has(c.outcome)
    && !calls.slice(i + 1).some((later) => later.label === c.label && later.outcome === 'ok'));
}
