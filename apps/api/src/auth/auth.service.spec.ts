import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { UserEntity } from '../db/entities';
import { AuthService, LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS } from './auth.service';
import { DEMO_ADMIN_PASSWORD, DEMO_INSTRUCTOR_PASSWORD } from '../seed/demo-accounts';
import { memoryDataSource } from '../../test/support/memory-db';

// bcryptjs's exports cannot be spied on in place, and what the throttle test
// has to see is whether the hash was checked at all, so the real compare runs
// behind a counter.
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual('bcryptjs');
  return { ...actual, compare: jest.fn(actual.compare) };
});
const compare = bcrypt.compare as unknown as jest.Mock;

const T0 = Date.UTC(2026, 0, 1);

describe('AuthService.login', () => {
  let dataSource: DataSource;
  let auth: AuthService;

  const email = 'owner@learnsdlc.test';
  const password = 'Correct-Horse-9';

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    // Only the clock is faked: bcryptjs and jsonwebtoken yield through
    // nextTick and would never resolve under a faked scheduler.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout'] });
    jest.setSystemTime(T0);
    await dataSource.manager.clear(UserEntity);
    await dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email,
        // Cost 4 keeps ten failures well under a second; compare honours the
        // hash's own cost, not BCRYPT_ROUNDS.
        passwordHash: await bcrypt.hash(password, 4),
        displayName: 'Owner',
      }),
    );
    auth = new AuthService(passwordWorkFixture(), 
      dataSource.getRepository(UserEntity),
      new JwtService({ secret: 'service-spec-secret', signOptions: { expiresIn: '1h' } }),
    );
    compare.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const fail = (attempt = 'wrong-password') =>
    expect(auth.login(email, attempt)).rejects.toThrow(UnauthorizedException);

  it('refuses a suspended account with the right password, and says why', async () => {
    await dataSource.manager.update(UserEntity, { email }, { disabledAt: new Date().toISOString() });
    await expect(auth.login(email, password)).rejects.toThrow('suspended');
    // The password was right, so this is not a guess against the throttle.
    await dataSource.manager.update(UserEntity, { email }, { disabledAt: null });
    await expect(auth.login(email, password)).resolves.toBeDefined();
  });

  it('issues a token carrying the row’s version', async () => {
    const { token } = await auth.login(email, password);
    const payload = new JwtService({ secret: 'service-spec-secret' }).verify(token);
    expect(payload).toMatchObject({ ver: 0 });
    expect(payload.sub).toHaveLength(36);
  });

  it('signs the account out everywhere: a token minted before is refused after', async () => {
    const { token } = await auth.login(email, password);
    await expect(auth.authenticate(token)).resolves.toMatchObject({ email });

    await expect(auth.signOut((await auth.authenticate(token)).id)).resolves.toEqual({
      signedOut: true,
    });

    await expect(auth.authenticate(token)).rejects.toThrow(UnauthorizedException);
    // A fresh sign-in carries the new version and works again.
    const next = await auth.login(email, password);
    await expect(auth.authenticate(next.token)).resolves.toMatchObject({ email });
    expect(new JwtService({ secret: 'service-spec-secret' }).verify(next.token)).toMatchObject({
      ver: 1,
    });
  });

  it('signing out an account that is already gone is not an error', async () => {
    await expect(auth.signOut('00000000-0000-4000-8000-000000000000')).resolves.toEqual({
      signedOut: true,
    });
  });

  it('refuses a row read that returns after logout and cannot replace the fresh session cache', async () => {
    const signedIn = await auth.login(email, password);
    const repository = dataSource.getRepository(UserEntity);
    const read = repository.findOne.bind(repository);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    jest.spyOn(repository, 'findOne').mockImplementationOnce(async (options) => {
      const oldRow = await read(options);
      entered();
      await held;
      return oldRow;
    });
    const pending = auth.authenticate(signedIn.token).then(
      () => 'accepted', (error: unknown) => error,
    );
    await started;
    await auth.signOut(signedIn.user.id);
    const fresh = await auth.login(email, password);
    await expect(auth.authenticate(fresh.token)).resolves.toMatchObject({ email });
    release();
    expect(await pending).toBeInstanceOf(UnauthorizedException);
    await expect(auth.authenticate(signedIn.token)).rejects.toThrow(UnauthorizedException);
    await expect(auth.authenticate(fresh.token)).resolves.toMatchObject({ email });
    expect((await read({ where: { id: signedIn.user.id } }))?.tokenVersion).toBe(1);
  });

  it('refuses an in-flight row after suspension without blocking a different account', async () => {
    const signedIn = await auth.login(email, password);
    const other = await dataSource.manager.save(dataSource.manager.create(UserEntity, {
      email: 'security-race-other@learnsdlc.test', displayName: 'Other', passwordHash: 'unused',
    }));
    const otherSession = await auth.issueSession(other);
    const repository = dataSource.getRepository(UserEntity);
    const read = repository.findOne.bind(repository);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    jest.spyOn(repository, 'findOne').mockImplementationOnce(async (options) => {
      const oldRow = await read(options);
      entered();
      await held;
      return oldRow;
    });
    const pending = auth.authenticate(signedIn.token).then(
      () => 'accepted', (error: unknown) => error,
    );
    await started;
    await repository.update({ id: signedIn.user.id }, { disabledAt: new Date().toISOString() });
    auth.forgetSession(signedIn.user.id);
    await expect(auth.authenticate(otherSession.token)).resolves.toMatchObject({ id: other.id });
    release();
    expect(await pending).toBeInstanceOf(UnauthorizedException);
    await expect(auth.authenticate(signedIn.token)).rejects.toThrow('suspended');
  });

  it('shares concurrent row reads and retries a failed read without caching the outage', async () => {
    const signedIn = await auth.login(email, password);
    const repository = dataSource.getRepository(UserEntity);
    const read = repository.findOne.bind(repository);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const spy = jest.spyOn(repository, 'findOne').mockImplementationOnce(async () => {
      entered();
      await held;
      throw new Error('controlled database disconnection');
    });
    const attempts = Array.from({ length: 5 }, () => auth.authenticate(signedIn.token)
      .then(() => 'accepted', (error: unknown) => error));
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    for (const result of await Promise.all(attempts)) {
      expect(result).toEqual(new Error('controlled database disconnection'));
    }
    await expect(auth.authenticate(signedIn.token)).resolves.toMatchObject({ email });
    expect(spy).toHaveBeenCalledTimes(3);
    expect((await read({ where: { id: signedIn.user.id } }))?.tokenVersion).toBe(0);
  });

  it('rejects old tokens on an independent API instance immediately after logout', async () => {
    const session = await auth.login(email, password);
    const second = new AuthService(passwordWorkFixture(), dataSource.getRepository(UserEntity),
      new JwtService({ secret: 'service-spec-secret' }));
    await expect(second.authenticate(session.token)).resolves.toMatchObject({ email });
    await auth.signOut(session.user.id);
    await expect(second.authenticate(session.token)).rejects.toThrow(UnauthorizedException);
    const fresh = await auth.login(email, password);
    await expect(second.authenticate(fresh.token)).resolves.toMatchObject({ email });
  });

  it('rechecks authority when a different process revokes during a delayed read', async () => {
    const session = await auth.login(email, password);
    const repo = dataSource.getRepository(UserEntity);
    const read = repo.findOne.bind(repo);
    const second = new AuthService(passwordWorkFixture(), repo, new JwtService({ secret: 'service-spec-secret' }));
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    jest.spyOn(repo, 'findOne').mockImplementationOnce(async options => {
      const stale = await read(options); entered(); await held; return stale;
    });
    const pending = second.authenticate(session.token).then(() => 'accepted', error => error);
    await started;
    await auth.signOut(session.user.id);
    release();
    expect(await pending).toBeInstanceOf(UnauthorizedException);
    await expect(second.authenticate(session.token)).rejects.toThrow(UnauthorizedException);
  });

  it('does not reuse prior authorization during an independent database outage', async () => {
    const session = await auth.login(email, password);
    await auth.authenticate(session.token);
    const repo = dataSource.getRepository(UserEntity);
    jest.spyOn(repo, 'findOne').mockRejectedValueOnce(new Error('controlled authority outage'));
    await expect(auth.authenticate(session.token)).rejects.toThrow('controlled authority outage');
    await expect(auth.authenticate(session.token)).resolves.toMatchObject({ email });
  });

  it('locks the account after the limit, and stops paying bcrypt for further guesses', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await fail();
    expect(compare).toHaveBeenCalledTimes(LOGIN_FAILURE_LIMIT);

    // Even the right password is refused now, with the same message, so the
    // lock does not tell the attacker they had the address right.
    await expect(auth.login(email, password)).rejects.toThrow('invalid email or password');
    expect(compare).toHaveBeenCalledTimes(LOGIN_FAILURE_LIMIT);
  });

  it('counts guesses against the address however it is typed', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      await expect(auth.login(`  ${email.toUpperCase()} `, 'nope')).rejects.toThrow(
        UnauthorizedException,
      );
    }
    await expect(auth.login(email, password)).rejects.toThrow(UnauthorizedException);
  });

  it('leaves other accounts alone', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await fail();
    await dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email: 'other@learnsdlc.test',
        passwordHash: await bcrypt.hash(password, 4),
        displayName: 'Other',
      }),
    );
    await expect(auth.login('other@learnsdlc.test', password)).resolves.toMatchObject({
      user: { email: 'other@learnsdlc.test' },
    });
  });

  it('forgets the failures once a login succeeds', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) await fail();
    await expect(auth.login(email, password)).resolves.toBeDefined();
    // A fresh allowance: the one failure that was left would otherwise lock.
    await fail();
    await expect(auth.login(email, password)).resolves.toBeDefined();
  });

  it('unlocks when the window has run out', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await fail();
    jest.setSystemTime(T0 + LOGIN_FAILURE_WINDOW_MS - 1);
    await expect(auth.login(email, password)).rejects.toThrow(UnauthorizedException);
    jest.setSystemTime(T0 + LOGIN_FAILURE_WINDOW_MS);
    await expect(auth.login(email, password)).resolves.toBeDefined();
  });
});

