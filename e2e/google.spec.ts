import { expect, request as apiRequest, test } from '@playwright/test';
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { API_ORIGIN, WEB_ORIGIN } from './support/env';
import { E2E_DATA_DIR, REPO_ROOT } from './support/paths';
import { E2E_JWT_SECRET } from './support/session-secret';
import { NAVIGATION } from './support/timeouts';

/**
 * Sign in with Google, without Google.
 *
 * Nothing here talks to accounts.google.com: the flow is only ever driven as
 * far as the redirect, which is the last thing this codebase decides. What is
 * covered is the part a deployment gets wrong: whether the button appears at
 * all, what the redirect actually carries, and what a learner sees when the
 * callback is fed something it should refuse.
 *
 * Two API servers are involved. The suite's own (playwright.config.ts) has no
 * OAuth client, which is the shape most deployments run; a second one is
 * started here with GOOGLE_CLIENT_ID set, because the configuration is read
 * once at boot and there is no honest way to fake it in a running process.
 *
 * The success half is driven too. Google is stood in for by the stub
 * below, a token endpoint and a JWKS document on a loopback port, and
 * `e2e/google-endpoints.cjs` preloaded into the second server so its two
 * outbound URLs land here. Everything between the callback and the redirect is
 * the product's own: the real exchange with the real client secret and PKCE
 * verifier, real RS256 verification against a key the stub publishes, the real
 * nonce and audience and issuer checks, the real domain rule, the real account
 * rules and the real session.
 */

/* --------------------------------- the stub ------------------------------- */

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf as never).toString('base64url');

/** What the stub will answer with, for one authorization code. */
interface Minted {
  email: string;
  nonce: string;
  name?: string;
  emailVerified?: boolean;
}

/** The last exchange the stub was asked to make, for the assertions about it. */
interface Exchange {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  grantType: string;
  codeVerifier: string;
}

class GoogleStub {
  private readonly key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = 'stub-key-1';
  private readonly pending = new Map<string, Minted>();
  private server?: http.Server;
  /** Set on every call to the token endpoint. */
  lastExchange?: Exchange;
  port = 0;

  /** The token this code will be swapped for, when the API comes asking. */
  willMint(code: string, claims: Minted): void {
    this.pending.set(code, claims);
  }

  private idToken(claims: Minted): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: this.kid, typ: 'JWT' };
    const payload = {
      iss: 'https://accounts.google.com',
      aud: 'x',
      sub: `google-${crypto.createHash('sha256').update(claims.email).digest('hex').slice(0, 12)}`,
      email: claims.email,
      email_verified: claims.emailVerified !== false,
      name: claims.name,
      nonce: claims.nonce,
      iat: now,
      exp: now + 600,
    };
    const signed = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = crypto.sign('sha256', Buffer.from(signed, 'ascii'), this.key.privateKey);
    return `${signed}.${b64url(signature)}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/jwks')) {
        const jwk = this.key.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] }));
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/token')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const form = new URLSearchParams(body);
          this.lastExchange = {
            code: form.get('code') ?? '',
            clientId: form.get('client_id') ?? '',
            clientSecret: form.get('client_secret') ?? '',
            redirectUri: form.get('redirect_uri') ?? '',
            grantType: form.get('grant_type') ?? '',
            codeVerifier: form.get('code_verifier') ?? '',
          };
          const claims = this.pending.get(this.lastExchange.code);
          if (!claims) {
            // Exactly what Google answers a code it has never seen, so the
            // refusal the learner gets is the real one.
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          this.pending.delete(this.lastExchange.code);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id_token: this.idToken(claims), token_type: 'Bearer' }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

const stub = new GoogleStub();

/** The one domain the configured API's Google sign-in accepts: reserved (RFC 2606), so it can never be a real school's. */
const ALLOWED_DOMAIN = 'school.example';
/** Beside the suite's own API, never on top of it. */
const CONFIGURED_PORT = Number(new URL(API_ORIGIN).port) + 1;
const CONFIGURED_URL = `http://localhost:${CONFIGURED_PORT}`;

let configured: ChildProcess | undefined;
/** The end of what the second API wrote to stderr, so a refusal to start names itself. */
let configuredStderr = '';

