/**
 * The messages the provider throws for a failure it recognises, in one place,
 * so the code that classifies them (`assessmentFailure`,
 * `stakeholderFailureCode`) reads the same text the provider writes. A wording
 * change here moves every reader with it; the texts reach logs and log-based
 * diagnostics, so they change only on purpose.
 */

/** The provider's request ran past `OPENAI_TIMEOUT_MS`. */
export const providerTimedOutMessage = (timeoutMs: number): string => `openai api timed out after ${timeoutMs}ms`;
/** `providerTimedOutMessage`'s text, with the milliseconds captured. */
export const PROVIDER_TIMED_OUT = /^openai api timed out after (\d+)ms$/;

/** The provider answered with an HTTP error status. */
export const providerHttpErrorMessage = (status: number): string => `openai api returned HTTP ${status}`;
/** `providerHttpErrorMessage`'s text for a three-digit status, with the status captured. */
export const PROVIDER_HTTP_ERROR = /^openai api returned HTTP (\d{3})$/;

/** The completion finished for a reason other than `stop` (a length cut, a filter). */
export const PROVIDER_STOPPED_EARLY = 'AI provider stopped before completing its response';
/** The completion carried no text. */
export const PROVIDER_EMPTY_RESPONSE = 'AI provider returned an empty response';
/** The caller's operation ended (its deadline or a cancellation) while the response arrived. */
export const PROVIDER_CALL_ENDED = 'AI operation ended before its response could be used';
/** A rubric review whose text is not JSON. */
export const REVIEW_NOT_JSON = 'AI review was not JSON';
/** A rubric review whose evidence is larger than one review call may carry; refused before any call. */
export const EVIDENCE_OVER_CONTEXT_LIMIT = 'Submission evidence exceeds the assessment context limit';