/**
 * A demo account's password is printed in the README. The seed creates the
 * demo accounts only on loopback, but a database the demo used can later be
 * served to a room (`npm run host`, a container that binds every interface),
 * so wherever the network can reach the API a published password is treated
 * as a wrong one.
 */
describe('AuthService.login with a password this repository publishes', () => {
  let dataSource: DataSource;
  let auth: AuthService;
  const held = { bindIsLoopback: config.bindIsLoopback, bindAddress: config.bindAddress };

  const reachable = (value: boolean) => {
    Object.assign(config, value ? { bindIsLoopback: false, bindAddress: '0.0.0.0' } : held);
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    Object.assign(config, held);
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.manager.clear(UserEntity);
    for (const [address, secret, role] of [
      ['instructor@learnsdlc.test', DEMO_INSTRUCTOR_PASSWORD, 'INSTRUCTOR'],
      ['admin@learnsdlc.test', DEMO_ADMIN_PASSWORD, 'ADMIN'],
      ['chosen@learnsdlc.test', 'A-password-someone-chose-7', 'INSTRUCTOR'],
    ] as const) {
      await dataSource.manager.save(
        dataSource.manager.create(UserEntity, {
          email: address,
          passwordHash: await bcrypt.hash(secret, 4),
          displayName: 'Staff',
          role,
        }),
      );
    }
    auth = new AuthService(passwordWorkFixture(),
      dataSource.getRepository(UserEntity),
      new JwtService({ secret: 'service-spec-secret', signOptions: { expiresIn: '1h' } }),
    );
  });

  afterEach(() => {
    reachable(false);
    jest.restoreAllMocks();
  });

  it('refuses it on a reachable bind with the wrong-password answer, and logs the kind of account, never the password', async () => {
    reachable(true);
    const warn = jest.spyOn((auth as unknown as { logger: { warn: (line: string) => void } }).logger, 'warn');
    const wrong = await auth.login('instructor@learnsdlc.test', 'not-the-password-1').catch((error: Error) => error);
    const published = await auth
      .login('instructor@learnsdlc.test', DEMO_INSTRUCTOR_PASSWORD)
      .catch((error: Error) => error);
    expect(published).toBeInstanceOf(UnauthorizedException);
    expect((published as Error).message).toBe((wrong as Error).message);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('an instructor account');
    expect(line).toContain('API_BIND=0.0.0.0');
    expect(line).not.toContain(DEMO_INSTRUCTOR_PASSWORD);
    expect(line).not.toContain('instructor@learnsdlc.test');

    await expect(auth.login('admin@learnsdlc.test', DEMO_ADMIN_PASSWORD)).rejects.toThrow('invalid email or password');
    expect(String(warn.mock.calls[1][0])).toContain('an admin account');
  });

  it('signs in with any other password on a reachable bind', async () => {
    reachable(true);
    await expect(auth.login('chosen@learnsdlc.test', 'A-password-someone-chose-7')).resolves.toBeDefined();
  });

  it('signs in with the published demo passwords on loopback, where the demo uses them', async () => {
    reachable(false);
    expect(config.bindIsLoopback).toBe(true);
    await expect(auth.login('instructor@learnsdlc.test', DEMO_INSTRUCTOR_PASSWORD)).resolves.toBeDefined();
    await expect(auth.login('admin@learnsdlc.test', DEMO_ADMIN_PASSWORD)).resolves.toBeDefined();
  });
});