test.beforeAll(async ({ request }) => {
  await stub.start();

  // Under the suite's own data directory, which is git-ignored and cleared
  // by the webServer command before any of this runs.
  const dataDir = path.join(REPO_ROOT, E2E_DATA_DIR, 'google');
  fs.rmSync(dataDir, { recursive: true, force: true });

  configured = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      API_PORT: String(CONFIGURED_PORT),
      DB_PATH: path.join(dataDir, 'google.sqlite'),
      WEB_ORIGIN,
      // The API refuses to start without a session secret.
      JWT_SECRET: E2E_JWT_SECRET,
      // The pair the whole feature is gated on. Neither is ever presented to
      // Google in this suite: the flow stops at the redirect.
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'y',
      ALLOWED_EMAIL_DOMAINS: ALLOWED_DOMAIN,
      // Otherwise the default is derived from API_PORT, which is what we want
      // anyway; naming it keeps the assertion below about one thing.
      GOOGLE_REDIRECT_URL: `${CONFIGURED_URL}/api/v1/auth/google/callback`,
      // Google's two endpoints, for this process only (e2e/google-endpoints.cjs).
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${path.join(__dirname, 'google-endpoints.cjs')}`.trim(),
      E2E_GOOGLE_TOKEN_URL: `http://127.0.0.1:${stub.port}/token`,
      E2E_GOOGLE_JWKS_URL: `http://127.0.0.1:${stub.port}/jwks`,
    },
  });

  configured.stderr?.on('data', (chunk: Buffer) => {
    configuredStderr = (configuredStderr + chunk.toString()).slice(-4_000);
  });

  await expect
    .poll(
      async () => {
        // An API that stopped at boot never answers: say why instead of waiting.
        const ended = configured?.exitCode ?? configured?.signalCode;
        if (ended != null) return `stopped (${ended}): ${configuredStderr.trim()}`;
        try {
          return (await request.get(`${CONFIGURED_URL}/api/v1/health`)).status();
        } catch {
          return 0;
        }
      },
      { timeout: NAVIGATION, message: 'the configured API never came up' },
    )
    .toBe(200);
});

test.afterAll(async () => {
  configured?.kill('SIGTERM');
  await stub.stop();
});

test('with no OAuth client the product looks untouched', async ({ page, request }) => {
  const providers = await request.get(`${API_ORIGIN}/api/v1/auth/providers`);
  expect(providers.ok()).toBeTruthy();
  // The whole answer, exactly: the sign-in page reads more than the Google
  // switch from it (auth/google.controller.ts, providers()).
  expect(await providers.json()).toEqual({
    google: false,
    authProvider: 'local',
    confirmationRequired: false,
    ssoProviders: [],
    passwordChange: true,
    accountDeletion: true,
  });

  await page.goto('/login');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await expect(page.getByTestId('login-google')).toBeHidden();

  await page.goto('/register');
  await expect(page.getByTestId('register-submit')).toBeVisible();
  await expect(page.getByTestId('login-google')).toBeHidden();

  // And the route itself refuses rather than redirecting somewhere useless.
  const start = await request.get(`${API_ORIGIN}/api/v1/auth/google`, { maxRedirects: 0 });
  expect(start.status()).toBe(400);
  expect(await start.text()).toContain('not configured');
});

test('a configured server offers the provider and redirects to Google', async ({ request }) => {
  const providers = await request.get(`${CONFIGURED_URL}/api/v1/auth/providers`);
  expect(await providers.json()).toEqual({
    google: true,
    authProvider: 'local',
    confirmationRequired: false,
    ssoProviders: [],
    passwordChange: true,
    accountDeletion: true,
  });

  const start = await request.get(`${CONFIGURED_URL}/api/v1/auth/google?next=/workspace/p1`, {
    maxRedirects: 0,
  });
  expect(start.status()).toBe(302);

  const target = new URL(start.headers()['location']);
  expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(target.searchParams.get('client_id')).toBe('x');
  expect(target.searchParams.get('scope')).toBe('openid email profile');
  expect(target.searchParams.get('redirect_uri')).toBe(
    `${CONFIGURED_URL}/api/v1/auth/google/callback`,
  );
  expect(target.searchParams.get('code_challenge_method')).toBe('S256');
  // One allowed domain, so Google is asked for it before the picker is drawn.
  expect(target.searchParams.get('hd')).toBe(ALLOWED_DOMAIN);

  const state = target.searchParams.get('state');
  expect(state).toBeTruthy();
  expect((state as string).split('.')).toHaveLength(2);
  // The PKCE verifier is derived server-side; it must not be in the URL.
  expect(start.headers()['location']).not.toContain('code_verifier');
});

