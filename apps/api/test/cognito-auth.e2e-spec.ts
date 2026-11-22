import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { generateKeyPairSync, sign } from 'crypto';
import request from 'supertest';
import { DataSource, Not, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MANAGED_SESSION_LIFE_SECONDS } from '../src/auth/auth.service';
import { CognitoService } from '../src/auth/cognito.service';
import { config } from '../src/config';
import { SettingEntity, UserEntity } from '../src/db/entities';
import { repoToken } from '../src/db/inject';
import { MailService } from '../src/mail/mail.service';
import { NULL_PIN_RECEIPT_KEY } from '../src/seed/null-pin';

/** Actual HTTP guards/DTOs/services/SQLite/app JWTs; only Cognito's network is simulated. */
describe('managed auth HTTP integration (offline Cognito)', () => {
  const POOL = 'ap-southeast-1_Offline123';
  const CLIENT = 'offline-public-client';
  const ISSUER = `https://cognito-idp.ap-southeast-1.amazonaws.com/${POOL}`;
  const EMAIL = 'managed-http@example.test';
  const PASSWORD = 'Original-offline-pass!234';
  const REPLACEMENT = 'Replacement-offline-pass!567';
  const SUB = 'offline-native-subject';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kty: 'RSA', kid: 'offline-http-key', use: 'sig', alg: 'RS256' };
  const saved = {
    authProvider: config.authProvider, cognitoUserPoolId: config.cognitoUserPoolId,
    cognitoClientId: config.cognitoClientId, cognitoDomain: config.cognitoDomain,
    cognitoRedirectUrl: config.cognitoRedirectUrl, cognitoProviders: config.cognitoProviders,
    cognitoMigrationSecret: config.cognitoMigrationSecret, seedDemoAccounts: config.seedDemoAccounts,
    allowedEmailDomains: config.allowedEmailDomains, adminEmail: config.adminEmail,
  };
  let app: INestApplication;
  let http: Parameters<typeof request>[0];
  let db: DataSource;
  let sdk: jest.Mock;
  let transport: jest.SpyInstance;
  let localMail: jest.SpyInstance;

  const idToken = (extra: Record<string, unknown> = {}) => {
    const body = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ iss: ISSUER, aud: CLIENT, token_use: 'id', sub: SUB,
        email: EMAIL, email_verified: true, name: 'Managed learner',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        ...extra })).toString('base64url');
    return body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url');
  };
  const providerError = (name: string) => Object.assign(new Error('private-provider-canary'), { name });
  const acceptedIdentity = (extra: Record<string, unknown> = {}) => ({
    AuthenticationResult: { IdToken: idToken(extra), AccessToken: 'offline-access-token' },
  });
  const post = (path: string, body: unknown) => request(http).post('/api/v1/auth/' + path).send(body as object);
  const login = () => post('login', { email: EMAIL, password: PASSWORD });
  const me = (token: string) => request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const begin = async (next = '/dashboard') => {
    const response = await request(http).get('/api/v1/auth/sso/start').query({ provider: 'Google', next }).expect(302);
    const url = new URL(response.headers.location);
    return { state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')!,
      cookie: `__Host-cognito-nonce=${url.searchParams.get('nonce')}`, url };
  };
  const callback = (flow: Awaited<ReturnType<typeof begin>>, cookie = flow.cookie) =>
    request(http).get('/api/v1/auth/sso/callback').query({ code: 'offline-code', state: flow.state }).set('Cookie', cookie);
  const expectNoToken = (response: { body: unknown; headers: Record<string, unknown> }) => {
    expect(JSON.stringify(response.body)).not.toMatch(/private-provider-canary|offline-access-token|"token"/);
    expect(String(response.headers.location ?? '')).not.toContain('#token=');
  };

  beforeEach(async () => {
    Object.assign(config, { authProvider: 'cognito', cognitoUserPoolId: POOL, cognitoClientId: CLIENT,
      cognitoDomain: 'https://offline.auth.ap-southeast-1.amazoncognito.com',
      cognitoRedirectUrl: 'https://learnsdlc.test/api/v1/auth/sso/callback', cognitoProviders: ['Google'],
      cognitoMigrationSecret: 'cd'.repeat(32), seedDemoAccounts: false, allowedEmailDomains: [], adminEmail: '' });
    sdk = jest.fn().mockRejectedValue(new Error('Unconfigured offline provider command'));
    transport = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Offline suite forbids network'));
    const verifier = CognitoJwtVerifier.create({ userPoolId: POOL, clientId: CLIENT, tokenUse: 'id' });
    verifier.cacheJwks({ keys: [jwk] });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CognitoService).useFactory({
        inject: [repoToken(SettingEntity)],
        factory: (states: Repository<SettingEntity>) => new CognitoService(states,
          { send: sdk } as unknown as CognitoIdentityProviderClient, verifier),
      }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
    await app.listen(0, '127.0.0.1');
    http = app.getHttpServer(); db = app.get(DataSource);
    localMail = jest.spyOn(app.get(MailService), 'send');
  });
  afterEach(async () => {
    expect(localMail).not.toHaveBeenCalled();
    await app?.close();
    jest.restoreAllMocks(); Object.assign(config, saved);
  });

  it('valid confirmation enables later verified native login without signup/confirmation issuing a session', async () => {
    let confirmed = false;
    sdk.mockImplementation(async command => {
      switch (command.constructor.name) {
        case 'SignUpCommand': return { UserConfirmed: false };
        case 'ConfirmSignUpCommand':
          if (command.input.ConfirmationCode !== '123456') throw providerError('CodeMismatchException');
          expect(command.input.ForceAliasCreation).toBe(false); confirmed = true; return {};
        case 'InitiateAuthCommand':
          if (!confirmed) throw providerError('UserNotConfirmedException');
          return acceptedIdentity();
        default: throw new Error('Unexpected command');
      }
    });
    const registered = await post('register', { email: EMAIL, password: PASSWORD, displayName: 'Managed learner', role: 'ADMIN' }).expect(201);
    expect(registered.body).toEqual({ confirmationRequired: true, email: EMAIL }); expectNoToken(registered);
    expect(await db.getRepository(UserEntity).count()).toBe(0);
    const unconfirmed = await login().expect(401);
    expect(unconfirmed.body).toMatchObject({ code: 'CONFIRMATION_REQUIRED', email: EMAIL }); expectNoToken(unconfirmed);
    const invalid = await post('confirm', { email: EMAIL, code: 'bad' }).expect(400); expectNoToken(invalid);
    const confirmation = await post('confirm', { email: EMAIL.toUpperCase(), code: '123456' }).expect(200);
    expect(confirmation.body).toEqual({ confirmed: true, email: EMAIL }); expectNoToken(confirmation);
    expect(await db.getRepository(UserEntity).count()).toBe(0);
    const signed = await login().expect(200);
    expect(signed.body.user.role).toBe('LEARNER');
    const claims = app.get(JwtService).verify(signed.body.token);
    expect(claims).toMatchObject({ provider: 'cognito', cognitoSub: SUB, ver: 0 });
    expect(claims.exp - claims.iat).toBe(MANAGED_SESSION_LIFE_SECONDS);
    await me(signed.body.token).expect(200);
    const row = await db.getRepository(UserEntity).findOneByOrFail({ id: signed.body.user.id });
    expect(row.passwordHash).toBe(''); expect(row.emailVerifiedAt).not.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['CodeMismatchException', 'ExpiredCodeException', 'ServiceUnavailableException'])('confirmation %s cannot create an app identity or leak provider text', async name => {
    sdk.mockRejectedValue(providerError(name));
    const response = await post('confirm', { email: EMAIL, code: '123456' }).expect(name === 'ServiceUnavailableException' ? 503 : 400);
    expectNoToken(response); expect(await db.getRepository(UserEntity).count()).toBe(0);
    expect(sdk).toHaveBeenCalledTimes(1); expect(transport).not.toHaveBeenCalled();
  });

  it('unknown and known resend/forgot requests use the same safe response, while a provider outage is not reported as delivery', async () => {
    sdk.mockResolvedValue({});
    const knownResend = await post('confirm/resend', { email: EMAIL }).expect(200);
    const knownForgot = await post('forgot', { email: EMAIL }).expect(200);
    sdk.mockRejectedValue(providerError('UserNotFoundException'));
    expect((await post('confirm/resend', { email: 'unknown@example.test' }).expect(200)).body).toEqual(knownResend.body);
    expect((await post('forgot', { email: 'unknown@example.test' }).expect(200)).body).toEqual(knownForgot.body);
    expect(knownForgot.body.delivery).toBe('code');
    sdk.mockRejectedValue(providerError('ServiceUnavailableException'));
    for (const path of ['confirm/resend', 'forgot']) expectNoToken(await post(path, { email: EMAIL }).expect(503));
    expect(await db.getRepository(UserEntity).count()).toBe(0);
  });

  it('reset success revokes cached app sessions, preserves profile/role, and rejects a reused provider code', async () => {
    let changed = false;
    sdk.mockImplementation(async command => {
      if (command.constructor.name === 'ConfirmForgotPasswordCommand') {
        if (changed) throw providerError('ExpiredCodeException');
        changed = true; return {};
      }
      if (command.constructor.name === 'InitiateAuthCommand') {
        if (changed && command.input.AuthParameters.PASSWORD !== REPLACEMENT) throw providerError('NotAuthorizedException');
        return acceptedIdentity();
      }
      throw new Error('Unexpected command');
    });
    const initial = await login().expect(200); await me(initial.body.token).expect(200);
    const row = await db.getRepository(UserEntity).findOneByOrFail({ id: initial.body.user.id });
    await post('reset', { token: 'legacy-token', password: REPLACEMENT }).expect(400);
    const before = sdk.mock.calls.length;
    await post('reset', { email: EMAIL, code: '123456', password: 'short' }).expect(400);
    expect(sdk).toHaveBeenCalledTimes(before);
    expect((await post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).expect(200)).body).toEqual({ changed: true });
    await me(initial.body.token).expect(401); await login().expect(401);
    const after = await db.getRepository(UserEntity).findOneByOrFail({ id: row.id });
    expect(after).toMatchObject({ passwordHash: row.passwordHash, role: row.role, displayName: row.displayName, cognitoSub: row.cognitoSub, tokenVersion: row.tokenVersion + 1 });
    await post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).expect(400);
    const current = await post('login', { email: EMAIL, password: REPLACEMENT }).expect(200);
    await me(current.body.token).expect(200);
  });

  it.each(['CodeMismatchException', 'ExpiredCodeException', 'ServiceUnavailableException'])('reset %s preserves the current local identity and session', async name => {
    sdk.mockResolvedValue(acceptedIdentity()); const initial = await login().expect(200);
    await me(initial.body.token).expect(200);
    const before = await db.getRepository(UserEntity).findOneByOrFail({ id: initial.body.user.id });
    sdk.mockRejectedValue(providerError(name));
    const response = await post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).expect(name === 'ServiceUnavailableException' ? 503 : 400);
    expectNoToken(response); await me(initial.body.token).expect(200);
    expect(sdk.mock.calls.at(-1)![0].input).toMatchObject({ ClientId: CLIENT, Username: SUB });
    expect(await db.getRepository(UserEntity).findOneByOrFail({ id: before.id })).toEqual(before);
  });

  it('pins a linked reset to its subject and revokes sessions even when a subsequent password login would be unavailable', async () => {
    sdk.mockResolvedValue(acceptedIdentity());
    const initial = await login().expect(200); await me(initial.body.token).expect(200);
    sdk.mockClear();
    sdk.mockImplementation(async command => {
      if (command.constructor.name === 'ConfirmForgotPasswordCommand') return {};
      throw providerError('ServiceUnavailableException');
    });
    const response = await post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).expect(200);
    expect(response.body).toEqual({ changed: true });
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(sdk.mock.calls[0][0].input).toMatchObject({ ClientId: CLIENT, Username: SUB });
    await me(initial.body.token).expect(401);
    const row = await db.getRepository(UserEntity).findOneByOrFail({ id: initial.body.user.id });
    expect(row.tokenVersion).toBe(1); expect(row.passwordHash).toBe('');
  });

  it('does not revoke a concurrently rebound identity when the original subject reset finishes', async () => {
    sdk.mockResolvedValue(acceptedIdentity());
    const initial = await login().expect(200); await me(initial.body.token).expect(200);
    let enter!: () => void; let finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    sdk.mockImplementation(async command => {
      if (command.constructor.name === 'ConfirmForgotPasswordCommand') {
        enter(); await pending; return {};
      }
      return acceptedIdentity();
    });
    const response = post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).then(value => value);
    await entered;
    const users = db.getRepository(UserEntity);
    await users.update({ id: initial.body.user.id }, { cognitoSub: 'new-binding', tokenVersion: 7, displayName: 'Concurrent profile' });
    const before = await users.findOneByOrFail({ id: initial.body.user.id });
    finish();
    const changed = await response;
    expect(changed.status).toBe(503); expect(changed.body.code).toBe('PASSWORD_CHANGED_SIGN_IN_REQUIRED');
    expect(changed.body.message).toContain('password was changed');
    expect(await users.findOneByOrFail({ id: before.id })).toEqual(before);
    await me(initial.body.token).expect(401);
    const current = app.get(JwtService).sign({ sub: before.id, ver: 7, provider: 'cognito', cognitoSub: 'new-binding' });
    await me(current).expect(200);
  });

  it('reports password changed explicitly when confirmation succeeds but an unlinked identity cannot be verified', async () => {
    const users = db.getRepository(UserEntity);
    const legacy = await users.save({ email: EMAIL, passwordHash: 'unchanged-legacy', displayName: 'Unlinked legacy' });
    sdk.mockImplementation(async command => {
      if (command.constructor.name === 'ConfirmForgotPasswordCommand') return {};
      throw providerError('ServiceUnavailableException');
    });
    const response = await post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).expect(503);
    expect(response.body.code).toBe('PASSWORD_CHANGED_SIGN_IN_REQUIRED');
    expect(response.body.message).toContain('password was changed'); expectNoToken(response);
    expect(await users.findOneByOrFail({ id: legacy.id })).toEqual(legacy);
  });

  it('enforces the subject condition even when the binding changes between its read and revocation write', async () => {
    sdk.mockResolvedValue(acceptedIdentity()); const initial = await login().expect(200);
    await me(initial.body.token).expect(200); sdk.mockResolvedValue({});
    const users = db.getRepository(UserEntity);
    const update = users.update.bind(users);
    const observed = jest.spyOn(users, 'update').mockImplementationOnce(async (criteria, partial) => {
      await update({ id: initial.body.user.id }, { cognitoSub: 'replacement-subject', tokenVersion: 9 });
      return update(criteria, partial);
    });
    const response = await post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).expect(503);
    expect(response.body.code).toBe('PASSWORD_CHANGED_SIGN_IN_REQUIRED');
    expect(observed.mock.calls[0][0]).toMatchObject({ id: initial.body.user.id, cognitoSub: SUB });
    const after = await users.findOneByOrFail({ id: initial.body.user.id });
    expect(after.cognitoSub).toBe('replacement-subject'); expect(after.tokenVersion).toBe(9);
    await me(initial.body.token).expect(401);
    const current = app.get(JwtService).sign({ sub: after.id, ver: 9, provider: 'cognito', cognitoSub: after.cognitoSub });
    await me(current).expect(200);
  });

  it('reports partial success rather than an unchanged password if local revocation storage fails', async () => {
    sdk.mockResolvedValue(acceptedIdentity()); const initial = await login().expect(200);
    sdk.mockResolvedValue({});
    const users = db.getRepository(UserEntity);
    const before = await users.findOneByOrFail({ id: initial.body.user.id });
    jest.spyOn(users, 'update').mockRejectedValue(new Error('private-database-canary'));
    const response = await post('reset', { email: EMAIL, code: '123456', password: REPLACEMENT }).expect(503);
    expect(response.body.code).toBe('PASSWORD_CHANGED_SIGN_IN_REQUIRED');
    expect(response.body.message).toContain('password was changed'); expectNoToken(response);
    expect(JSON.stringify(response.body)).not.toContain('private-database-canary');
    expect(await users.findOneByOrFail({ id: before.id })).toEqual(before);
  });

  it('SSO verifies the signed identity, PKCE and browser nonce, then consumes the callback exactly once', async () => {
    const flow = await begin('/learn');
    transport.mockResolvedValue(new Response(JSON.stringify({ id_token: idToken({ nonce: flow.nonce }) }), { status: 200 }));
    const wrongBrowser = await callback(flow, '__Host-cognito-nonce=wrong-browser').expect(302);
    expectNoToken(wrongBrowser); expect(transport).not.toHaveBeenCalled();
    const success = await callback(flow).expect(302);
    const destination = new URL(success.headers.location);
    expect(destination.pathname).toBe('/login/callback'); expect(destination.searchParams.get('next')).toBe('/learn');
    const token = new URLSearchParams(destination.hash.slice(1)).get('token')!;
    expect(token).toBeTruthy(); await me(token).expect(200);
    const form = new URLSearchParams(transport.mock.calls[0][1].body);
    expect(form.get('code_verifier')).toHaveLength(43); expect(form.has('client_secret')).toBe(false);
    const duplicate = await callback(flow).expect(302); expectNoToken(duplicate);
    expect(transport).toHaveBeenCalledTimes(1); expect(await db.getRepository(UserEntity).count()).toBe(1);
    expect(sdk).not.toHaveBeenCalled();
  });

  it('diagnoses an expired signed callback without a cookie before any exchange, then completes a fresh flow',async()=>{
    const now=Date.now();const clock=jest.spyOn(Date,'now').mockReturnValue(now);
    const expired=await begin('/learn');clock.mockReturnValue(now+10*60_000);
    const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>{});
    const response=await request(http).get('/api/v1/auth/sso/callback')
      .query({code:'expired-private-code',state:expired.state}).expect(302);
    const destination=new URL(response.headers.location);
    expect(destination.pathname).toBe('/login');expect(destination.searchParams.get('error')).toBe('sso_expired');
    const reference=destination.searchParams.get('reference');
    expect(reference).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(reference).toBe(response.headers['x-request-id']);expectNoToken(response);
    expect(warn).toHaveBeenCalledWith(`Cognito sign-in failure stage=state code=COGNITO_FLOW_EXPIRED rid=${reference}`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(expired.state);
    // the boot writes the null-pin receipt on every boot; no other row, and no Cognito flow state, is stored
    expect(await db.getRepository(SettingEntity).count({where:{key:Not(NULL_PIN_RECEIPT_KEY)}})).toBe(0);expect(await db.getRepository(UserEntity).count()).toBe(0);
    expect(transport).not.toHaveBeenCalled();expect(sdk).not.toHaveBeenCalled();
    const fresh=await begin('/learn');
    transport.mockResolvedValue(new Response(JSON.stringify({id_token:idToken({nonce:fresh.nonce})}),{status:200}));
    const success=await callback(fresh).expect(302);
    const next=new URL(success.headers.location);expect(next.pathname).toBe('/login/callback');expect(next.searchParams.get('next')).toBe('/learn');
    const token=new URLSearchParams(next.hash.slice(1)).get('token')!;await me(token).expect(200);
    expect(transport).toHaveBeenCalledTimes(1);expect(await db.getRepository(UserEntity).count()).toBe(1);
  });

  it('keeps raw provider error payloads out of callback diagnostics and failure redirects',async()=>{
    const flow=await begin();const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>{});
    transport.mockResolvedValue(new Response(JSON.stringify({error:'private-provider-canary',error_description:'token=private-token-canary email=private-email-canary state='+flow.state}),{status:400}));
    const response=await callback(flow).expect(302);const url=new URL(response.headers.location);
    expect(url.searchParams.get('error')).toBe('sso_failed');expectNoToken(response);
    expect(warn).toHaveBeenCalledWith(`Cognito sign-in failure stage=exchange code=COGNITO_EXCHANGE_FAILED rid=${url.searchParams.get('reference')}`);
    expect(JSON.stringify(warn.mock.calls)+JSON.stringify(response.headers)).not.toMatch(/private-provider-canary|private-token-canary|private-email-canary/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(flow.state);
    expect(await db.getRepository(UserEntity).count()).toBe(0);expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['audience', 'issuer', 'nonce', 'unverified', 'malformed', 'provider-outage', 'network-timeout', 'forged-signature'])('SSO %s failure clears the failed flow and creates no session', async kind => {
    const flow = await begin('//outside.example/path');
    const changes: Record<string, unknown> = { nonce: flow.nonce };
    if (kind === 'audience') changes.aud = 'wrong-client';
    if (kind === 'issuer') changes.iss = ISSUER + 'wrong';
    if (kind === 'nonce') changes.nonce = 'wrong-nonce';
    if (kind === 'unverified') changes.email_verified = false;
    const token = idToken(changes);
    if (kind === 'network-timeout') transport.mockRejectedValue(Object.assign(new Error('private-provider-canary'), { name: 'AbortError' }));
    else transport.mockResolvedValue(new Response(kind === 'malformed' ? 'not-json' : JSON.stringify({ id_token: kind === 'forged-signature' ? token.slice(0, -16) + 'AAAAAAAAAAAAAAAA' : token }), { status: kind === 'provider-outage' ? 503 : 200 }));
    const failure = await callback(flow).expect(302);
    expect(new URL(failure.headers.location).pathname).toBe('/login'); expectNoToken(failure);
    expect(JSON.stringify(failure.headers['set-cookie'])).toContain('__Host-cognito-nonce=;');
    expect(await db.getRepository(UserEntity).count()).toBe(0);
    const again = await callback(flow).expect(302); expectNoToken(again);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('verified external email collision preserves the original account and rejects local sessions in managed mode', async () => {
    const users = db.getRepository(UserEntity);
    const original = await users.save({ email: EMAIL, passwordHash: 'untouched-legacy-hash', displayName: 'Existing instructor', role: 'INSTRUCTOR' as const });
    const flow = await begin();
    transport.mockResolvedValue(new Response(JSON.stringify({ id_token: idToken({ nonce: flow.nonce }) }), { status: 200 }));
    const collision = await callback(flow).expect(302);
    expect(new URL(collision.headers.location).searchParams.get('error')).toBe('identity_link_required'); expectNoToken(collision);
    expect(await users.findOneByOrFail({ id: original.id })).toEqual(original);
    const local = app.get(JwtService).sign({ sub: original.id, ver: original.tokenVersion, provider: 'local' });
    await me(local).expect(401);
    sdk.mockRejectedValue(providerError('NotAuthorizedException'));
    await post('login', { email: EMAIL, password: 'untouched-legacy-hash' }).expect(401);
    expect(await users.findOneByOrFail({ id: original.id })).toEqual(original);
    await request(http).get('/api/v1/auth/google/callback?code=direct-google&state=old').expect(400);
  });
});
