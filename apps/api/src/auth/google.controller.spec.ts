import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { UserEntity } from '../db/entities';
import { AuthService } from './auth.service';
import type { GoogleIdentity, GoogleIdTokenVerifier } from './google-tokens';
import { GoogleController, readCookie } from './google.controller';
import { GoogleService } from './google.service';
import { RATE_LIMIT_COUNTER, RateLimitGuard } from './rate-limit.guard';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The two Google routes over real HTTP.
 *
 * The nonce cookie is the half of the fix that only exists on the wire: the
 * service can be told a nonce, but whether the browser is ever handed one,
 * with attributes that make it worth having, is decided by the response
 * headers. So this drives the redirect and the callback through express and
 * reads what came back.
 */
describe('GoogleController', () => {
  let app: INestApplication;
  // Nest's http server, handed straight to supertest.
  let http: Parameters<typeof request>[0];
  let dataSource: DataSource;
  let verify: jest.Mock<Promise<GoogleIdentity>, [string, string]>;
  let fetchMock: jest.Mock;

  const CLIENT_ID = 'client-id.apps.googleusercontent.com';
  const HTTP_CALLBACK = 'http://localhost:4100/api/v1/auth/google/callback';

  const saved = {
    id: config.googleClientId,
    secret: config.googleClientSecret,
    redirect: config.googleRedirectUrl,
    domains: config.allowedEmailDomains,
  };

  /** The Set-Cookie lines on a response, as an array whatever arrived. */
  const setCookies = (res: request.Response): string[] => {
    const header = res.headers['set-cookie'];
    if (!header) return [];
    return Array.isArray(header) ? header : [header];
  };

  /** The cookie a browser would now be sending back, as a Cookie header. */
  const cookieHeader = (res: request.Response): string =>
    setCookies(res)
      .map((line) => line.split(';')[0])
      .join('; ');

  beforeAll(async () => {
    dataSource = await memoryDataSource();

    verify = jest.fn();
    const verifier: GoogleIdTokenVerifier = { verify: (t, c) => verify(t, c) };
    const auth = new AuthService(passwordWorkFixture(), 
      dataSource.getRepository(UserEntity),
      new JwtService({ secret: config.jwtSecret, signOptions: { expiresIn: '1h' } }),
    );
    const google = new GoogleService(passwordWorkFixture(), dataSource.getRepository(UserEntity), auth, verifier);

    const moduleRef = await Test.createTestingModule({
      controllers: [GoogleController],
      providers: [
        { provide: GoogleService, useValue: google },
        RateLimitGuard,
        // The brake is not what is under test, and a counter of its own keeps
        // this spec off whatever REDIS_URL the shell happens to carry.
        { provide: RATE_LIMIT_COUNTER, useValue: { hit: async () => 1, shutdown: async () => {} } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
    if (dataSource.isInitialized) await dataSource.destroy();
    Object.assign(config, {
      googleClientId: saved.id,
      googleClientSecret: saved.secret,
      googleRedirectUrl: saved.redirect,
      allowedEmailDomains: saved.domains,
    });
  });

  beforeEach(async () => {
    await dataSource.manager.clear(UserEntity);
    Object.assign(config, {
      googleClientId: CLIENT_ID,
      googleClientSecret: 'client-secret',
      googleRedirectUrl: HTTP_CALLBACK,
      allowedEmailDomains: [] as string[],
    });
    verify.mockReset();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id_token: 'signed.id.token' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  /** The first leg, as the browser walks it. */
  async function start(next = ''): Promise<{ res: request.Response; state: string; nonce: string }> {
    const res = await request(http)
      .get(`/api/v1/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`)
      .expect(302);
    const url = new URL(res.headers['location']);
    return {
      res,
      state: url.searchParams.get('state') as string,
      nonce: url.searchParams.get('nonce') as string,
    };
  }

  it('hands the browser the nonce it just sent to Google, and nothing else can read it', async () => {
    const { res, nonce } = await start('/workspace/p1');

    const [cookie] = setCookies(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`oauth-nonce=${nonce}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    // The state's own life: a cookie that outlives it proves nothing.
    expect(cookie).toMatch(/Max-Age=900\b/);
  });

  it('takes the __Host- name and Secure once the callback is https', async () => {
    Object.assign(config, {
      googleRedirectUrl: 'https://learn.example.test/api/v1/auth/google/callback',
    });
    const { res } = await start();
    const [cookie] = setCookies(res);
    expect(cookie).toContain('__Host-oauth-nonce=');
    expect(cookie).toContain('Secure');
  });

  it('refuses a callback that arrives without the cookie, before it calls Google', async () => {
    const { state } = await start();

    const refused = await request(http)
      .get(`/api/v1/auth/google/callback?code=whatever&state=${encodeURIComponent(state)}`)
      .expect(400);

    expect(refused.headers['content-type']).toContain('text/html');
    expect(refused.text).toContain('That sign-in did not go through');
    expect(refused.text).toContain('that sign-in did not start in this browser');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    // Nothing was signed in, and nothing was left behind for a second try.
    expect(await dataSource.manager.count(UserEntity)).toBe(0);
  });

  it('refuses a state started in some other browser', async () => {
    const attacker = await start();
    const victim = await start();

    const refused = await request(http)
      .get(`/api/v1/auth/google/callback?code=whatever&state=${encodeURIComponent(attacker.state)}`)
      .set('cookie', cookieHeader(victim.res))
      .expect(400);

    expect(refused.text).toContain('that sign-in did not start in this browser');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('completes the sign-in when the cookie matches, and spends the cookie', async () => {
    const { res, state, nonce } = await start('/workspace/p1');
    verify.mockResolvedValue({
      sub: '11223344',
      email: 'ada@uni.test',
      emailVerified: true,
      name: 'Ada Lovelace',
      nonce,
    });

    const done = await request(http)
      .get(`/api/v1/auth/google/callback?code=the-code&state=${encodeURIComponent(state)}`)
      .set('cookie', cookieHeader(res))
      .expect(302);

    const landing = new URL(done.headers['location']);
    expect(landing.pathname).toBe('/login/callback');
    expect(landing.searchParams.get('next')).toBe('/workspace/p1');
    // The session travels in the fragment, which no log or proxy ever sees.
    expect(landing.hash).toMatch(/^#token=/);
    expect(landing.search).not.toContain('token=');

    // One attempt, one nonce: the cookie is cleared on the way out.
    const cleared = setCookies(done).find((line) => line.startsWith('oauth-nonce='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/oauth-nonce=;/);
  });

  it('reads the cookie it wants out of a header carrying several', () => {
    expect(readCookie('a=1; oauth-nonce=abc123; b=2', 'oauth-nonce')).toBe('abc123');
    expect(readCookie('oauth-nonce=abc123', 'oauth-nonce')).toBe('abc123');
    // A name that is a suffix of another is not the same name.
    expect(readCookie('not-oauth-nonce=abc123', 'oauth-nonce')).toBeUndefined();
    expect(readCookie(undefined, 'oauth-nonce')).toBeUndefined();
    expect(readCookie('oauth-nonce=', 'oauth-nonce')).toBe('');
  });
});