test('the sign-in is bound to the browser that started it', async ({ request }) => {
  const start = await request.get(`${CONFIGURED_URL}/api/v1/auth/google`, { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const target = new URL(start.headers()['location']);
  const nonce = target.searchParams.get('nonce') as string;
  const state = target.searchParams.get('state') as string;

  // The nonce goes to Google in the URL and stays here in a cookie, so the
  // callback can tell an attempt this browser started from one it was handed.
  const cookies = start
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
  expect(cookies).toHaveLength(1);
  // Plain http on localhost, so the plain name; an https callback takes the
  // __Host- prefix and Secure with it.
  expect(cookies[0]).toContain(`oauth-nonce=${nonce}`);
  expect(cookies[0]).toContain('HttpOnly');
  expect(cookies[0]).toContain('SameSite=Lax');
  expect(cookies[0]).toContain('Path=/');

  // A browser holding no cookie cannot finish somebody else's attempt, and the
  // refusal lands before a byte is sent to Google.
  const stranger = await apiRequest.newContext();
  try {
    const refused = await stranger.get(
      `${CONFIGURED_URL}/api/v1/auth/google/callback?code=whatever&state=${encodeURIComponent(state)}`,
      { maxRedirects: 0 },
    );
    expect(refused.status()).toBe(400);
    const body = await refused.text();
    expect(body).toContain('That sign-in did not go through');
    expect(body).toContain('that sign-in did not start in this browser');
  } finally {
    await stranger.dispose();
  }
});

test('a callback with a state we did not sign gets a page, not a stack trace', async ({ request }) => {
  const refused = await request.get(
    `${CONFIGURED_URL}/api/v1/auth/google/callback?code=whatever&state=forged.signature`,
    { maxRedirects: 0 },
  );
  expect(refused.status()).toBe(400);
  const body = await refused.text();
  expect(refused.headers()['content-type']).toContain('text/html');
  expect(body).toContain('That sign-in did not go through');
  expect(body).toContain('that sign-in link is not one of ours');
  expect(body).toContain('Back to sign in');
  // Nothing that only a developer could use.
  expect(body).not.toContain('at GoogleService');
});

test('the button appears when the server says the provider is on', async ({ page }) => {
  // The browser bundle is built against the suite's own API, so this test
  // answers the one call that decides the button from the configured server
  // instead. What is under test is the page, not the fetch.
  await page.route('**/api/v1/auth/providers', (route) =>
    route.continue({ url: `${CONFIGURED_URL}/api/v1/auth/providers` }),
  );

  await page.goto('/login?next=/workspace/p1');
  const button = page.getByTestId('login-google');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Continue with Google');
  // Above the password form, as the design has it.
  const order = await page.evaluate(() => {
    const google = document.querySelector('[data-testid="login-google"]');
    const password = document.querySelector('[data-testid="login-submit"]');
    if (!google || !password) return 'missing';
    return google.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING
      ? 'google first'
      : 'password first';
  });
  expect(order).toBe('google first');

  // It carries where the learner was heading through the whole round trip.
  const href = await button.getAttribute('href');
  expect(href).toContain('/api/v1/auth/google?next=%2Fworkspace%2Fp1');
});

test('the callback page refuses a landing with no session in it', async ({ page }) => {
  await page.goto('/login/callback');
  await expect(page.getByTestId('google-callback-error')).toBeVisible();
  await expect(page.getByTestId('google-callback-error')).toContainText('did not carry a session');
  await expect(page.getByTestId('to-login')).toBeVisible();
});

// Its own test rather than a second visit in the one above: two URLs that
// differ only by fragment are one document to the browser, so the page would
// never mount again and the assertions would pass on the first visit's state.
test('the callback page refuses a token the API will not answer to', async ({ page }) => {
  // This tab pressed the button: without that mark the page refuses the
  // landing before it asks the API anything, which
  // e2e/token-hygiene.spec.ts covers on its own.
  await page.addInitScript(() => sessionStorage.setItem('lsdlc_oauth_started', '1'));
  await page.goto('/login/callback#token=not-a-real-token');
  await expect(page.getByTestId('google-callback-error')).toBeVisible();
  await expect(page.getByTestId('google-callback-error')).toContainText('was not accepted');
  // Not left behind in storage for the next page to trip over.
  expect(await page.evaluate(() => localStorage.getItem('lsdlc_token'))).toBeNull();
  // And out of the address bar, so it is not in the history entry either.
  expect(page.url()).not.toContain('token=');
});

/* ------------------------- the success path, over HTTP -------------------- */

/**
 * One sign-in, driven the way a browser drives it.
 *
 * This runs the whole chain from `google.controller.ts` end to end (state,
 * cookie, exchange, verify, nonce, domain, account, session, redirect).
 * The spec above covers the refusals and the unit spec replaces both the
 * signature check and the exchange, so without this the one path a cohort
 * actually takes is the one nothing executes.
 */
async function signInWithGoogle(
  claims: { email: string; name?: string; emailVerified?: boolean },
  next?: string,
): Promise<{ status: number; location: string; body: string; challenge: string }> {
  const browser = await apiRequest.newContext();
  try {
    const path = next ? `?next=${encodeURIComponent(next)}` : '';
    const start = await browser.get(`${CONFIGURED_URL}/api/v1/auth/google${path}`, {
      maxRedirects: 0,
    });
    expect(start.status()).toBe(302);
    const target = new URL(start.headers()['location']);
    const nonce = target.searchParams.get('nonce') as string;
    const state = target.searchParams.get('state') as string;
    const challenge = target.searchParams.get('code_challenge') as string;

    // What Google would hand back for the code it is about to be given.
    const code = `stub-code-${Math.random().toString(36).slice(2)}`;
    stub.willMint(code, { ...claims, nonce });

    // The browser follows Google's redirect back, carrying the cookie the
    // first leg set.
    const back = await browser.get(
      `${CONFIGURED_URL}/api/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { maxRedirects: 0 },
    );
    return {
      status: back.status(),
      location: back.headers()['location'] ?? '',
      body: back.status() === 302 ? '' : await back.text(),
      challenge,
    };
  } finally {
    await browser.dispose();
  }
}

test('an allowed address signs in, lands where it was going, and has an account', async ({
  request,
}) => {
  const email = `ada-${Date.now()}@${ALLOWED_DOMAIN}`;
  const { status, location, challenge } = await signInWithGoogle(
    { email, name: 'Ada Lovelace' },
    '/workspace/p1',
  );

  expect(status).toBe(302);
  const landing = new URL(location);
  expect(landing.origin + landing.pathname).toBe(`${WEB_ORIGIN}/login/callback`);
  // Where they were heading rides in the query; the session rides in the
  // fragment, which is never sent to a server and never written to a log.
  expect(landing.searchParams.get('next')).toBe('/workspace/p1');
  expect(landing.search).not.toContain('token=');
  const token = new URLSearchParams(landing.hash.slice(1)).get('token') as string;
  expect(token).toBeTruthy();

  // The exchange was the real one: the secret only this server holds, the
  // redirect URI it registered, and a PKCE verifier that answers the challenge
  // the redirect carried.
  const exchange = stub.lastExchange!;
  expect(exchange.clientSecret).toBe('y');
  expect(exchange.grantType).toBe('authorization_code');
  expect(exchange.redirectUri).toBe(`${CONFIGURED_URL}/api/v1/auth/google/callback`);
  const answered = crypto.createHash('sha256').update(exchange.codeVerifier).digest('base64url');
  expect(answered).toBe(challenge);

  // And the session it minted is one the API answers to, on an account that
  // did not exist a moment ago.
  const me = await request.get(`${CONFIGURED_URL}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(me.status()).toBe(200);
  const profile = await me.json();
  expect(profile.email).toBe(email);
  expect(profile.displayName).toBe('Ada Lovelace');
  expect(profile.role).toBe('LEARNER');
});

test('an address outside the class is refused with the allowlist message', async () => {
  const { status, body } = await signInWithGoogle({
    email: `outsider-${Date.now()}@elsewhere.example`,
    name: 'Someone Else',
  });

  expect(status).toBe(400);
  expect(body).toContain('That sign-in did not go through');
  expect(body).toContain(`Google sign-in on this server is for @${ALLOWED_DOMAIN} addresses`);
  // The refusal is the whole of it: no session anywhere in the page.
  expect(body).not.toContain('token=');
});

test('an address Google has not confirmed is refused before an account is made', async () => {
  const email = `unconfirmed-${Date.now()}@${ALLOWED_DOMAIN}`;
  const { status, body } = await signInWithGoogle({ email, emailVerified: false });

  expect(status).toBe(400);
  expect(body).toContain('Google has not confirmed that address yet');
});

test('the button and the password form land on the same account, not two', async ({ request }) => {
  const email = `both-ways-${Date.now()}@${ALLOWED_DOMAIN}`;

  // Registered here first, with a password, the way a learner who arrived
  // before their instructor mentioned the button would have.
  const registered = await request.post(`${CONFIGURED_URL}/api/v1/auth/register`, {
    data: { email, password: 'Correct-Horse-9', displayName: 'Grace Hopper' },
  });
  expect(registered.status()).toBe(201);
  const first = (await registered.json()).user.id;

  const { status, location } = await signInWithGoogle({ email, name: 'Grace H' });
  expect(status).toBe(302);
  const token = new URLSearchParams(new URL(location).hash.slice(1)).get('token') as string;

  const me = await request.get(`${CONFIGURED_URL}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  // The same row: a second one would silently orphan a term of work.
  expect((await me.json()).id).toBe(first);

  // The address was never confirmed, so the account is claimed rather than
  // merely entered: the password nobody proved anything with is cleared and
  // the sessions it held are refused.
  const withOldPassword = await request.post(`${CONFIGURED_URL}/api/v1/auth/login`, {
    data: { email, password: 'Correct-Horse-9' },
  });
  expect(withOldPassword.status()).toBe(401);
});
