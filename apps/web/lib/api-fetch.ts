/**
 * The small pieces every fetch to the API shares, whether it goes through
 * `request` (lib/api.ts) or is a download that has to keep its bytes: the
 * bearer header, the refusal's sentence, the deadline and how a timeout is
 * told apart.
 */

/** One path segment, encoded, for an id or a name placed in a route. */
export const seg = encodeURIComponent;

/** The bearer header for a token, or no header at all where there is none. */
export function authHeader(token: string | null | undefined): { authorization: string } | Record<string, never> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The sentence an API refusal carries: its `message`, several joined with
 * "; ", or `fallback` when it carries none.
 */
export function apiErrorMessage(data: unknown, fallback: string): string {
  const message = (data as { message?: unknown }).message;
  return Array.isArray(message) ? message.join('; ') : (message as string) || fallback;
}

/**
 * A deadline for a fetch. AbortSignal.timeout is in every browser this app
 * supports; where it is not (an old jsdom, a server render), the request goes
 * without a deadline rather than throwing.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** The abort a timeout produces, told apart from a caller cancelling. */
export function isTimeout(err: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  );
}
