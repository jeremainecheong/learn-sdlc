import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { generateKeyPairSync, sign } from 'crypto';
import { Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { CognitoService } from '../src/auth/cognito.service';
import { config } from '../src/config';
import { SettingEntity } from '../src/db/entities';
import { repoToken } from '../src/db/inject';
import { MailService } from '../src/mail/mail.service';

/**
 * Through the real `AppModule` in both
 * `AUTH_PROVIDER` modes: `GET /api/v1/auth/sso/signout` is mounted, public and
 * rate-limited, and it is the last hop of a sign-out the web has already done
 * on the server. The sequence below is the one `useSignOut` runs: sign in, the
 * app session revoked by `POST /auth/logout`, the old token refused, and only
 * then the browser sent here with no bearer. Managed mode ends at Cognito's
 * hosted `/logout` with the one registered `logout_uri` (`<site>/login`,
 * infra/preview/terraform/cognito.tf `logout_urls`); local mode ends at
 * `<site>/login`. No token, state or identity appears in any URL, and a query
 * string cannot steer the destination.
 *
 * Offline: Cognito's network is simulated exactly as `cognito-auth.e2e-spec.ts`
 * does it (an SDK stub and a locally signed ID token), `fetch` refuses every
 * call, and no mail leaves.
 */
const SITE = 'https://learnsdlc.test';
const LIMITED = 'rate limit exceeded — slow down';
/** A 302 from this process takes milliseconds; a hop that hangs fails here, naming itself, not at jest's 60 s. */
const HOP_TIMEOUT = { response: 10_000, deadline: 20_000 };

async function boot(configure?: (builder: ReturnType<typeof Test.createTestingModule>) => ReturnType<typeof Test.createTestingModule>) {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  const module = await (configure ? configure(builder) : builder).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Its own loopback listener, never supertest's wildcard one (see expectOwnLoopbackListener).
  await app.listen(0, '127.0.0.1');
  return app;
}

/** One sign-out hop; counts every call, since the limit counts every call from this address. */
function signOutClient(http: Parameters<typeof request>[0]) {
  let calls = 0;
  const hop = (query?: Record<string, string>, bearer?: string) => {
    calls += 1;
    const pending = request(http).get('/api/v1/auth/sso/signout').query(query ?? {}).timeout(HOP_TIMEOUT);
    return bearer ? pending.set('Authorization', `Bearer ${bearer}`) : pending;
  };
  return { hop, calls: () => calls };
}

/**
 * Every hop must reach this app and nothing else. Handed a server that is not
 * listening, supertest starts it on the wildcard address and then dials
 * 127.0.0.1:<port>; on macOS that port can be one another local process
 * already holds on 127.0.0.1, and the hop then reaches that process instead (a
 * foreign 404, or no answer at all). This file makes about 410 hops, so
 * `boot()` listens on 127.0.0.1 itself, as `cognito-auth.e2e-spec.ts` does,
 * and the kernel never hands it a loopback port another socket holds.
 */
function expectOwnLoopbackListener(app: INestApplication) {
  const address = (app.getHttpServer() as Server).address() as AddressInfo | null;
  expect(address).toEqual(expect.objectContaining({ address: '127.0.0.1', family: 'IPv4' }));
  expect(address?.port).toBeGreaterThan(0);
}

function expectNoTokenAnywhere(response: request.Response, ...secrets: string[]) {
  const location = String(response.headers.location ?? '');
  expect(location).not.toMatch(/token|#/);
  for (const secret of secrets) expect(JSON.stringify(response.headers) + response.text).not.toContain(secret);
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
}

async function exhaust(client: ReturnType<typeof signOutClient>, expected: string) {
  // The route's own allowance per address per minute; every earlier hop in this
  // describe block counted against it, so spend exactly the remainder.
  while (client.calls() < config.signInMaxPerAddress) {
    const response = await client.hop();
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(expected);
  }
  const refused = await client.hop().expect(429);
  expect(refused.body.message).toBe(LIMITED);
  expect(refused.headers.location).toBeUndefined();
}

describe('sso/signout, local mode (real AppModule)', () => {
  const savedSite = process.env.SITE_URL;
  let app: INestApplication;
  let http: Parameters<typeof request>[0];
  let client: ReturnType<typeof signOutClient>;
  let mail: jest.SpyInstance;
  let network: jest.SpyInstance;

  beforeAll(async () => {
    expect(config.authProvider).toBe('local');
    process.env.SITE_URL = SITE;
    network = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Offline suite forbids network'));
    app = await boot();
    http = app.getHttpServer();
    client = signOutClient(http);
    mail = jest.spyOn(app.get(MailService), 'send');
  });
  afterAll(async () => {
    await app?.close();
    if (savedSite === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = savedSite;
    jest.restoreAllMocks();
  });

  it('serves every hop from its own loopback listener, never a port another process holds', () => {
    expectOwnLoopbackListener(app);
  });

  it('advertises the local provider the web gates its sign-out on', async () => {
    const providers = await request(http).get('/api/v1/auth/providers').expect(200);
    expect(providers.body.authProvider).toBe('local');
  });

  it('after the server revoke, lands on /login with no bearer, no token in any URL, no cookie', async () => {
    const email = 'f3-local@uni.test';
    await request(http).post('/api/v1/auth/register')
      .send({ email, password: 'Password1!', displayName: 'Local learner' }).expect(201);
    const token = (await request(http).post('/api/v1/auth/login').send({ email, password: 'Password1!' }).expect(200)).body.token as string;
    await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    await request(http).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`).expect(200);
    await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);

    const response = await client.hop().expect(302);
    expect(response.headers.location).toBe(`${SITE}/login`);
    expectNoTokenAnywhere(response, token);
    // Public: the revoked token riding along changes nothing and is never read.
    const withStale = await client.hop(undefined, token).expect(302);
    expect(withStale.headers.location).toBe(`${SITE}/login`);
    expectNoTokenAnywhere(withStale, token);
  });

  it('reads no query parameter, so it is not an open redirect', async () => {
    const response = await client.hop({ logout_uri: 'https://outside.example/login', next: '//outside.example',
      redirect_uri: 'https://outside.example/', token: 'private-token-canary' }).expect(302);
    expect(response.headers.location).toBe(`${SITE}/login`);
    expectNoTokenAnywhere(response, 'outside.example', 'private-token-canary');
  });

  it('is rate-limited per address: one call over the allowance inside a minute is refused', async () => {
    await exhaust(client, `${SITE}/login`);
    expect(network).not.toHaveBeenCalled();
    expect(mail).not.toHaveBeenCalled();
  });
});

describe('sso/signout, managed mode (real AppModule, offline Cognito)', () => {
  const POOL = 'ap-southeast-1_Offline123';
  const CLIENT = 'offline-public-client';
  const DOMAIN = 'https://offline.auth.ap-southeast-1.amazoncognito.com';
  const ISSUER = `https://cognito-idp.ap-southeast-1.amazonaws.com/${POOL}`;
  const EMAIL = 'f3-managed@example.test';
  const HOSTED_LOGOUT = `${DOMAIN}/logout?client_id=${CLIENT}&logout_uri=${encodeURIComponent(`${SITE}/login`)}`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kty: 'RSA', kid: 'f3-offline-key', use: 'sig', alg: 'RS256' };
  const savedSite = process.env.SITE_URL;
  const saved = {
    authProvider: config.authProvider, cognitoUserPoolId: config.cognitoUserPoolId,
    cognitoClientId: config.cognitoClientId, cognitoDomain: config.cognitoDomain,
    cognitoRedirectUrl: config.cognitoRedirectUrl, cognitoProviders: config.cognitoProviders,
    cognitoMigrationSecret: config.cognitoMigrationSecret, seedDemoAccounts: config.seedDemoAccounts,
    allowedEmailDomains: config.allowedEmailDomains, adminEmail: config.adminEmail,
  };
  let app: INestApplication;
  let http: Parameters<typeof request>[0];
  let client: ReturnType<typeof signOutClient>;
  let sdk: jest.Mock;
  let network: jest.SpyInstance;
  let mail: jest.SpyInstance;

  const idToken = () => {
    const body = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ iss: ISSUER, aud: CLIENT, token_use: 'id', sub: 'f3-offline-subject',
        email: EMAIL, email_verified: true, name: 'Managed learner',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url');
  };

  beforeAll(async () => {
    process.env.SITE_URL = SITE;
    Object.assign(config, { authProvider: 'cognito', cognitoUserPoolId: POOL, cognitoClientId: CLIENT,
      cognitoDomain: DOMAIN, cognitoRedirectUrl: `${SITE}/api/v1/auth/sso/callback`, cognitoProviders: ['Google'],
      cognitoMigrationSecret: 'cd'.repeat(32), seedDemoAccounts: false, allowedEmailDomains: [], adminEmail: '' });
    sdk = jest.fn().mockRejectedValue(new Error('Unconfigured offline provider command'));
    network = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Offline suite forbids network'));
    const verifier = CognitoJwtVerifier.create({ userPoolId: POOL, clientId: CLIENT, tokenUse: 'id' });
    verifier.cacheJwks({ keys: [jwk] });
    // The real CognitoService: only its SDK client and JWKS are local stand-ins.
    app = await boot((builder) => builder.overrideProvider(CognitoService).useFactory({
      inject: [repoToken(SettingEntity)],
      factory: (states: Repository<SettingEntity>) => new CognitoService(states,
        { send: sdk } as unknown as CognitoIdentityProviderClient, verifier),
    }));
    http = app.getHttpServer();
    client = signOutClient(http);
    mail = jest.spyOn(app.get(MailService), 'send');
  });
  afterAll(async () => {
    await app?.close();
    Object.assign(config, saved);
    if (savedSite === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = savedSite;
    jest.restoreAllMocks();
  });

  it('serves every hop from its own loopback listener, never a port another process holds', () => {
    expectOwnLoopbackListener(app);
  });

  it('advertises the managed provider the web gates its sign-out on', async () => {
    const providers = await request(http).get('/api/v1/auth/providers').expect(200);
    expect(providers.body.authProvider).toBe('cognito');
  });

  it('after the server revoke, ends at Cognito /logout with the registered logout_uri and no token in any URL', async () => {
    sdk.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name !== 'InitiateAuthCommand') throw new Error('Unexpected command');
      return { AuthenticationResult: { IdToken: idToken(), AccessToken: 'offline-access-token' } };
    });
    const signed = await request(http).post('/api/v1/auth/login').send({ email: EMAIL, password: 'Managed-offline-pass!234' }).expect(200);
    const token = signed.body.token as string;
    await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    await request(http).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`).expect(200);
    await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
    const commandsBefore = sdk.mock.calls.length;

    const response = await client.hop().expect(302);
    expect(response.headers.location).toBe(HOSTED_LOGOUT);
    const url = new URL(response.headers.location);
    expect(url.origin).toBe(DOMAIN);
    expect(url.pathname).toBe('/logout');
    expect([...url.searchParams.keys()]).toEqual(['client_id', 'logout_uri']);
    expect(url.searchParams.get('logout_uri')).toBe(`${SITE}/login`);
    expectNoTokenAnywhere(response, token, 'offline-access-token');
    // The hop itself asks Cognito nothing and stores nothing: the browser does the rest.
    expect(sdk.mock.calls.length).toBe(commandsBefore);
    const stale = await client.hop(undefined, token).expect(302);
    expect(stale.headers.location).toBe(HOSTED_LOGOUT);
    expectNoTokenAnywhere(stale, token);
  });

  it('reads no query parameter, so neither logout_uri nor client_id can be steered', async () => {
    const response = await client.hop({ logout_uri: 'https://outside.example/login', client_id: 'another-client',
      redirect_uri: 'https://outside.example/', response_type: 'code', next: '//outside.example' }).expect(302);
    expect(response.headers.location).toBe(HOSTED_LOGOUT);
    expectNoTokenAnywhere(response, 'outside.example', 'another-client');
  });

  it('is rate-limited per address: one call over the allowance inside a minute is refused', async () => {
    await exhaust(client, HOSTED_LOGOUT);
    expect(network).not.toHaveBeenCalled();
    expect(mail).not.toHaveBeenCalled();
  });
});
