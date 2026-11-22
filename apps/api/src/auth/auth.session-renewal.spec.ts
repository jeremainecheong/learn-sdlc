import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { config, resolveJwtExpiresIn } from '../config';
import { UserEntity } from '../db/entities';
import {
  AuthService,
  MANAGED_SESSION_CAP_MS,
  MANAGED_SESSION_LIFE_SECONDS,
  SESSION_CAP_REACHED,
} from './auth.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The managed session (AUTH_PROVIDER=cognito) lives three hours and is
 * renewed while in use, up to twelve hours after the sign-in; the local mode
 * keeps JWT_EXPIRES_IN's life. These pin the token's life, the `orig` claim,
 * the renewal and its two refusals.
 */
const T0 = Date.UTC(2026, 10, 9, 2, 0, 0);
const HOUR = 60 * 60_000;

interface Claims { sub: string; ver: number; exp: number; iat: number; orig?: number; provider: string }

describe('managed session life and renewal', () => {
  let dataSource: DataSource;
  let auth: AuthService;
  let jwt: JwtService;
  let user: UserEntity;
  const saved = { authProvider: config.authProvider };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    Object.assign(config, saved);
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout'] });
    jest.setSystemTime(T0);
    Object.assign(config, { authProvider: 'cognito' });
    await dataSource.manager.clear(UserEntity);
    user = await dataSource.manager.save(dataSource.manager.create(UserEntity, {
      email: 'learner@learnsdlc.test', passwordHash: '', displayName: 'Learner', cognitoSub: 'sub-1',
    }));
    // The module's own signing options: the local mode's life comes from here.
    jwt = new JwtService({ secret: 'renewal-spec-secret', signOptions: { expiresIn: resolveJwtExpiresIn({}) } });
    auth = new AuthService(passwordWorkFixture(), dataSource.getRepository(UserEntity), jwt);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.assign(config, saved);
  });

  const claims = (token: string) => jwt.decode(token) as Claims;

  it('signs a managed token for three hours that carries the sign-in time as orig', async () => {
    const { token } = await auth.issueSession(user);
    const c = claims(token);
    expect(MANAGED_SESSION_LIFE_SECONDS).toBe(3 * 60 * 60);
    expect(c.exp - c.iat).toBe(3 * 60 * 60);
    expect(c.orig).toBe(T0);
    expect(c.provider).toBe('cognito');
  });

  it('renews with a later exp, the same orig and the same user', async () => {
    const first = await auth.issueSession(user);
    jest.setSystemTime(T0 + HOUR + 5 * 60_000);
    const renewed = await auth.renewSession(first.token);
    const before = claims(first.token);
    const after = claims(renewed.token);
    expect(renewed.token).not.toBe(first.token);
    expect(after.exp).toBeGreaterThan(before.exp);
    expect(after.exp - after.iat).toBe(3 * 60 * 60);
    expect(after.orig).toBe(T0);
    expect(after.sub).toBe(user.id);
    expect(renewed.user.id).toBe(user.id);
    // The renewed token is itself a working session token, and renews again.
    await expect(auth.authenticate(renewed.token)).resolves.toMatchObject({ id: user.id });
    jest.setSystemTime(T0 + 2 * HOUR + 10 * 60_000);
    expect(claims((await auth.renewSession(renewed.token)).token).orig).toBe(T0);
  });

  it('refuses a renewal once twelve hours have passed since the sign-in', async () => {
    // Signed in just under twelve hours ago: the last renewal is still given.
    const near = await auth.issueSession(user, T0 - MANAGED_SESSION_CAP_MS + 60_000);
    await expect(auth.renewSession(near.token)).resolves.toBeDefined();
    const atCap = await auth.issueSession(user, T0 - MANAGED_SESSION_CAP_MS);
    const refusal = await auth.renewSession(atCap.token).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect((refusal as UnauthorizedException).getResponse()).toMatchObject({ code: SESSION_CAP_REACHED });
    // The token itself still works until its own exp: the cap stops renewal, not the session.
    await expect(auth.authenticate(atCap.token)).resolves.toMatchObject({ id: user.id });
  });

  it('refuses a renewal for a token whose version the row has moved past', async () => {
    const { token } = await auth.issueSession(user);
    await auth.signOut(user.id);
    await expect(auth.renewSession(token)).rejects.toThrow('signed out');
  });

  it('refuses a renewal when the version moves between the check and the re-read', async () => {
    const { token } = await auth.issueSession(user);
    const repo = dataSource.getRepository(UserEntity);
    const read = repo.findOneBy.bind(repo);
    // authenticate has accepted the token; a sign-out lands before the re-read.
    const spy = jest.spyOn(repo, 'findOneBy').mockImplementationOnce(async (where) => {
      await auth.signOut(user.id);
      return read(where);
    });
    await expect(auth.renewSession(token)).rejects.toThrow('signed out');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('refuses a renewal when the account is suspended or its identity changes between the reads', async () => {
    const repo = dataSource.getRepository(UserEntity);
    const read = repo.findOneBy.bind(repo);
    const first = await auth.issueSession(user);
    let spy = jest.spyOn(repo, 'findOneBy').mockImplementationOnce(async (where) => {
      await repo.update({ id: user.id }, { disabledAt: new Date().toISOString() });
      return read(where);
    });
    await expect(auth.renewSession(first.token)).rejects.toThrow('suspended');
    spy.mockRestore();
    await repo.update({ id: user.id }, { disabledAt: null });

    const second = await auth.issueSession(user);
    spy = jest.spyOn(repo, 'findOneBy').mockImplementationOnce(async (where) => {
      await repo.update({ id: user.id }, { cognitoSub: 'sub-2' });
      return read(where);
    });
    await expect(auth.renewSession(second.token)).rejects.toThrow('Managed identity');
    spy.mockRestore();
  });

  it('refuses an expired token and a token that is not ours', async () => {
    const { token } = await auth.issueSession(user);
    jest.setSystemTime(T0 + 3 * HOUR + 1_000);
    await expect(auth.renewSession(token)).rejects.toThrow(UnauthorizedException);
    await expect(auth.renewSession('')).rejects.toThrow(UnauthorizedException);
    await expect(auth.renewSession('not.a.token')).rejects.toThrow(UnauthorizedException);
  });

  it('keeps the local mode at its seven-day default, with no orig and no cap', async () => {
    Object.assign(config, { authProvider: 'local' });
    expect(resolveJwtExpiresIn({})).toBe('7d');
    const { token } = await auth.issueSession(user);
    const c = claims(token);
    expect(c.exp - c.iat).toBe(7 * 24 * 60 * 60);
    expect(c.orig).toBeUndefined();
    expect(c.provider).toBe('local');
    jest.setSystemTime(T0 + 13 * HOUR);
    const renewed = await auth.renewSession(token);
    const r = claims(renewed.token);
    expect(r.exp - r.iat).toBe(7 * 24 * 60 * 60);
    expect(r.exp).toBeGreaterThan(c.exp);
  });
});
