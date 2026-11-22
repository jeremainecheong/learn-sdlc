import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import IORedis, { Redis } from 'ioredis';
import { config } from '../config';

/** Exported so a spec can assert a route carries a limit, not only that the guard honours one. */
export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  /**
   * Name of a body field whose value joins the caller's address in the key,
   * so the limit counts attempts on one *account* rather than attempts from
   * one *place*. Sign-in uses 'email'.
   *
   * A class arrives through one venue NAT and shares a single address, so a
   * per-address sign-in limit turns the room away on the twenty-first person:
   * the register and login routes measured 429 at the 21st and 31st caller.
   * Keying on the address and the submitted identity together carries the
   * room while still holding one account to its own allowance, which is the
   * count that stops a password being guessed.
   */
  identityField?: string;
  /**
   * The ceiling on the address alone, checked and counted *before* the
   * identity bucket. It has two jobs: a room-sized brake on a scripted loop
   * (bcrypt is not free), and a bound on the table, since without it an
   * attacker could mint an unlimited number of identity buckets by inventing
   * addresses to sign in as.
   */
  perAddress?: { max: number; windowSeconds: number };
}

export interface RateLimitRule extends RateLimitOptions {
  max: number;
  windowSeconds: number;
}

/** Per-route rate limit: @RateLimit(30, 60) = 30 requests/minute. */
export const RateLimit = (max: number, windowSeconds: number, options: RateLimitOptions = {}) =>
  SetMetadata(RATE_LIMIT_KEY, { max, windowSeconds, ...options } as RateLimitRule);

/**
 * The teacher console's class-wide rule: 60 requests a minute. Every console
 * controller takes it, because its routes fan out over a whole class, and
 * because the halves of one console must not be throttled differently.
 */
export const CONSOLE_RATE_LIMIT = { max: 60, windowSeconds: 60 } as const;

/** Applies CONSOLE_RATE_LIMIT to a controller. */
export const ConsoleRateLimit = () => RateLimit(CONSOLE_RATE_LIMIT.max, CONSOLE_RATE_LIMIT.windowSeconds);

interface Bucket {
  count: number;
  resetAt: number;
}

/** One counter to check: a key, its allowance, and the window it resets on. */
interface RateCheck {
  key: string;
  max: number;
  windowMs: number;
}

/**
 * Longest identity taken into a key. An address is 254 characters at most and
 * anything longer is not one, so this only ever truncates junk, but it is
 * junk an attacker chooses, and it would otherwise be stored verbatim in the
 * bucket table and sent to Redis on every request.
 */
const MAX_IDENTITY_LENGTH = 254;

/**
 * The identity a limited request is acting on, normalised. Guards run before
 * the validation pipe, so this is the raw parsed body: anything that is not a
 * usable string collapses to one shared bucket, which is the right answer for
 * a malformed sign-in: it is still counted, just not given a bucket of its
 * own to hide in.
 */
function identityFrom(body: unknown, field: string): string {
  const raw = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof raw !== 'string') return '-';
  const value = raw.trim().toLowerCase().slice(0, MAX_IDENTITY_LENGTH);
  return value || '-';
}

/** Ordinary cadence: an ended window is reclaimed within half a minute. */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Table size that pulls the next sweep forward, so a burst of one-off callers
 * is reclaimed without waiting out the full interval. Exported for the spec,
 * which has to fill the table past it to exercise the sweep.
 */
export const SWEEP_PRESSURE_SIZE = 10_000;

/** Floor on sweep frequency, so the O(n) pass costs at most one walk a second. */
const SWEEP_MIN_INTERVAL_MS = 1_000;

/**
 * A counter shared by every replica. `hit` returns the caller's position in
 * the current window (1 for the first request), and rejects if the shared
 * store cannot answer: the guard then falls back to its local table rather
 * than failing the request.
 */
export interface RateLimitCounter {
  hit(key: string, windowMs: number): Promise<number>;
  shutdown(): Promise<void>;
}

/** DI token, so a test can substitute a counter without a Redis server. */
export const RATE_LIMIT_COUNTER = 'RATE_LIMIT_COUNTER';

/**
 * A guard on the request path must never become a latency source, so a Redis
 * that is slow, down or unreachable is given this long and then treated as
 * absent for that request.
 */
export const COUNTER_TIMEOUT_MS = 250;

/** Prefix on every counter key, so the queue's keyspace stays legible. */
const KEY_PREFIX = 'rl:';

/**
 * Fixed window in Redis: the first request of a window creates the key and
 * sets its lifetime, and the key's expiry ends the window. One round trip,
 * atomic across replicas, and nothing to sweep: Redis expires the keys.
 */
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

interface HitCommand {
  ratelimithit(key: string, windowMs: string): Promise<number>;
}

export class RedisRateLimitCounter implements RateLimitCounter {
  private readonly logger = new Logger(RedisRateLimitCounter.name);
  private readonly client: Redis & HitCommand;

  constructor(redisUrl: string) {
    this.client = new IORedis(redisUrl, {
      // The guard has its own fallback, so a command must fail rather than
      // wait: an offline queue would hold requests until Redis came back.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: COUNTER_TIMEOUT_MS,
      connectTimeout: COUNTER_TIMEOUT_MS * 4,
    }) as Redis & HitCommand;
    // ioredis throws on an unhandled 'error' event; a Redis blip should cost
    // a logged line and a reconnect, not the process.
    this.client.on('error', (err: Error) => this.logger.warn(`rate-limit redis: ${err.message}`));
    // defineCommand keeps the script cached by SHA and replays it on NOSCRIPT.
    this.client.defineCommand('ratelimithit', { numberOfKeys: 1, lua: HIT_SCRIPT });
  }

