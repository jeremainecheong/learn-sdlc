/* ------------------------- the Agentic edit-list flag --------------------------- */

/**
 * `AI_AGENTIC_EDIT_LIST`: the bounded edit-list experiment for the Agentic
 * generation call. `off` (the default, and the value of an unset variable)
 * sends the whole-file request byte for byte. `on` and `strict` ask for an
 * edit list and behave alike: a list that does not apply fails the turn, and
 * no whole-file request is made in its place. Deployments run it off, and the
 * acceptance and boundary harnesses run with it off.
 */
export const AGENTIC_EDIT_LIST_MODES = ['off', 'on', 'strict'] as const;
export type AgenticEditListMode = typeof AGENTIC_EDIT_LIST_MODES[number];

/** Throws on anything but an unset variable or one of the three modes. Called at boot by AgenticService. */
export function resolveAgenticEditList(env = process.env): AgenticEditListMode {
  const raw = env.AI_AGENTIC_EDIT_LIST;
  if (raw === undefined) return 'off';
  if ((AGENTIC_EDIT_LIST_MODES as readonly string[]).includes(raw)) return raw as AgenticEditListMode;
  throw new Error('AI_AGENTIC_EDIT_LIST must be off, on or strict');
}

/**
 * The value `config` loads with, which never throws: an acceptance script may
 * `require` this module, so a bad value must refuse the API's boot, not the
 * module's load. An invalid value loads
 * as `off`, and AgenticService's constructor refuses it when Nest builds it.
 */
export function agenticEditListAtLoad(env = process.env): AgenticEditListMode {
  try {
    return resolveAgenticEditList(env);
  } catch {
    return 'off';
  }
}

/* ------------------------- the Agentic payload flag ---------------------------- */

/**
 * `AI_AGENTIC_PAYLOAD`: what the Agentic generation call is sent.
 * `full`, the default and the value of an unset variable, builds the whole
 * payload byte for byte. `trim` sends no file twice (the saved workspace only
 * where it differs from the proposed one) and, when the request names
 * editable files, only those files and what they import, with the other
 * editable paths named and read-only imports under `readOnlyContext`
 * (`assistant/agentic-payload.ts`). Only `agentic.generate` changes; classify,
 * the explanation gate and apply are the same in both modes.
 */
export const AGENTIC_PAYLOAD_MODES = ['full', 'trim'] as const;
export type AgenticPayloadMode = typeof AGENTIC_PAYLOAD_MODES[number];

/** Throws on anything but an unset variable or one of the two modes. Called at boot by AgenticService. */
export function resolveAgenticPayload(env = process.env): AgenticPayloadMode {
  const raw = env.AI_AGENTIC_PAYLOAD;
  if (raw === undefined) return 'full';
  if ((AGENTIC_PAYLOAD_MODES as readonly string[]).includes(raw)) return raw as AgenticPayloadMode;
  throw new Error('AI_AGENTIC_PAYLOAD must be full or trim');
}

/** The value `config` loads with, which never throws, as agenticEditListAtLoad. */
export function agenticPayloadAtLoad(env = process.env): AgenticPayloadMode {
  try {
    return resolveAgenticPayload(env);
  } catch {
    return 'full';
  }
}

/* --------------------------- the model provider --------------------------- */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_AI_CONCURRENCY = 4;
/**
 * The most completions one process may hold open. Twelve serves a class of
 * twenty to thirty inside the 55 s route budget on the measured call times; the
 * bound leaves room for a reviewed step up without letting a typo open hundreds
 * of sockets at the provider's rate limit.
 */
export const AI_MAX_CONCURRENCY_BOUND = 32;

/**
 * Upper bound on one completion call, from OPENAI_TIMEOUT_MS. Read per call
 * rather than at import so the spec can shorten it without reloading modules.
 */
export function openaiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseInt(env.OPENAI_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * How many completions this process may have open at once, from
 * AI_MAX_CONCURRENCY. Thirty learners in a lab pressing send is thirty open
 * sockets and thirty times the rate-limit pressure otherwise; the
 * sandbox gates its runs for the same reason.
 *
 * Unset (or empty) is the default, four. Anything else must be a whole number
 * from 1 to AI_MAX_CONCURRENCY_BOUND and is refused by name otherwise, as
 * GRADING_RUN_FANOUT is: a typo in the compose must stop the boot rather
 * than quietly change how many learners the AI serves at once. Fairness is not
 * this number's job: one learner's billable calls already run one at a time
 * (AssistantService's per-learner lock), so a learner holds at most one place
 * in this gate's line whatever N is.
 */
export function aiMaxConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_MAX_CONCURRENCY;
  if (raw === undefined || raw === '') return DEFAULT_AI_CONCURRENCY;
  const value = /^[1-9][0-9]?$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= 1 && value <= AI_MAX_CONCURRENCY_BOUND)) {
    throw new Error(`AI_MAX_CONCURRENCY must be a whole number from 1 to ${AI_MAX_CONCURRENCY_BOUND}`);
  }
  return value;
}

/* ------------------------------ the reply cache ---------------------------- */

const DEFAULT_AI_CACHE_TTL_HOURS = 24;

/**
 * How long a cached reply stays usable, from AI_CACHE_TTL_HOURS. Without an
 * expiry and a sweep, one bad afternoon would be answered from for the rest
 * of the term and the table would never shrink. A day is long enough to cover a
 * lab and the homework behind it, and short enough that a content or guardrail
 * change reaches every learner by the next session.
 */
export function aiCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseFloat(env.AI_CACHE_TTL_HOURS || '');
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AI_CACHE_TTL_HOURS;
  return Math.round(hours * 3_600_000);
}

/* ---------------------------- daily usage diagnostics ---------------------- */

/** Daily usage summaries use the deployment's local calendar day. */
export const DEFAULT_USAGE_TIMEZONE = 'Asia/Singapore';

/**
 * The IANA zone used for daily usage summaries. An unknown zone falls back to
 * the default rather than throwing: a typo in AI_USAGE_TIMEZONE must not take
 * the mentor down, and the day boundary is the only thing it moves.
 */
export function usageTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const zone = (env.AI_USAGE_TIMEZONE || '').trim();
  if (!zone) return DEFAULT_USAGE_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_USAGE_TIMEZONE;
  }
}

