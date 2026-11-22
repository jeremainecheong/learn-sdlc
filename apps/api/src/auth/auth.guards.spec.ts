import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@learnsdlc/shared';
import type { Repository } from 'typeorm';
import { UserEntity } from '../db/entities';
import { Public, Roles } from './auth.decorators';
import { JwtAuthGuard, RolesGuard } from './auth.guards';
import { AuthService } from './auth.service';

/** Stands in for a controller so the guard reads real decorator metadata. */
class Probe {
  @Public()
  open(): void {}

  guarded(): void {}
}

const T0 = Date.UTC(2026, 0, 1);
const ALICE = '11111111-1111-4111-8111-111111111111';

/** The columns the guard reads, as the row holds them right now. */
const row = (overrides: Partial<UserEntity> = {}): UserEntity =>
  ({
    id: ALICE,
    email: 'alice@learnsdlc.test',
    role: 'LEARNER',
    cohort: 'default',
    tokenVersion: 0,
    disabledAt: null,
    ...overrides,
  }) as UserEntity;

describe('JwtAuthGuard', () => {
  let jwt: JwtService;
  let findOne: jest.Mock;
  let auth: AuthService;
  let guard: JwtAuthGuard;

  const contextFor = (authorization: string | undefined, handler: keyof Probe = 'guarded') => {
    const request: { headers: Record<string, string>; user?: unknown } = {
      headers: authorization ? { authorization } : {},
    };
    const context = {
      getHandler: () => Probe.prototype[handler],
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  };

  const tokenFor = (sub: string, ver: number | undefined) =>
    jwt.signAsync(ver === undefined ? { sub } : { sub, ver });

  /** The status the guard answered with, or 0 when it let the request through. */
  const attempt = async (token: string, handler: keyof Probe = 'guarded') => {
    const { context, request } = contextFor(`Bearer ${token}`, handler);
    try {
      await guard.canActivate(context);
      return { status: 0, user: request.user as UserEntity | undefined };
    } catch (err) {
      return {
        status: err instanceof UnauthorizedException ? err.getStatus() : -1,
        user: undefined,
      };
    }
  };

  beforeEach(() => {
    // Only the clock is faked: jsonwebtoken yields through nextTick and would
    // never resolve under a faked scheduler.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout'] });
    jest.setSystemTime(T0);
    jwt = new JwtService({ secret: 'guard-spec-secret', signOptions: { expiresIn: '1h' } });
    findOne = jest.fn(async () => row());
    auth = new AuthService(passwordWorkFixture(), { findOne } as unknown as Repository<UserEntity>, jwt);
    guard = new JwtAuthGuard(auth, new Reflector());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lets a @Public handler through without reading a token or the row', async () => {
    const { context } = contextFor(undefined, 'open');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('answers 401 with no bearer header, and with a token signed by someone else', async () => {
    await expect(guard.canActivate(contextFor(undefined).context)).rejects.toThrow(
      UnauthorizedException,
    );
    const forged = await new JwtService({ secret: 'not-ours' }).signAsync({ sub: ALICE, ver: 0 });
    expect((await attempt(forged)).status).toBe(401);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('admits a token whose version matches the row, and describes the caller from the row', async () => {
    const result = await attempt(await tokenFor(ALICE, 0));
    expect(result.status).toBe(0);
    expect(result.user).toEqual({
      id: ALICE,
      email: 'alice@learnsdlc.test',
      role: 'LEARNER',
      cohort: 'default',
      sessionVersion: 0,
    });
  });

  it('refuses a token minted before the row’s version was bumped', async () => {
    findOne.mockResolvedValue(row({ tokenVersion: 1 }));
    expect((await attempt(await tokenFor(ALICE, 0))).status).toBe(401);
    expect((await attempt(await tokenFor(ALICE, 1))).status).toBe(0);
  });

  it('refuses a token that predates the version claim altogether', async () => {
    // Tokens issued before `ver` existed carry none; they must not pass as
    // version zero, or the first deploy of this check would revoke nothing.
    expect((await attempt(await tokenFor(ALICE, undefined))).status).toBe(401);
  });

  it('refuses a suspended account and a deleted one alike', async () => {
    findOne.mockResolvedValue(row({ disabledAt: new Date(T0).toISOString() }));
    expect((await attempt(await tokenFor(ALICE, 0))).status).toBe(401);

    auth.forgetSession(ALICE);
    findOne.mockResolvedValue(null);
    expect((await attempt(await tokenFor(ALICE, 0))).status).toBe(401);
  });

  it('takes role and cohort from the row, never from the token', async () => {
    // A learner promoted to instructor mid-week must not wait for the token to
    // expire, and a token that claims a role it was never issued must not gain it.
    const claimsAdmin = await jwt.signAsync({ sub: ALICE, ver: 0, role: 'ADMIN', cohort: 'x' });
    findOne.mockResolvedValue(row({ role: 'INSTRUCTOR', cohort: 'spring-26' }));
    const result = await attempt(claimsAdmin);
    expect(result.status).toBe(0);
    expect(result.user).toMatchObject({ role: 'INSTRUCTOR', cohort: 'spring-26' });
  });

  describe('shared session authority', () => {
    it('reads current authority on every request without a TTL of stale permissions', async () => {
      const token = await tokenFor(ALICE, 0);
      for (let i = 0; i < 5; i++) expect((await attempt(token)).status).toBe(0);
      expect(findOne).toHaveBeenCalledTimes(10);
      findOne.mockResolvedValue(row({ tokenVersion: 1 }));
      expect((await attempt(token)).status).toBe(401);
    });

    it('sees another process commit without a local forgetSession event', async () => {
      const token = await tokenFor(ALICE, 0);
      expect((await attempt(token)).status).toBe(0);
      findOne.mockResolvedValue(row({ tokenVersion: 1 }));
      expect((await attempt(token)).status).toBe(401);
    });

    it.each([['not-a-uuid', 0], [ALICE, -1], [ALICE, 0.5], [ALICE, '0']])(
      'rejects malformed signed session claims before database access', async (sub, ver) => {
        expect((await attempt(await jwt.signAsync({ sub, ver }))).status).toBe(401);
        expect(findOne).not.toHaveBeenCalled();
      },
    );

    it('tells revocation listeners which account was signed out', () => {
      const seen: string[] = [];
      auth.onSessionRevoked((id) => seen.push(id));
      auth.forgetSession(ALICE);
      expect(seen).toEqual([ALICE]);
    });
  });
});

/**
 * The escalation a two-tier staff model actually has is instructor against
 * admin, and a learner against an instructor route does not test the guard
 * that stops it. These are
 * the four answers the guard can give, plus the two ways the decorator is
 * actually written in this codebase: on the class (AdminController,
 * InstructorDetailController) and on the handler (CohortsController, whose
 * two prefixes need different roles per route).
 */
describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  /** Stands in for a controller so the guard reads real decorator metadata. */
  @Roles('ADMIN')
  class AdminLike {
    scoped(): void {}

    @Roles('INSTRUCTOR', 'ADMIN')
    widened(): void {}
  }

  class OpenLike {
    anyone(): void {}

    @Roles('LEARNER')
    learnersOnly(): void {}
  }

  type Probe = AdminLike | OpenLike;

  const contextFor = (
    target: new () => Probe,
    handler: string,
    user: { role: Role } | undefined,
  ) =>
    ({
      getHandler: () => (target.prototype as Record<string, unknown>)[handler],
      getClass: () => target,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const decide = (target: new () => Probe, handler: string, user: { role: Role } | undefined) => {
    try {
      return guard.canActivate(contextFor(target, handler, user));
    } catch (err) {
      return err instanceof ForbiddenException ? err.getStatus() : -1;
    }
  };

  it('lets a route with no @Roles through, whoever is asking', () => {
    expect(decide(OpenLike, 'anyone', { role: 'LEARNER' })).toBe(true);
    expect(decide(OpenLike, 'anyone', undefined)).toBe(true);
  });

  it('admits exactly the roles the route asked for', () => {
    expect(decide(AdminLike, 'scoped', { role: 'ADMIN' })).toBe(true);
    expect(decide(OpenLike, 'learnersOnly', { role: 'LEARNER' })).toBe(true);
    expect(decide(AdminLike, 'widened', { role: 'INSTRUCTOR' })).toBe(true);
    expect(decide(AdminLike, 'widened', { role: 'ADMIN' })).toBe(true);
  });

  it('answers 403 to a role the route did not name', () => {
    // The one that matters: staff is two tiers, and an instructor is not an
    // administrator. A learner is the easy case; this is the real one.
    expect(decide(AdminLike, 'scoped', { role: 'INSTRUCTOR' })).toBe(403);
    expect(decide(AdminLike, 'scoped', { role: 'LEARNER' })).toBe(403);
    expect(decide(AdminLike, 'widened', { role: 'LEARNER' })).toBe(403);
    // A learner-only route is not a staff route: an instructor redeeming a
    // class code would land in another instructor's class.
    expect(decide(OpenLike, 'learnersOnly', { role: 'INSTRUCTOR' })).toBe(403);
    expect(decide(OpenLike, 'learnersOnly', { role: 'ADMIN' })).toBe(403);
  });

  it('answers 403 when the request carries no caller at all', () => {
    // JwtAuthGuard runs first and sets request.user, so this is the state after
    // a mistake: a guard order change, or @Public on a role-gated route. It
    // must fail closed rather than read `undefined.role`.
    expect(decide(AdminLike, 'scoped', undefined)).toBe(403);
    expect(decide(OpenLike, 'learnersOnly', undefined)).toBe(403);
  });

  it('lets a handler widen what its class declared', () => {
    // getAllAndOverride, not getAllAndMerge: the handler's list replaces the
    // class's. Asserted because a merge would silently narrow `widened` to
    // ADMIN and lock every instructor out of a route meant for them.
    expect(decide(AdminLike, 'widened', { role: 'INSTRUCTOR' })).toBe(true);
    expect(decide(AdminLike, 'scoped', { role: 'INSTRUCTOR' })).toBe(403);
  });
});
