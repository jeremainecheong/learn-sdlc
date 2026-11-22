import type { DemoClockView } from '@learnsdlc/shared';

/**
 * A clock this process can move, so a class seeded in one afternoon reads like
 * a term.
 *
 * Every `createdAt` in `entities.ts` is a TypeORM `@CreateDateColumn`, and
 * TypeORM sends no value for one: `InsertQueryBuilder.createValuesExpression`
 * leaves it undefined so the column's own default fires: `datetime('now')` on
 * sqlite, `now()` on Postgres. Patching `Date` therefore moves half the
 * timestamps and not the other half, which is why this file has a companion:
 * `DemoClockSubscriber` stamps the date columns before the insert, and this
 * file is where it reads the time from.
 *
 * The patch is deliberately blunt (it replaces `globalThis.Date`), so it is
 * fenced in three ways. `DemoService` engages it only on a loopback,
 * non-production API started with `DEMO_CLOCK=true`; a span (`advanceBy`)
 * never moves the clock backwards, and only an explicit instant (`engageAt`)
 * can, which is how the seed starts a term in the past; and `disengage()` puts
 * the original constructor back, which `demo-clock.spec.ts` asserts by
 * identity rather than by behaviour.
 *
 * One consequence belongs next to the patch rather than in a report: a JWT
 * minted before a jump looks expired to `jsonwebtoken`, which reads
 * `Date.now()`. Anything driving this clock has to sign every persona in
 * again after every move (see scripts/seed-class/replay.mjs).
 */

/** The constructor as the process started with it. Never reassigned. */
const RealDate: DateConstructor = globalThis.Date;

/** Milliseconds ahead of the real clock. Zero means the clock is not moved. */
let offsetMs = 0;

/** True while `globalThis.Date` is the patched constructor. */
let installed = false;

/** The real instant, whatever `globalThis.Date` currently is. */
export const realNow = (): number => RealDate.now();

/** What this process believes the time is. */
export const demoNow = (): Date => new RealDate(RealDate.now() + offsetMs);

export const demoOffsetMs = (): number => offsetMs;

export const isDemoClockInstalled = (): boolean => installed;

/**
 * The subclass. Only the zero-argument constructor and `Date.now()` move;
 * `new Date(iso)`, `Date.parse` and `Date.UTC` are the real ones, because a
 * clock that reinterprets a date somebody handed it is a bug, not a demo.
 *
 * `Symbol.hasInstance` is the load-bearing line. Replacing `globalThis.Date`
 * breaks every `value instanceof Date` written against the real constructor,
 * and TypeORM has one on the write path: `DateUtils.mixedDateToUtcDatetimeString`
 * converts a `Date` to the string sqlite stores, and skips anything that is not
 * one. Without this, a date made before the patch (or by any code holding the
 * original constructor) would reach better-sqlite3 as an object and the insert
 * would fail with "SQLite3 can only bind numbers, strings, bigints, buffers, and
 * null". Answering `instanceof` for every real date keeps that conversion
 * exactly as it is: a clock may change what the time is, not how a date is
 * stored.
 */
function patchedDateClass(): DateConstructor {
  class DemoDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(RealDate.now() + offsetMs);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        super(...(args as [any, any, any, any, any, any, any]));
      }
    }

    static now(): number {
      return RealDate.now() + offsetMs;
    }

    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof RealDate;
    }
  }
  return DemoDate as unknown as DateConstructor;
}

/**
 * Move the clock to an absolute instant, in the past or the future.
 *
 * Winding back is the whole point of the seed: a class has to have started
 * five weeks ago for anyone to be idle, and a term written in the future would
 * read as negative idle days the moment the real clock came back. So `at` is
 * the one way the clock goes backwards, and it is a deliberate act by the
 * caller rather than something a span can do by accident.
 */
export function engageAt(at: Date): void {
  setOffset(at.getTime() - RealDate.now());
}

/**
 * Move the clock forward by a span. Never backwards, whatever is passed: a
 * replay walks a term from its first lab day to today, and a negative step
 * would write a submission before the phase that holds it.
 */
export function advanceBy(ms: number): void {
  setOffset(offsetMs + Math.max(0, ms));
}

function setOffset(next: number): void {
  offsetMs = Math.round(next);
  if (!installed) {
    globalThis.Date = patchedDateClass();
    installed = true;
  }
}

/**
 * Put the real clock back. Idempotent, and safe to call when the clock was
 * never engaged, so a test's `afterEach` never has to ask.
 */
export function disengage(): void {
  offsetMs = 0;
  if (installed) {
    globalThis.Date = RealDate;
    installed = false;
  }
}

/** The state a client sees. `engaged` is false while the offset is zero. */
export function demoClockView(): DemoClockView {
  return {
    engaged: installed && offsetMs !== 0,
    now: demoNow().toISOString(),
    offsetMs,
  };
}
