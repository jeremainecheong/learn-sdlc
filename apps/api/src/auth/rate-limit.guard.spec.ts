import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { PhasesController } from '../workflow/phases.controller';
import { ProjectsController } from '../workflow/projects.controller';
import {
  RATE_LIMIT_KEY,
  RateLimit,
  RateLimitCounter,
  RateLimitGuard,
  type RateLimitRule,
  SWEEP_PRESSURE_SIZE,
} from './rate-limit.guard';

/** Stands in for a controller so the guard reads real decorator metadata. */
class Probe {
  @RateLimit(3, 60)
  login(): void {}

  @RateLimit(1, 1)
  ping(): void {}

  open(): void {}
}

/** The room-sized ceiling on one address, and the allowance on one account. */
const PER_ADDRESS = 200;
const PER_ACCOUNT = 30;

/** The sign-in shape: counted per address, and again per address and account. */
class SignIn {
  @RateLimit(PER_ACCOUNT, 60, {
    identityField: 'email',
    perAddress: { max: PER_ADDRESS, windowSeconds: 60 },
  })
  login(): void {}
}

const signInContext = (ip: string, body?: unknown) =>
  ({
    getHandler: () => SignIn.prototype.login,
    getClass: () => SignIn,
    switchToHttp: () => ({
      getRequest: () => ({ ip, method: 'POST', route: { path: '/auth/login' }, body }),
    }),
  }) as unknown as ExecutionContext;

/** One learner's sign-in attempt from the classroom's shared address. */
const attempt = (email: string, ip = '203.0.113.9') => signInContext(ip, { email });

const T0 = Date.UTC(2026, 0, 1);

const contextFor = (ip: string, handler: keyof Probe = 'login') =>
  ({
    getHandler: () => Probe.prototype[handler],
    getClass: () => Probe,
    switchToHttp: () => ({
      getRequest: () => ({ ip, method: 'POST', route: { path: `/${handler}` } }),
    }),
  }) as unknown as ExecutionContext;

/** The rejection status, or 0 when the guard let the request through. */
const rejectStatus = (guard: RateLimitGuard, context: ExecutionContext): number => {
  try {
    guard.canActivate(context);
    return 0;
  } catch (err) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
};

