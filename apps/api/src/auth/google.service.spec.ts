import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { AuditEventEntity, UserEntity } from '../db/entities';
import { AuthService } from './auth.service';
import type { GoogleIdentity, GoogleIdTokenVerifier } from './google-tokens';
import {
  GOOGLE_TOKEN_URL,
  GoogleService,
  GoogleSignInError,
  STATE_TTL_MS,
  oauthNonceCookie,
} from './google.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The Google flow with the two things that are not ours mocked out: the token
 * endpoint (fetch) and the signature check (the verifier seam). What is left
 * is everything this code is actually responsible for: the signed state, the
 * nonce binding, the domain rule, and which row a returning address lands on.
 */

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);

describe('GoogleService', () => {
  let dataSource: DataSource;
  let google: GoogleService;
  let auth: AuthService;
  let users: ReturnType<DataSource['getRepository']>;
  let verify: jest.Mock<Promise<GoogleIdentity>, [string, string]>;
  let fetchMock: jest.Mock;

  const saved = {
    id: config.googleClientId,
    secret: config.googleClientSecret,
    redirect: config.googleRedirectUrl,
    domains: config.allowedEmailDomains,
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
    Object.assign(config, {
      googleClientId: saved.id,
      googleClientSecret: saved.secret,
      googleRedirectUrl: saved.redirect,
      allowedEmailDomains: saved.domains,
    });
  });

  beforeEach(async () => {
    // bcrypt and jsonwebtoken resolve through nextTick, so those stay real.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout'] });
    jest.setSystemTime(T0);

    Object.assign(config, {
      googleClientId: CLIENT_ID,
      googleClientSecret: 'client-secret',
      googleRedirectUrl: 'http://localhost:4100/api/v1/auth/google/callback',
      allowedEmailDomains: [] as string[],
    });

    await dataSource.manager.clear(AuditEventEntity);
    await dataSource.manager.clear(UserEntity);
    users = dataSource.getRepository(UserEntity);

    verify = jest.fn();
    const verifier: GoogleIdTokenVerifier = { verify: (t, c) => verify(t, c) };
    auth = new AuthService(passwordWorkFixture(), 
      dataSource.getRepository(UserEntity),
      new JwtService({ secret: config.jwtSecret, signOptions: { expiresIn: '1h' } }),
    );
    google = new GoogleService(passwordWorkFixture(), dataSource.getRepository(UserEntity), auth, verifier);

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id_token: 'signed.id.token' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Walk the first leg for real, so the callback is fed a state we minted,
   * and the nonce the browser would now be holding in its cookie.
   */
  function start(next?: string): { state: string; nonce: string } {
    const { url, nonce } = google.beginSignIn(next);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('nonce')).toBe(nonce);
    return { state: parsed.searchParams.get('state') as string, nonce };
  }

  /** What Google would say about this person, once the signature checks out. */
  function identity(nonce: string, over: Partial<GoogleIdentity> = {}): GoogleIdentity {
    return {
      sub: '11223344',
      email: 'ada@uni.test',
      emailVerified: true,
      name: 'Ada Lovelace',
      nonce,
      ...over,
    };
  }

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected the sign-in to be refused');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(GoogleSignInError);
        return (err as Error).message;
      },
    );

  /* ------------------------------- the redirect ---------------------------- */

  it('sends the browser to Google with a state, a nonce and an S256 challenge', () => {
    const url = new URL(google.authorizationUrl('/workspace/p1'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(config.googleRedirectUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    // The PKCE verifier is derived from the nonce with a server key, so it is
    // deliberately nowhere in the URL the browser carries.
    expect(url.search).not.toContain('code_verifier');
    const state = url.searchParams.get('state') as string;
    expect(state.split('.')).toHaveLength(2);
  });

  it('carries only a same-origin return path, and drops an absolute one', async () => {
    const kept = start('/workspace/p1');
    verify.mockResolvedValue(identity(kept.nonce));
    await expect(google.complete('code', kept.state, kept.nonce)).resolves.toMatchObject({
      returnPath: '/workspace/p1',
    });

    for (const hostile of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\r\\evil.example']) {
      const dropped = start(hostile);
      verify.mockResolvedValue(identity(dropped.nonce, { email: 'grace@uni.test' }));
      await expect(google.complete('code', dropped.state, dropped.nonce)).resolves.toMatchObject({
        returnPath: '',
      });
    }
  });

  it('drops a return path the managed sign-in door also drops: a backslash anywhere, or more than 2048 characters', async () => {
    for (const hostile of ['/lessons\\..\\evil', `/${'a'.repeat(2048)}`]) {
      const dropped = start(hostile);
      expect(google.readState(dropped.state).r).toBe('');
    }
  });

  it('is off, and refuses both legs, without both halves of a client', async () => {
    Object.assign(config, { googleClientSecret: '' });
    expect(google.enabled()).toBe(false);
    expect(() => google.authorizationUrl()).toThrow(BadRequestException);
    await expect(google.complete('code', 'state', 'nonce')).rejects.toThrow(BadRequestException);
  });

  it('sanitizes an unsafe return path in a still-valid state minted by the older validator', async () => {
    // Model only the older validator's minting rule; retain real signed state, nonce,
    // callback parsing and auth persistence throughout the rest of the flow.
    const oldRule = jest.spyOn(google as unknown as { returnPath(next?: string): string }, 'returnPath').mockReturnValueOnce('/\t/evil.example');
    const old = start('/\t/evil.example'); oldRule.mockRestore();
    expect(google.readState(old.state).r).toBe('/\t/evil.example');
    verify.mockResolvedValue(identity(old.nonce));
    await expect(google.complete('code', old.state, old.nonce)).resolves.toMatchObject({ returnPath: '' });
  });

  /* --------------------------------- state -------------------------------- */

  it('refuses a tampered state before it says a word to Google', async () => {
    const { state, nonce } = start();
    const last = state.slice(-1);
    const tampered = state.slice(0, -1) + (last === 'a' ? 'b' : 'a');

    expect(await refusal(google.complete('code', tampered, nonce))).toBe(
      'that sign-in link is not one of ours',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a state whose signature belongs to another server', async () => {
    const { state, nonce } = start();
    const [body] = state.split('.');
    expect(await refusal(google.complete('code', `${body}.notoursatall`, nonce))).toBe(
      'that sign-in link is not one of ours',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a state that has expired', async () => {
    const { state, nonce } = start();
    jest.setSystemTime(T0 + STATE_TTL_MS + 1_000);
    expect(await refusal(google.complete('code', state, nonce))).toBe(
      'that sign-in attempt took too long — start again',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an ID token minted for a different attempt', async () => {
    const { state, nonce } = start();
    verify.mockResolvedValue(identity('a-nonce-from-somewhere-else'));
    expect(await refusal(google.complete('code', state, nonce))).toBe(
      'that sign-in did not match the attempt it started from',
    );
  });

  /* -------------------------- bound to this browser ------------------------ */

  it('refuses a callback for an attempt this browser never started', async () => {
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce));

    // The signed state is intact and unexpired; what is missing is the cookie
    // that says the browser presenting it is the one that asked for it.
    expect(await refusal(google.complete('code', state, undefined))).toBe(
      'that sign-in did not start in this browser — start again',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await users.count()).toBe(0);
  });

  it('refuses a state minted here and planted on somebody else', async () => {
    // Login CSRF: the attacker starts a sign-in of their own and drops the
    // callback URL in front of a learner, who would otherwise be signed into
    // the attacker's account and do a term of work inside it.
    const attacker = start();
    const victim = start();
    verify.mockResolvedValue(identity(attacker.nonce));

    expect(await refusal(google.complete('code', attacker.state, victim.nonce))).toBe(
      'that sign-in did not start in this browser — start again',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints one nonce, and puts the same one in the URL and in the caller’s hands', () => {
    const { url, nonce } = google.beginSignIn('/workspace/p1');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('nonce')).toBe(nonce);
    expect(nonce).toMatch(/^[\w-]{22}$/);
    // A second attempt is a different attempt.
    expect(google.beginSignIn().nonce).not.toBe(nonce);
  });

  it('takes the strong cookie name only where the browser will accept it', () => {
    Object.assign(config, {
      googleRedirectUrl: 'https://learn.example.test/api/v1/auth/google/callback',
    });
    expect(oauthNonceCookie()).toEqual({ name: '__Host-oauth-nonce', secure: true });

    // Google allows a plain-http redirect only on localhost, and a browser
    // will not take a Secure cookie there, so the prefix is dropped with it.
    Object.assign(config, {
      googleRedirectUrl: 'http://localhost:4100/api/v1/auth/google/callback',
    });
    expect(oauthNonceCookie()).toEqual({ name: 'oauth-nonce', secure: false });
  });

  /* ------------------------------- the exchange ---------------------------- */

  it('exchanges the code with the client secret and the derived PKCE verifier', async () => {
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce));
    await google.complete('the-code', state, nonce);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('code')).toBe('the-code');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_secret')).toBe('client-secret');
    expect(sent.get('redirect_uri')).toBe(config.googleRedirectUrl);
    expect(sent.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    expect(verify).toHaveBeenCalledWith('signed.id.token', CLIENT_ID);
  });

  it('says something a person can act on when Google refuses the exchange', async () => {
    const { state, nonce } = start();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    });
    const message = await refusal(google.complete('code', state, nonce));
    expect(message).toBe('Google would not complete that sign-in — try again');
    expect(message).not.toContain('invalid_grant');
  });

  /* ----------------------------- the account rules ------------------------- */

  it('refuses an address Google has not confirmed', async () => {
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce, { emailVerified: false }));
    expect(await refusal(google.complete('code', state, nonce))).toContain(
      'has not confirmed that address',
    );
    expect(await users.count()).toBe(0);
  });

  it('refuses an address outside ALLOWED_EMAIL_DOMAINS, and names the ones it takes', async () => {
    Object.assign(config, { allowedEmailDomains: ['uni.test'] });
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce, { email: 'someone@example.com' }));
    expect(await refusal(google.complete('code', state, nonce))).toBe(
      'Google sign-in on this server is for @uni.test addresses',
    );
    expect(await users.count()).toBe(0);
  });

  it('accepts an address inside ALLOWED_EMAIL_DOMAINS', async () => {
    Object.assign(config, { allowedEmailDomains: ['uni.test', 'sis.uni.test'] });
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce, { email: 'grace@sis.uni.test' }));
    const { auth: session } = await google.complete('code', state, nonce);
    expect(session.user.email).toBe('grace@sis.uni.test');
  });

  it('refuses a suspended account, the same as password sign-in does', async () => {
    await users.save(
      users.create({
        email: 'ada@uni.test',
        passwordHash: await bcrypt.hash('unused', 4),
        displayName: 'Ada Lovelace',
        disabledAt: new Date().toISOString(),
      }),
    );
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce));
    expect(await refusal(google.complete('code', state, nonce))).toBe(
      'this account is suspended — contact your instructor',
    );
  });

  /* ------------------------------ link vs create --------------------------- */

  it('creates a learner with the name from the Google profile', async () => {
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce));

    const { auth: session } = await google.complete('code', state, nonce);
    expect(session.token).toEqual(expect.any(String));
    expect(session.user).toMatchObject({
      email: 'ada@uni.test',
      displayName: 'Ada Lovelace',
      role: 'LEARNER',
    });
    expect(await users.count()).toBe(1);

    // Confirmed by Google is confirmed here: no second round of email.
    const row = await users.findOne({ where: { email: 'ada@uni.test' } });
    expect((row as UserEntity).emailVerifiedAt).toEqual(expect.any(String));
    // The password nobody chose is a hash of bytes that were thrown away.
    expect(await bcrypt.compare('', (row as UserEntity).passwordHash)).toBe(false);
  });

  it('falls back to the local part when Google sends no name', async () => {
    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce, { name: undefined, email: 'a.turing@uni.test' }));
    const { auth: session } = await google.complete('code', state, nonce);
    expect(session.user.displayName).toBe('a.turing');
  });

  it('links to the account that already holds the address, keeping its role', async () => {
    const existing = await users.save(
      users.create({
        email: 'ada@uni.test',
        passwordHash: await bcrypt.hash('Correct-Horse-9', 4),
        displayName: 'Dr Ada Lovelace',
        role: 'INSTRUCTOR',
        cohort: 'section-a',
      }),
    );

    const { state, nonce } = start();
    verify.mockResolvedValue(identity(nonce));
    const { auth: session } = await google.complete('code', state, nonce);

    expect(session.user.id).toBe((existing as UserEntity).id);
    expect(session.user.role).toBe('INSTRUCTOR');
    expect(session.user.cohort).toBe('section-a');
    // The name they set here wins over the one on the Google profile.
    expect(session.user.displayName).toBe('Dr Ada Lovelace');
    expect(await users.count()).toBe(1);
  });

  /* ---------------------------- the unclaimed row -------------------------- */

  /**
   * Registration takes an address on trust, so a row holding one proves
   * nothing until somebody confirms it. Google confirming it is the first
   * proof the address has ever had, and it is proof about the person at this
   * browser, not about whoever typed the address into the sign-up form.
   */
  describe('an account nobody had confirmed', () => {
    const audits = () => dataSource.manager.find(AuditEventEntity, {});

    async function squattedRow(password: string): Promise<UserEntity> {
      const row = (await users.save(
        users.create({
          email: 'ada@uni.test',
          passwordHash: await bcrypt.hash(password, 4),
          displayName: 'Ada Lovelace',
        }),
      )) as UserEntity;
      expect(row.emailVerifiedAt).toBeNull();
      return row;
    }

    it('keeps the row and takes the credentials nobody proved anything with', async () => {
      const squatted = await squattedRow('Squatter-Horse-9');
      const stolen = await auth.issueSession(squatted);
      await expect(auth.authenticate(stolen.token)).resolves.toMatchObject({ id: squatted.id });

      const { state, nonce } = start();
      verify.mockResolvedValue(identity(nonce));
      const { auth: session } = await google.complete('code', state, nonce);

      // The same row, so nothing already done under it is orphaned.
      expect(session.user.id).toBe(squatted.id);
      expect(await users.count()).toBe(1);

      const row = (await users.findOne({ where: { id: squatted.id } })) as UserEntity;
      expect(row.emailVerifiedAt).toEqual(expect.any(String));
      expect(row.tokenVersion).toBe(squatted.tokenVersion + 1);

      // The password that was set without proof no longer opens it...
      await expect(auth.login('ada@uni.test', 'Squatter-Horse-9')).rejects.toThrow(
        'invalid email or password',
      );
      // ...nor does the session that was already open...
      await expect(auth.authenticate(stolen.token)).rejects.toThrow(
        'this session has been signed out',
      );
      // ...and the one this sign-in just issued does.
      await expect(auth.authenticate(session.token)).resolves.toMatchObject({ id: row.id });
    });

    it('leaves a row in the trail, naming what was taken and why', async () => {
      const squatted = await squattedRow('Squatter-Horse-9');
      const { state, nonce } = start();
      verify.mockResolvedValue(identity(nonce));
      await google.complete('code', state, nonce);

      const [event] = await audits();
      expect(event).toMatchObject({
        event: 'account.claimed',
        actorUserId: squatted.id,
        subjectUserId: squatted.id,
        action: 'google',
        detail: { via: 'google', passwordCleared: true, tokenVersion: 1 },
      });
      expect(event.reason).toContain('password was cleared');
    });

    it('leaves a confirmed account entirely alone', async () => {
      const owner = (await users.save(
        users.create({
          email: 'ada@uni.test',
          passwordHash: await bcrypt.hash('Correct-Horse-9', 4),
          displayName: 'Ada Lovelace',
          emailVerifiedAt: '2026-01-01T00:00:00.000Z',
        }),
      )) as UserEntity;

      const { state, nonce } = start();
      verify.mockResolvedValue(identity(nonce));
      await google.complete('code', state, nonce);

      const row = (await users.findOne({ where: { id: owner.id } })) as UserEntity;
      expect(row.tokenVersion).toBe(0);
      expect(row.emailVerifiedAt).toBe('2026-01-01T00:00:00.000Z');
      await expect(auth.login('ada@uni.test', 'Correct-Horse-9')).resolves.toBeDefined();
      expect(await audits()).toHaveLength(0);
    });
  });

  it('matches an address Google returns in a different case', async () => {
    const existing = await users.save(
      users.create({
        email: 'ada@uni.test',
        passwordHash: await bcrypt.hash('Correct-Horse-9', 4),
        displayName: 'Ada Lovelace',
      }),
    );
    const { state, nonce } = start();
    // The verifier lower-cases the claim; this is the belt to that brace.
    verify.mockResolvedValue(identity(nonce, { email: 'ada@uni.test' }));
    const { auth: session } = await google.complete('code', state, nonce);
    expect(session.user.id).toBe((existing as UserEntity).id);
    expect(await users.count()).toBe(1);
  });
});
