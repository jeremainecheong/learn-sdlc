import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { HttpTarget } from './support/http';

/** Keep an unexpected response useful without ever printing a session or arbitrary body text. */
function safeFailureBody(body: Record<string, unknown>) {
  const messages = new Set([
    'password must be at least 8 characters',
    'displayName must be longer than or equal to 2 characters',
    'missing bearer token',
    'invalid email or password',
    'rate limit exceeded — slow down',
  ]);
  const safeMessage = (value: unknown) =>
    typeof value === 'string' && messages.has(value) ? value : '<unrecognized message redacted>';
  return {
    statusCode: typeof body.statusCode === 'number' ? body.statusCode : undefined,
    error: ['Bad Request', 'Unauthorized', 'Forbidden', 'Too Many Requests'].includes(String(body.error))
      ? body.error : '<unrecognized error redacted>',
    message: Array.isArray(body.message) ? body.message.map(safeMessage) : safeMessage(body.message),
  };
}

/**
 * On the real routes: a class of thirty to forty arrives in the same
 * minute, through one venue NAT, and every one of them shares an address.
 *
 * Keyed on that address alone, at 20 and 30 a minute, a limiter on
 * `POST /auth/register` and `POST /auth/login` would refuse the twenty-first
 * person to sign up and the thirty-first to sign in before their password was
 * ever read; the counts below reproduce that load. The keys are the address
 * *and* the account being acted on, under a room-sized ceiling on the address,
 * so the room gets in and one account still cannot be hammered.
 *
 * Deliberately no valid accounts for the burst: `AuthService.login` returns
 * before bcrypt for an address it does not know (`!user ||`), so forty
 * attempts cost forty database reads rather than forty key derivations. What
 * is under test is which status the guard returns, and 401 and 429 are exactly
 * as different for an unknown account as for a known one.
 */
describe('sign-in rate limits with a class on one address', () => {
  let app: INestApplication;
  let http: HttpTarget;
  const registrationRequests = new Map<string, {
    method: string; path: string; matchedRoute: string | null; status: number;
  }>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    // This observation does not change routing, guards, responses or retries.
    // It exists so an unexpected 401 in a full-suite run carries enough
    // evidence to identify its source.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const probe = req.headers['x-sign-in-test-probe'];
      if (typeof probe === 'string' && /^(registration|interleaved)-\d{1,2}$/.test(probe)) {
        res.once('finish', () => registrationRequests.set(probe, {
          method: req.method,
          path: req.path,
          matchedRoute: typeof req.route?.path === 'string' ? req.route.path : null,
          status: res.statusCode,
        }));
      }
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (email: string) =>
    request(http).post('/api/v1/auth/login').send({ email, password: 'Password1!' });

  it('lets forty learners sign in from one address in the same minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await login(`cohort-${i}@uni.test`)).status);
    }
    // Every one of them reached the password check, the thirty-first onward
    // included.
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([401]));
  });

  it('still refuses the thirty-first attempt on one account from that address', async () => {
    const target = 'target@uni.test';
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await login(target)).status);
    expect(statuses.filter((s) => s === 429)).toEqual([]);

    await login(target).expect(429);

    // And it is that account that is refused, not the room: the learner at
    // the next desk, on the same address, is still let through to the check.
    await login('bystander@uni.test').expect(401);
  });

  it('lets a class-sized burst of registrations through one address', async () => {
    // Twenty-five is past an address-only ceiling of twenty. The bodies are rejected
    // by validation, which is the point: the guard runs before the pipe, so
    // these are counted exactly as real registrations would be, without
    // paying bcrypt twenty-five times.
    const statuses: number[] = [];
    const unexpected: unknown[] = [];
    for (let i = 0; i < 25; i++) {
      const probe = `registration-${i}`;
      const response = await request(http)
        .post('/api/v1/auth/register')
        .set('x-sign-in-test-probe', probe)
        .send({ email: `signup-${i}@uni.test`, password: 'short', displayName: 'x' });
      statuses.push(response.status);
      if (response.status !== 400) unexpected.push({
        index: i,
        status: response.status,
        received: registrationRequests.get(probe) ?? null,
        body: safeFailureBody(response.body),
      });
    }
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([400]));
  });

  it('signs a real learner in during the same burst', async () => {
    await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'late-arrival@uni.test', password: 'Password1!', displayName: 'Late' })
      .expect(201);
    const signedIn = await login('late-arrival@uni.test').expect(200);
    expect(signedIn.body.token).toEqual(expect.any(String));
  });

  it('keeps refused login and invalid registration responses separate when they overlap', async () => {
    // One listener for this deliberately concurrent slice: Supertest otherwise
    // starts/stops the raw server when each independent request takes ownership.
    // The sequential burst above keeps supertest's per-request lifecycle.
    await app.listen(0, '127.0.0.1');
    try {
      const expired = app.get(JwtService).sign({ sub: 'not-an-account', ver: 0 }, { expiresIn: -1 });
      const headers = [undefined, 'Bearer forged', `Bearer ${expired}`];
      const pairs = await Promise.all(Array.from({ length: 25 }, async (_, i) => {
        const probe = `interleaved-${i}`;
        const registration = request(http).post('/api/v1/auth/register')
          .set('x-sign-in-test-probe', probe)
          .send({ email: `interleaved-signup-${i}@uni.test`, password: 'short', displayName: 'x' });
        const header = headers[i % headers.length];
        if (header) registration.set('Authorization', header);
        const [refused, invalid] = await Promise.all([
          login(`interleaved-login-${i}@uni.test`), registration,
        ]);
        return {
          login: { status: refused.status, body: safeFailureBody(refused.body) },
          registration: { status: invalid.status, body: safeFailureBody(invalid.body) },
          received: registrationRequests.get(probe),
        };
      }));
      for (const pair of pairs) {
        expect(pair.login).toMatchObject({ status: 401, body: { message: 'invalid email or password' } });
        expect(pair.registration).toMatchObject({ status: 400, body: { message: expect.arrayContaining(['password must be at least 8 characters']) } });
        expect(pair.received).toEqual({ method: 'POST', path: '/api/v1/auth/register', matchedRoute: '/api/v1/auth/register', status: 400 });
      }
      // A refused/stale bearer does not turn a public route private, while
      // the adjacent private route must still enforce it.
      await request(http).get('/api/v1/auth/me').set('Authorization', 'Bearer forged').expect(401);
    } finally {
      await new Promise<void>((resolve, reject) => http.close((error?: Error) => error ? reject(error) : resolve()));
    }
  });
});