/** The table is private; the sweep tests need to watch it grow and shrink. */
const bucketCount = (guard: RateLimitGuard): number =>
  (guard as unknown as { buckets: Map<string, unknown> }).buckets.size;

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    guard = new RateLimitGuard(new Reflector());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('leaves handlers that carry no limit alone', () => {
    const open = contextFor('10.0.0.1', 'open');
    for (let i = 0; i < 50; i++) expect(guard.canActivate(open)).toBe(true);
    expect(bucketCount(guard)).toBe(0);
  });

  it('allows exactly the configured number of requests, then answers 429', () => {
    const caller = contextFor('10.0.0.1');
    for (let i = 0; i < 3; i++) expect(guard.canActivate(caller)).toBe(true);
    expect(rejectStatus(guard, caller)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('counts each caller against their own allowance', () => {
    const first = contextFor('10.0.0.1');
    for (let i = 0; i < 3; i++) guard.canActivate(first);
    expect(guard.canActivate(contextFor('10.0.0.2'))).toBe(true);
  });

  it('opens a fresh window once the old one has run out', () => {
    const caller = contextFor('10.0.0.1');
    for (let i = 0; i < 3; i++) guard.canActivate(caller);

    // A second before the window ends a sweep is due, and must not be the
    // thing that lets this caller back in.
    jest.setSystemTime(T0 + 59_000);
    expect(rejectStatus(guard, caller)).toBe(HttpStatus.TOO_MANY_REQUESTS);

    jest.setSystemTime(T0 + 60_000);
    expect(guard.canActivate(caller)).toBe(true);
  });

  it('carries a class arriving together from one address', () => {
    // The whole cohort comes through one venue NAT, so keying sign-in on the
    // address alone is a limit on the room: measured, the 21st register and
    // the 31st login from one address were refused. Forty learners are forty
    // accounts, and every one of them gets in.
    for (let i = 0; i < 40; i++) {
      expect(guard.canActivate(attempt(`learner${i}@uni.test`))).toBe(true);
    }
  });

  it('still holds one account from that address to its own allowance', () => {
    const target = 'victim@uni.test';
    for (let i = 0; i < PER_ACCOUNT; i++) expect(guard.canActivate(attempt(target))).toBe(true);
    expect(rejectStatus(guard, attempt(target))).toBe(HttpStatus.TOO_MANY_REQUESTS);

    // And the refusal is that account's alone: the learner beside them, on
    // the same address, signs in.
    expect(guard.canActivate(attempt('someone-else@uni.test'))).toBe(true);
  });

  it('treats the address and the account as one identity, case and spacing aside', () => {
    const target = 'Victim@UNI.test';
    for (let i = 0; i < PER_ACCOUNT; i++) guard.canActivate(attempt(target));
    expect(rejectStatus(guard, attempt('  victim@uni.test  '))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('counts the address ceiling first, so invented accounts cannot grow the table', () => {
    // Keying on caller-supplied text is only safe while something bounds how
    // much of it one caller can mint. The ceiling is counted before the
    // account bucket is even built.
    for (let i = 0; i < PER_ADDRESS; i++) {
      expect(guard.canActivate(attempt(`throwaway${i}@example.com`))).toBe(true);
    }
    // One address bucket plus one per account seen, and no more.
    expect(bucketCount(guard)).toBe(PER_ADDRESS + 1);
    expect(rejectStatus(guard, attempt('throwaway-next@example.com'))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(bucketCount(guard)).toBe(PER_ADDRESS + 1);
  });

  it('keeps each address in its own ceiling', () => {
    for (let i = 0; i < PER_ADDRESS; i++) guard.canActivate(attempt(`a${i}@example.com`));
    expect(guard.canActivate(attempt('a0@example.com', '198.51.100.4'))).toBe(true);
  });

  it('counts a sign-in with no readable account, rather than letting it through', () => {
    // Guards run before validation, so the body can be anything. A request
    // with no usable identity shares one bucket: still counted, just without a
    // bucket of its own to hide in.
    const malformed = [undefined, {}, { email: 42 }, { email: '   ' }];
    for (let i = 0; i < PER_ACCOUNT; i++) {
      expect(guard.canActivate(signInContext('203.0.113.9', malformed[i % 4]))).toBe(true);
    }
    expect(rejectStatus(guard, signInContext('203.0.113.9', {}))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('sweeps a full table without resetting a counter that is still counting', () => {
    const attacker = contextFor('10.0.0.1');
    for (let i = 0; i < 3; i++) guard.canActivate(attacker);

    // Filling the table must not clear it, which would hand the attacker their
    // allowance back. The fillers use the one-second window so they are
    // genuinely expired by the time the sweep runs.
    jest.setSystemTime(T0 + 1_000);
    for (let i = 0; i <= SWEEP_PRESSURE_SIZE; i++) {
      guard.canActivate(contextFor(`198.51.100.${i}`, 'ping'));
    }
    expect(bucketCount(guard)).toBeGreaterThan(SWEEP_PRESSURE_SIZE);

    // Any later request finds the sweep due: the expired fillers go, the
    // attacker's window (still 55 seconds from expiry) stays.
    jest.setSystemTime(T0 + 5_000);
    guard.canActivate(contextFor('203.0.113.7', 'ping'));
    expect(bucketCount(guard)).toBeLessThan(SWEEP_PRESSURE_SIZE);
    expect(rejectStatus(guard, attacker)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });
});

/**
 * A shared counter, in a Map, so the replica-crossing behaviour can be tested
 * without a Redis server: `windows` is what Redis would hold, and `fail` is
 * Redis being unreachable.
 */
class FakeCounter implements RateLimitCounter {
  readonly windows = new Map<string, number>();
  fail: Error | null = null;
  shutdowns = 0;

  async hit(key: string): Promise<number> {
    if (this.fail) throw this.fail;
    const next = (this.windows.get(key) ?? 0) + 1;
    this.windows.set(key, next);
    return next;
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
}

/** The rejection status of an async decision, or 0 when it let the request through. */
const rejectStatusAsync = async (
  guard: RateLimitGuard,
  context: ExecutionContext,
): Promise<number> => {
  try {
    await guard.canActivate(context);
    return 0;
  } catch (err) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
};

describe('RateLimitGuard with a shared counter', () => {
  let counter: FakeCounter;
  let guard: RateLimitGuard;

  beforeEach(() => {
    counter = new FakeCounter();
    guard = new RateLimitGuard(new Reflector(), counter);
  });

  it('counts in the shared store, not in this process', async () => {
    const caller = contextFor('10.0.0.1');
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(caller)).resolves.toBe(true);
    expect(await rejectStatusAsync(guard, caller)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(bucketCount(guard)).toBe(0);
    expect([...counter.windows.values()]).toEqual([4]);
  });

  it('holds one limit across replicas sharing the counter', async () => {
    const other = new RateLimitGuard(new Reflector(), counter);
    const caller = contextFor('10.0.0.1');
    // Two of the three requests land on one replica, one on the other; the
    // per-process guard would have allowed six before rejecting.
    await guard.canActivate(caller);
    await other.canActivate(caller);
    await guard.canActivate(caller);
    expect(await rejectStatusAsync(other, caller)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('keeps every caller in their own window', async () => {
    const first = contextFor('10.0.0.1');
    for (let i = 0; i < 3; i++) await guard.canActivate(first);
    await expect(guard.canActivate(contextFor('10.0.0.2'))).resolves.toBe(true);
  });

  it('falls back to this process when the counter will not answer', async () => {
    counter.fail = new Error('Command timed out');
    const caller = contextFor('10.0.0.1');
    // Degraded, not open: the limit still holds, it just holds per process.
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(caller)).resolves.toBe(true);
    expect(await rejectStatusAsync(guard, caller)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(bucketCount(guard)).toBe(1);
  });

  it('returns to the shared counter once it answers again', async () => {
    const caller = contextFor('10.0.0.1');
    counter.fail = new Error('ECONNREFUSED');
    await guard.canActivate(caller);
    counter.fail = null;
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(caller)).resolves.toBe(true);
    expect(await rejectStatusAsync(guard, caller)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('leaves every other route keyed exactly as it was', async () => {
    // The composite key is for sign-in only; nothing else changes bucket, so
    // no existing limit is silently reset by this change.
    await guard.canActivate(contextFor('10.0.0.1'));
    expect([...counter.windows.keys()]).toEqual(['10.0.0.1:POST:/login']);
  });

  it('counts the address and the account as two keys in the shared store', async () => {
    await guard.canActivate(attempt('learner@uni.test'));
    expect([...counter.windows.keys()]).toEqual([
      '203.0.113.9:POST:/auth/login',
      '203.0.113.9|learner@uni.test:POST:/auth/login',
    ]);
  });

  it('holds the account limit across replicas that share the counter', async () => {
    const other = new RateLimitGuard(new Reflector(), counter);
    const target = attempt('victim@uni.test');
    for (let i = 0; i < PER_ACCOUNT; i++) {
      await (i % 2 === 0 ? guard : other).canActivate(target);
    }
    expect(await rejectStatusAsync(other, target)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('stops at the address ceiling without touching the account key', async () => {
    for (let i = 0; i < PER_ADDRESS; i++) await guard.canActivate(attempt(`a${i}@example.com`));
    const before = counter.windows.size;
    expect(await rejectStatusAsync(guard, attempt('a-new@example.com'))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(counter.windows.size).toBe(before);
  });

  it('closes the counter when the application shuts down', async () => {
    await guard.onApplicationShutdown();
    expect(counter.shutdowns).toBe(1);
  });
});

/**
 * The routes that fan out over a learner's whole project carry a limit, and
 * the metadata is asserted here so it cannot quietly be dropped: each of
 * these reconciles the enrolment and builds every open phase, so unlimited it
 * would answer as fast as the socket allowed while the cheaper account export
 * is throttled.
 */
describe('the whole-project reads carry a rate limit', () => {
  const limitOn = (handler: unknown): RateLimitRule | undefined =>
    Reflect.getMetadata(RATE_LIMIT_KEY, handler as object) as RateLimitRule | undefined;

  it('limits GET /phases/summaries and GET /phases/records at the instructor console´s rate', () => {
    expect(limitOn(PhasesController.prototype.summaries)).toMatchObject({ max: 60, windowSeconds: 60 });
    expect(limitOn(PhasesController.prototype.records)).toMatchObject({ max: 60, windowSeconds: 60 });
  });

  it('limits GET /projects/:slug/map, and mounts the guard on its controller', () => {
    expect(limitOn(ProjectsController.prototype.map)).toMatchObject({ max: 30, windowSeconds: 60 });
    const guards = Reflect.getMetadata(GUARDS_METADATA, ProjectsController) as unknown[];
    expect(guards).toContain(RateLimitGuard);
  });
});
