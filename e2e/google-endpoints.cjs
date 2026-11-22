/**
 * Point Google's two endpoints at a local stub, for the length of one test
 * server. Loaded with `node --require`, so it is in place before any of the
 * API is.
 *
 * The token endpoint and the JWKS URL are constants in the source
 * (`google.service.ts`, `google-tokens.ts`) and they should stay constants: an
 * environment variable that lets an operator repoint the endpoint that mints
 * sessions is a worse thing to ship than an untested success path. So the
 * redirection lives here, in the harness, and it is nothing but a rewrite of
 * two exact URLs, every other request the process makes goes where it was
 * going. Everything downstream of the fetch is the real thing: the real
 * exchange, the real RS256 verification against the keys the stub publishes,
 * the real domain check, the real account rules and the real redirect.
 *
 * E2E_GOOGLE_TOKEN_URL and E2E_GOOGLE_JWKS_URL are set by e2e/google.spec.ts,
 * which owns the stub server that answers them.
 */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const token = process.env.E2E_GOOGLE_TOKEN_URL;
const jwks = process.env.E2E_GOOGLE_JWKS_URL;

if (token || jwks) {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url);
    if (token && url === GOOGLE_TOKEN_URL) return real(token, init);
    if (jwks && url === GOOGLE_JWKS_URL) return real(jwks, init);
    return real(input, init);
  };
}
