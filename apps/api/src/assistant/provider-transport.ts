/**
 * The provider's transport helpers: the usage a response reports, the error a
 * spent call throws, the retry waits, the boot's review-share line, and the
 * host and model-family rules that shape a request. Pure: no import, no
 * configuration read; `OpenAiProvider` applies them.
 */

/** A completion can spend real tokens even when its output cannot be used. */
export class ProviderUsageError extends Error {
  constructor(message: string, readonly tokensIn: number, readonly tokensOut: number) {
    super(message);
    this.name = 'ProviderUsageError';
  }
}
/**
 * The parts of a chat-completions response body this provider reads. Every
 * field is the provider's to omit or mistype, so each is read as `unknown` and
 * checked where it is used.
 */
export interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown } | undefined>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
}

/** A whole, non-negative token count. */
const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function reportedUsage(data: ChatCompletionBody): { tokensIn: number; tokensOut: number } | null {
  const tokensIn = data.usage?.prompt_tokens;
  const tokensOut = data.usage?.completion_tokens;
  return tokenCount(tokensIn) && tokenCount(tokensOut) ? { tokensIn, tokensOut } : null;
}
/**
 * The prompt tokens the provider says it served from its
 * prefix cache, for the `ai_call` line only. It is read beside the usage
 * above and never joins it: the billed counts, the usage ledger and the
 * request are untouched. The local transport reports no such field.
 */
export function reportedCachedTokens(data: ChatCompletionBody | null | undefined): number | null {
  const cached = data?.usage?.prompt_tokens_details?.cached_tokens;
  return tokenCount(cached) ? cached : null;
}
export function completionError(message: string, usage: { tokensIn: number; tokensOut: number } | null): Error {
  return usage ? new ProviderUsageError(message, usage.tokensIn, usage.tokensOut) : new Error(message);
}

/** Maximum permitted retry wait before reporting provider unavailability. */
export const MAX_RETRY_WAIT_MS = 2_000;
/** What to wait when a 429 arrives with no Retry-After of its own. */
const BLIND_RETRY_WAIT_MS = 500;

/**
 * Whether reviews stay inside a third of the AI slots. Every review is one
 * model call inside a grading job, so at most JOB_CONCURRENCY of the N slots
 * ever go to reviews; at or below floor(N / 3) (at least 1) the rest are left
 * to learners' interactive calls even while every job worker is reviewing.
 * The boot writes the line once, at `log` when within and `warn` when over;
 * it never refuses (a laptop's default jobs exceed a third of the default 4).
 * Counts and fixed words only.
 */
export function aiReviewShare(jobs: number, aiSlots: number): { within: boolean; line: string } {
  const bound = Math.max(1, Math.floor(aiSlots / 3));
  const within = jobs <= bound;
  return {
    within,
    line: `ai_review_share jobs=${jobs} aiSlots=${aiSlots} bound=${bound} ${within ? 'within' : 'over: reviews can hold more than a third of the AI slots'}`,
  };
}

/** How long a 429 asked us to wait, in milliseconds; delta-seconds or an HTTP date. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number {
  const value = (header || '').trim();
  if (!value) return BLIND_RETRY_WAIT_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? BLIND_RETRY_WAIT_MS : Math.max(0, at - now);
}

export const delay = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});

export interface Completion {
  usageReported?: boolean;
  content: string;
  tokensIn: number;
  tokensOut: number;
}

/** The host of OpenAI's own API: a provider there is named `openai`. */
export const OPENAI_HOST = 'api.openai.com';
/** Hosts that mean a model served on this machine or its container host: named `local-ai:<model>`, any other `compatible-ai:<model>`. */
export const LOCAL_AI_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'];
/** The model family sent a reasoning effort and `max_completion_tokens`; any other model gets a temperature and `max_tokens`. */
export const REASONING_MODEL_FAMILY = /^gpt-5(?:[.-]|$)/;
/** The temperature sent to a model outside the reasoning family. */
export const NON_REASONING_TEMPERATURE = 0.4;
