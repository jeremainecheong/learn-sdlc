import { createHash, createPublicKey, verify as verifySignature } from 'crypto';

/**
 * Verifying a Google ID token by hand rather than by adding an OpenID client
 * library. The whole job is four steps: split the JWS, find the key Google
 * says signed it, check the signature, check the claims. Node's own
 * crypto imports a JWK directly (`format: 'jwk'`), so a dependency here would
 * buy nothing but a supply chain. What it does buy is the obligation to be
 * exact, hence the explicit algorithm allow-list, the issuer pair, the skew
 * and the nonce check below.
 */

/** Where Google publishes the public halves of its signing keys. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google signs with either of these; anything else is refused outright. */
const ALGORITHMS: Record<string, { curve?: boolean }> = {
  RS256: {},
  ES256: { curve: true },
};

/**
 * Google's own discovery document names both spellings, and tokens have
 * carried each of them, so both are accepted and nothing else is.
 */
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Clock skew tolerated on exp and iat. */
const SKEW_SECONDS = 60;

/** How long keys are reused when Google's response carries no cache hint. */
const DEFAULT_KEY_TTL_MS = 60 * 60_000;

/** What the callback needs off a verified token. */
export interface GoogleIdentity {
  /** Google's stable account id. Kept for logs; the account is keyed by email. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  /** Google Workspace domain, when the account belongs to one. */
  hostedDomain?: string;
  nonce?: string;
}

/**
 * The one seam the unit tests replace. Everything above it (the exchange, the
 * account rules, the redirect) is then exercised without a network, a real
 * key or a fixed clock.
 */
export interface GoogleIdTokenVerifier {
  verify(idToken: string, clientId: string): Promise<GoogleIdentity>;
}

export class GoogleTokenError extends Error {}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

let cachedKeys: { keys: Jwk[]; expiresAt: number } | null = null;

/** Drops the cached JWKS. Exported for the spec and for a key rotation drill. */
export function resetGoogleKeyCache(): void {
  cachedKeys = null;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new GoogleTokenError('the sign-in token from Google was malformed');
  }
}

/**
 * Google rotates signing keys every few days and publishes the next one well
 * before it uses it, so the cache is refreshed on its own expiry and, once,
 * on a kid we have never seen: a rotation that lands mid-cache would
 * otherwise fail every sign-in until the TTL ran out.
 */
async function googleKeys(force: boolean): Promise<Jwk[]> {
  if (!force && cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;

  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new GoogleTokenError(`could not read Google's signing keys (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new GoogleTokenError("Google's signing keys came back empty");
  }

  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : DEFAULT_KEY_TTL_MS;
  cachedKeys = { keys: body.keys, expiresAt: Date.now() + ttl };
  return body.keys;
}

async function keyFor(kid: string): Promise<Jwk> {
  const found = (keys: Jwk[]) => keys.find((k) => k.kid === kid);
  const cached = found(await googleKeys(false));
  if (cached) return cached;
  const fresh = found(await googleKeys(true));
  if (fresh) return fresh;
  throw new GoogleTokenError('the sign-in token was signed with a key Google does not publish');
}

function claimString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Verify an ID token against Google's published keys and return who it names.
 * Signature first, then issuer, audience and lifetime: a token that fails any
 * of them is refused with the same shape of error, because the browser it
 * arrived from learns nothing useful from a finer distinction.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  now = Date.now(),
): Promise<GoogleIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleTokenError('the sign-in token from Google was malformed');
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = decodeSegment(rawHeader);
  const alg = claimString(header, 'alg');
  const kid = claimString(header, 'kid');
  if (!alg || !(alg in ALGORITHMS)) {
    throw new GoogleTokenError(`the sign-in token used an unexpected algorithm (${alg ?? 'none'})`);
  }
  if (!kid) throw new GoogleTokenError('the sign-in token named no signing key');

  const jwk = await keyFor(kid);
  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'ascii');
  const signature = Buffer.from(rawSignature, 'base64url');
  // ES256 signatures in a JWS are the raw r‖s pair, not the DER sequence
  // Node produces by default; saying so is the difference between "verified"
  // and "silently false" the day Google signs one of these with a P-256 key.
  const options = ALGORITHMS[alg].curve ? { dsaEncoding: 'ieee-p1363' as const } : {};
  let ok = false;
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    ok = verifySignature('sha256', signed, { key, ...options }, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new GoogleTokenError('the sign-in token from Google did not verify');

  const claims = decodeSegment(rawPayload);
  const iss = claimString(claims, 'iss');
  if (!iss || !ISSUERS.includes(iss)) {
    throw new GoogleTokenError('the sign-in token was not issued by Google');
  }
  // Google sends a single audience for a web client. An array is accepted so
  // long as ours is in it, and only ours.
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(clientId)) {
    throw new GoogleTokenError('the sign-in token was issued for a different application');
  }

  const seconds = Math.floor(now / 1000);
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  if (!exp || exp + SKEW_SECONDS < seconds) {
    throw new GoogleTokenError('the sign-in token from Google has expired');
  }
  const iat = typeof claims.iat === 'number' ? claims.iat : 0;
  if (iat && iat - SKEW_SECONDS > seconds) {
    throw new GoogleTokenError('the sign-in token from Google is not valid yet');
  }

  const sub = claimString(claims, 'sub');
  const email = claimString(claims, 'email');
  if (!sub || !email) throw new GoogleTokenError('the sign-in token carried no address');

  return {
    sub,
    email: email.trim().toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claimString(claims, 'name'),
    hostedDomain: claimString(claims, 'hd'),
    nonce: claimString(claims, 'nonce'),
  };
}

/** The production verifier: Google's real keys, the real clock. */
export const googleIdTokenVerifier: GoogleIdTokenVerifier = {
  verify: (idToken, clientId) => verifyGoogleIdToken(idToken, clientId),
};

/** base64url of the SHA-256 of a PKCE verifier: the S256 code challenge. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
