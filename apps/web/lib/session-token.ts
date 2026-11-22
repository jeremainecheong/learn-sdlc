/**
 * What the web may read from its own session token without asking the API.
 *
 * The token is a JWT the API signed; the browser never verifies it (it has no
 * key, and the API checks it on every request). Two facts are read from the
 * payload segment: when it runs out (`exp`, decoded by lib/session-expiry),
 * which is what tells `lib/api.ts` to renew a managed session in the
 * background, and which sign-in it descends from (`sub` and `orig`), which is
 * what lets a renewed token count as the same session as the one it replaced.
 * It imports nothing but that pure module, so a test that mocks the session
 * store or the API client still gets these.
 */

interface SessionClaims {
  sub?: unknown;
  orig?: unknown;
  provider?: unknown;
}

/** The payload of a JWT, or null for anything that is not one. Never throws. */
function claims(token: string | null | undefined): SessionClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    return parsed && typeof parsed === 'object' ? (parsed as SessionClaims) : null;
  } catch {
    return null;
  }
}

/** When the token stops working, in ms since the epoch, or null if it does not say (one decoder for the shell's warning and the renewal). */
export { tokenExpiresAt } from './session-expiry';

/**
 * Whether two tokens belong to one session: the same token, or a managed
 * token and its renewal (same account, same provider, same `orig`, the
 * sign-in time the API copies unchanged into every renewal). Caches and
 * in-flight work tied to the token they started under use this, so a
 * background renewal does not read as somebody else signing in. A local
 * token carries no `orig`, so for it only the identical token matches.
 */
export function sameSession(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ca = claims(a);
  const cb = claims(b);
  if (!ca || !cb) return false;
  return (
    typeof ca.sub === 'string' && ca.sub === cb.sub &&
    typeof ca.orig === 'number' && ca.orig === cb.orig &&
    ca.provider === cb.provider
  );
}

/**
 * A key that stays the same across a session's renewals: the account,
 * provider and sign-in time of a managed token, or the token itself for one
 * without them (a local token). For memo and effect keys that must not start
 * over when the token is renewed. Null for no token.
 */
export function sessionKey(token: string | null | undefined): string | null {
  if (!token) return null;
  const c = claims(token);
  if (c && typeof c.sub === 'string' && typeof c.orig === 'number' && typeof c.provider === 'string') {
    return `session:${c.provider}:${c.sub}:${c.orig}`;
  }
  return token;
}

/**
 * The window event `lib/api.ts` fires after it has stored a renewed token, so
 * the live-updates socket (lib/socket.ts) reconnects with it. An event rather
 * than an import, because the socket module imports the API client and not
 * the other way round.
 */
export const SESSION_RENEWED_EVENT = 'lsdlc:session-renewed';