/**
 * The other door.
 *
 * `ALLOWED_EMAIL_DOMAINS` is the whole of the promise that a server set to one
 * institution takes nobody else, and registration is the door it was not
 * applied to. The second half is what happens when the same form is submitted
 * twice: the existence check is a courtesy and the unique index is the rule,
 * and a learner who double-clicked should be told the account exists rather
 * than that the server broke.
 */
describe('AuthService.register', () => {
  let dataSource: DataSource;
  let auth: AuthService;
  const domains = config.allowedEmailDomains;

  const users = () => dataSource.getRepository(UserEntity);

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
    Object.assign(config, { allowedEmailDomains: domains });
  });

  beforeEach(async () => {
    await dataSource.manager.clear(UserEntity);
    Object.assign(config, { allowedEmailDomains: [] as string[] });
    auth = new AuthService(passwordWorkFixture(), 
      dataSource.getRepository(UserEntity),
      new JwtService({ secret: 'service-spec-secret', signOptions: { expiresIn: '1h' } }),
    );
  });

  it('takes any address while no domain list is set', async () => {
    await expect(auth.register('someone@example.com', 'Correct-Horse-9', 'Someone')).resolves
      .toMatchObject({ user: { email: 'someone@example.com' } });
    expect(await users().count()).toBe(1);
  });

  it('refuses an address outside ALLOWED_EMAIL_DOMAINS, and names the ones it takes', async () => {
    Object.assign(config, { allowedEmailDomains: ['uni.test'] });

    await expect(auth.register('someone@example.com', 'Correct-Horse-9', 'Someone')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(auth.register('someone@example.com', 'Correct-Horse-9', 'Someone')).rejects.toThrow(
      'Registration on this server is for @uni.test addresses',
    );
    // Nothing was written, so nothing has to be cleaned up afterwards.
    expect(await users().count()).toBe(0);
  });

  it('takes an address inside the list, however it was typed', async () => {
    Object.assign(config, { allowedEmailDomains: ['uni.test', 'sis.uni.test'] });
    await expect(auth.register('  Grace@SIS.uni.test ', 'Correct-Horse-9', 'Grace')).resolves
      .toMatchObject({ user: { email: 'grace@sis.uni.test' } });
  });

  it('refuses the address before it says whether it is already registered', async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email: 'squatter@example.com',
        passwordHash: await bcrypt.hash('Correct-Horse-9', 4),
        displayName: 'Squatter',
      }),
    );
    Object.assign(config, { allowedEmailDomains: ['uni.test'] });

    // The domain sentence, not the conflict one: an address this server will
    // not take learns nothing about who is registered on it.
    await expect(auth.register('squatter@example.com', 'Correct-Horse-9', 'Someone')).rejects.toThrow(
      'Registration on this server is for @uni.test addresses',
    );
  });

  it('answers a second sign-up for one address with a conflict, not a 500', async () => {
    await expect(auth.register('ada@uni.test', 'Correct-Horse-9', 'Ada')).resolves.toBeDefined();
    await expect(auth.register('ada@uni.test', 'Correct-Horse-9', 'Ada')).rejects.toThrow(
      ConflictException,
    );
  });

  it('answers a double-submitted sign-up with one session and one conflict', async () => {
    // Both calls read no row before either writes one, which is the race the
    // existence check cannot win; the unique index is what decides it.
    const [first, second] = await Promise.allSettled([
      auth.register('ada@uni.test', 'Correct-Horse-9', 'Ada'),
      auth.register('ada@uni.test', 'Correct-Horse-9', 'Ada'),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ConflictException);
    expect((refused.reason as Error).message).toBe('an account with this email already exists');
    expect(await users().count()).toBe(1);
  });
});
