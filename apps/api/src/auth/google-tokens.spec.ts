import 'reflect-metadata';
import { generateKeyPairSync, KeyObject, sign as signBytes } from 'crypto';
import {
  GOOGLE_JWKS_URL,
  GoogleTokenError,
  resetGoogleKeyCache,
  verifyGoogleIdToken,
} from './google-tokens';

/**
 * The signature check itself, against a key we generate here and serve where
 * Google's would be. Nothing is stubbed below the fetch: a token that passes
 * this spec passed Node's own RSA verification of the exact bytes Google
 * signs, so the parts most easily got wrong (the base64url segments, the
 * kid lookup, the claim checks) are exercised rather than described.
 */

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 8, 1, 9, 0, 0);
const seconds = Math.floor(NOW / 1000);

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwkOf(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...(key.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function token(
  claims: Record<string, unknown>,
  { kid = 'k1', alg = 'RS256', key = privateKey } = {},
): string {
  const body = `${b64({ alg, kid })}.${b64(claims)}`;
  const signature = signBytes('sha256', Buffer.from(body, 'ascii'), key).toString('base64url');
  return `${body}.${signature}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '11223344',
  email: 'Ada@UNI.test',
  email_verified: true,
  name: 'Ada Lovelace',
  nonce: 'the-nonce',
  iat: seconds - 10,
  exp: seconds + 3600,
  ...over,
});

describe('verifyGoogleIdToken', () => {
  let fetchMock: jest.Mock;

  const keysResponse = (keys: unknown[]) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'public, max-age=3600' },
    json: async () => ({ keys }),
  });

  beforeEach(() => {
    resetGoogleKeyCache();
    fetchMock = jest.fn().mockResolvedValue(keysResponse([jwkOf(publicKey, 'k1')]));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const refuse = (t: string, clientId = CLIENT_ID) =>
    verifyGoogleIdToken(t, clientId, NOW).then(
      () => {
        throw new Error('expected the token to be refused');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(GoogleTokenError);
        return (err as Error).message;
      },
    );

  it('verifies a token Google signed and normalises the address', async () => {
    const identity = await verifyGoogleIdToken(token(claims()), CLIENT_ID, NOW);
    expect(identity).toEqual({
      sub: '11223344',
      email: 'ada@uni.test',
      emailVerified: true,
      name: 'Ada Lovelace',
      hostedDomain: undefined,
      nonce: 'the-nonce',
    });
    expect(fetchMock).toHaveBeenCalledWith(GOOGLE_JWKS_URL);
  });

  it('reuses the published keys for the lifetime Google gives them', async () => {
    await verifyGoogleIdToken(token(claims()), CLIENT_ID, NOW);
    await verifyGoogleIdToken(token(claims()), CLIENT_ID, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a token signed with a key Google does not publish', async () => {
    expect(await refuse(token(claims(), { key: other.privateKey }))).toBe(
      'the sign-in token from Google did not verify',
    );
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const [header, , signature] = token(claims()).split('.');
    const edited = `${header}.${b64(claims({ email: 'attacker@example.com' }))}.${signature}`;
    expect(await refuse(edited)).toBe('the sign-in token from Google did not verify');
  });

  it('refuses an unsigned token, whatever its header claims', async () => {
    const unsigned = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.`;
    expect(await refuse(unsigned)).toContain('unexpected algorithm');
  });

  it('refuses a token issued for another application', async () => {
    expect(await refuse(token(claims()), 'someone-else.apps.googleusercontent.com')).toBe(
      'the sign-in token was issued for a different application',
    );
  });

  it('refuses a token from another issuer', async () => {
    expect(await refuse(token(claims({ iss: 'https://accounts.example.com' })))).toBe(
      'the sign-in token was not issued by Google',
    );
  });

  it('refuses a token whose life is over, skew included', async () => {
    expect(await refuse(token(claims({ exp: seconds - 120 })))).toBe(
      'the sign-in token from Google has expired',
    );
  });

  it('refetches the keys once when the kid is new, so a rotation does not lock everyone out', async () => {
    fetchMock
      .mockResolvedValueOnce(keysResponse([jwkOf(other.publicKey, 'old')]))
      .mockResolvedValueOnce(keysResponse([jwkOf(other.publicKey, 'old'), jwkOf(publicKey, 'k2')]));

    const identity = await verifyGoogleIdToken(token(claims(), { kid: 'k2' }), CLIENT_ID, NOW);
    expect(identity.sub).toBe('11223344');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a kid that is still unknown after the refetch', async () => {
    fetchMock.mockResolvedValue(keysResponse([jwkOf(other.publicKey, 'old')]));
    expect(await refuse(token(claims(), { kid: 'ghost' }))).toBe(
      'the sign-in token was signed with a key Google does not publish',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a token that is not three segments', async () => {
    expect(await refuse('not-a-jwt')).toBe('the sign-in token from Google was malformed');
  });
});