  hit(key: string, windowMs: number): Promise<number> {
    return this.client.ratelimithit(`${KEY_PREFIX}${key}`, String(windowMs));
  }

  async shutdown(): Promise<void> {
    // Same reasoning as the queue's close: only a connected client is asked
    // politely, because a QUIT on any other status waits for a reconnect.
    if (this.client.status === 'ready') await this.client.quit().catch(() => undefined);
    this.client.disconnect();
  }
}

/** The parts of an Express request this guard reads. */
interface RequestShape {
  ip?: string;
  method: string;
  url?: string;
  route?: { path?: string };
  body?: unknown;
  user?: { id?: string };
}

/**
 * Counters live in Redis when REDIS_URL is set: the same instance the job
 * queue and the socket adapter already require of a multi-replica deployment,
 * so N replicas share one limit and a deploy does not reset every window.
 * Without REDIS_URL, or whenever Redis will not answer inside
 * COUNTER_TIMEOUT_MS, the counters are this process's own, with two
 * consequences worth stating plainly: behind a load balancer with N replicas
 * the effective limit is N × max, and a restart begins every window again at
 * zero. That is the documented single-replica shape, and it is a tolerable
 * degradation for the coarse abuse brake this is (keeping bcrypt and the AI
 * budget out of reach of a scripted loop): a Redis outage must not turn every
 * login into a 500.
 *
 * Reclaiming memory only ever deletes windows that have already ended.
 * Clearing the whole map at a size ceiling would be a reset button: an
 * attacker who had spent their allowance could flood the table with fresh
 * keys and every live counter, theirs included, would go back to zero.
 * Nothing evicts a window that is still counting, so the table is bounded by
 * the number of distinct callers seen inside one window rather than by a
 * fixed ceiling.
 */
@Injectable()
export class RateLimitGuard implements CanActivate, OnApplicationShutdown {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly buckets = new Map<string, Bucket>();
  private readonly counter: RateLimitCounter | null;
  private lastSweepAt = 0;
  private degraded = false;

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(RATE_LIMIT_COUNTER) counter?: RateLimitCounter,
  ) {
    this.counter = counter ?? (config.redisUrl ? new RedisRateLimitCounter(config.redisUrl) : null);
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const limit = this.reflector.getAllAndOverride<RateLimitRule>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!limit) return true;

    const checks = RateLimitGuard.checksFor(limit, context.switchToHttp().getRequest());

    // The local path stays synchronous so a deployment without Redis adds no
    // microtask to a request that the guard is only counting.
    if (!this.counter) {
      for (const check of checks) this.countLocally(check.key, check.max, check.windowMs);
      return true;
    }
    return this.countShared(checks);
  }

  /**
   * The counters this request has to clear, in the order they are counted.
   * The address ceiling comes first so that a caller who has already exhausted
   * it never reaches (and never creates) an identity bucket.
   */
  private static checksFor(limit: RateLimitRule, request: RequestShape): RateCheck[] {
    const route = `${request.method}:${request.route?.path || request.url}`;
    const address = request.ip || 'anonymous';
    if (!limit.identityField || !limit.perAddress) {
      const who = request.user?.id || address;
      return [{ key: `${who}:${route}`, max: limit.max, windowMs: limit.windowSeconds * 1000 }];
    }
    const identity = identityFrom(request.body, limit.identityField);
    return [
      {
        key: `${address}:${route}`,
        max: limit.perAddress.max,
        windowMs: limit.perAddress.windowSeconds * 1000,
      },
      // '|' cannot appear in an address, so an identity bucket can never
      // collide with the address bucket above it however the identity reads.
      { key: `${address}|${identity}:${route}`, max: limit.max, windowMs: limit.windowSeconds * 1000 },
    ];
  }

  /**
   * Count in the shared store, one key at a time so an exhausted ceiling
   * rejects before the next key is touched. A key the store will not answer
   * for falls back to this process's own table for that key alone.
   */
  private async countShared(checks: RateCheck[]): Promise<boolean> {
    for (const check of checks) {
      let count: number;
      try {
        count = await this.counter!.hit(check.key, check.windowMs);
      } catch (err) {
        if (!this.degraded) {
          this.degraded = true;
          this.logger.warn(
            `rate limit counters fell back to this process only: ${(err as Error).message} ` +
              '(with N replicas the effective limit is now N × max)',
          );
        }
        this.countLocally(check.key, check.max, check.windowMs);
        continue;
      }
      if (this.degraded) {
        this.degraded = false;
        this.logger.log('rate limit counters shared across replicas again');
      }
      if (count > check.max) throw this.rejected();
    }
    return true;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.counter?.shutdown();
  }

  /** True, or a 429: the return type keeps the caller's shape honest. */
  private countLocally(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    this.sweepExpired(now);

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) throw this.rejected();
    return true;
  }

  private rejected(): HttpException {
    return new HttpException('rate limit exceeded — slow down', HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * Sweeping rides the request path rather than a setInterval so the guard
   * holds no timer that outlives the process it belongs to, and the schedule
   * bounds the cost: one walk per 30s idling, one per second under load,
   * however hard the process is being hit in between.
   */
  private sweepExpired(now: number): void {
    const since = now - this.lastSweepAt;
    const due =
      since >= SWEEP_INTERVAL_MS ||
      (this.buckets.size >= SWEEP_PRESSURE_SIZE && since >= SWEEP_MIN_INTERVAL_MS);
    if (!due) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
