/**
 * How long this session has left, read off the token the browser already holds.
 *
 * A managed deployment signs a three-hour session (`apps/api/src/auth/auth.service.ts`,
 * `issueSession`) and `lib/api.ts` renews it in the background while it is in
 * use, up to the API's twelve-hour cap from the sign-in. A session that is not
 * renewed (left idle, or past the cap) still ends at its `exp`, and without a
 * warning that can happen under a learner in the middle of a submission, so
 * the product says the session is nearly up while there is still time to sign
 * in again.
 *
 * Three rules this module keeps:
 *
 * 1. **It is not an authorisation decision.** No signature is checked and no
 *    token is ever rejected here. The API re-verifies every request
 *    (`AuthService.authenticate`); this only decides whether a line of text is
 *    drawn. A token whose payload will not parse, or that carries no `exp`,
 *    gets no warning rather than a sign-out.
 * 2. **Nothing leaves.** The token is read, never logged, never rendered, never
 *    written anywhere new, and no part of the payload but `exp` is returned.
 * 3. **Pure.** No clock of its own: `now` is passed in, so the shell's timer and
 *    the tests agree about what "four minutes left" means.
 */

/** Milliseconds of grace inside which the product says the hour is nearly up. */
export const EXPIRY_WARN_MS = 5 * 60_000;

/** What the shell should say about the session right now. */
export type ExpiryState = 'unknown' | 'live' | 'ending' | 'ended';

/**
 * The JSON of a JWT's payload segment, or a throw.
 *
 * base64url differs from base64 in two characters and in carrying no padding,
 * and a payload may hold a display name outside ASCII, so the bytes are read
 * back as UTF-8 where the platform can do it.
 */
function payloadOf(segment: string): unknown {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  let text = bytes;
  try {
    text = new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
  } catch {
    // Not valid UTF-8. `exp` is digits either way, so the raw bytes will do.
  }
  return JSON.parse(text);
}

/**
 * The `exp` claim as milliseconds, or null for a token this cannot read.
 *
 * Null is the safe answer everywhere it appears: the caller draws nothing.
 */
export function tokenExpiresAt(token: string | null): number | null {
  if (!token) return null;
  const segments = token.split('.');
  if (segments.length < 2 || !segments[1]) return null;
  try {
    const payload = payloadOf(segments[1]);
    if (!payload || typeof payload !== 'object') return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    // Not a readable JWT. Silence, not suspicion.
    return null;
  }
}

/**
 * Whether the hour is unknown, comfortable, nearly up, or up.
 *
 * `'ending'` includes the boundary, so a token with exactly five minutes left
 * is already being warned about rather than one tick later.
 */
export function expiryState(expiresAt: number | null, now: number): ExpiryState {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return 'unknown';
  const left = expiresAt - now;
  if (left <= 0) return 'ended';
  return left <= EXPIRY_WARN_MS ? 'ending' : 'live';
}

/**
 * How long is left, in words a learner can act on.
 *
 * Deliberately vague. This lands in a polite live region, and a precise
 * countdown there is read out again on every change; and "0 minutes" is a
 * sentence the product should never write, so the last minute has its own
 * phrase.
 */
export function minutesLeftLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left < 60_000) return 'less than a minute';
  const minutes = Math.max(1, Math.round(left / 60_000));
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
