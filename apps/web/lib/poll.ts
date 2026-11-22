'use client';

import { useEffect, useRef } from 'react';

/** Thrown when the deadline passes with `isDone` still false. */
export class PollTimeoutError extends Error {
  constructor(public readonly last: unknown) {
    super('still running — this is taking longer than usual');
  }
}

/**
 * Thrown when the API could not be reached for the whole grace window.
 *
 * A subclass of {@link PollTimeoutError} on purpose. Every caller already
 * treats that as "still running, we are just not watching any more", and that
 * is exactly what this is: the job was accepted by the API and runs on the
 * queue whatever the browser can see, so a run of failed polls is a statement
 * about this laptop's connection and never about the submission. Rendering it
 * red as "your submission failed" is what made learners resubmit and spend a
 * second attempt on a job that was already running.
 */
export class PollUnreachableError extends PollTimeoutError {
  constructor(
    last: unknown,
    /** The last rejection, kept for the console rather than for the learner. */
    public readonly reason: unknown,
  ) {
    super(last);
    this.message = 'still running — the server could not be reached while it ran';
  }
}

/**
 * How long a run of failed polls is tolerated before the watch is given up.
 *
 * A count of failures is the wrong unit: three consecutive failures at a
 * 1.2 s interval is 4.8 seconds: shorter than any API restart, so a deploy in
 * the middle of a class would tell every learner mid-submission that their
 * work had failed. A duration is the honest unit: ninety seconds covers a
 * restart, a laptop lid, and a lab
 * wifi handover, and nothing is lost by watching longer because the job is on
 * the server either way.
 */
export const FAILURE_GRACE_MS = 90_000;

/** The longest gap between two polls while the API is not answering. */
export const MAX_INTERVAL_MS = 10_000;

/**
 * A job that outlived the ordinary watch is still watched, more slowly: one
 * poll this often, for at most this long, while the page says it is slow.
 */
export const SLOW_POLL_INTERVAL_MS = 5_000;
export const SLOW_POLL_TIMEOUT_MS = 20 * 60_000;

export interface PollOptions {
  /** Gap between polls while the API is answering. */
  intervalMs?: number;
  /** How long the job may stay unfinished before {@link PollTimeoutError}. */
  timeoutMs?: number;
  /** How long the API may stay unreachable before {@link PollUnreachableError}. */
  failureGraceMs?: number;
  /** The ceiling the failure backoff doubles up to. */
  maxIntervalMs?: number;
  /**
   * The clock and the wait, injectable so a test can spend a minute of
   * simulated time without spending a minute. Both default to the real ones.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  /**
   * A subscription that says "ask again now", used to shorten the wait.
   *
   * The value still always comes from `fetcher`, so a wrong or duplicated
   * signal costs one request and never a wrong answer, which is what lets the
   * socket feed it (`lib/job-signal.ts`) while polling stays the source of
   * truth. It is subscribed once, before the first fetch, and unsubscribed
   * however the poll ends.
   */
  wake?: (resume: () => void) => () => void;
}

/**
 * Poll `fetcher` until `isDone`; resolves with the value that satisfied it.
 *
 * Two ways to stop, and they mean different things. `PollTimeoutError` is "the
 * job is taking longer than we said we would wait": the API answered every
 * time and the job is simply slow. `PollUnreachableError` is "we could not ask
 * for ninety seconds": the job is unaffected and only this browser's view of
 * it has gone. Neither is a failed job, which is why both are the same class to
 * a caller: a failure is a value that comes back with `status: 'failed'`, never
 * a rejection from here.
 */
export async function pollUntil<T>(
  fetcher: () => Promise<T>,
  isDone: (value: T) => boolean,
  {
    intervalMs = 1200,
    timeoutMs = 120_000,
    failureGraceMs = FAILURE_GRACE_MS,
    maxIntervalMs = MAX_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    wake,
  }: PollOptions = {},
): Promise<T> {
  const deadline = now() + timeoutMs;
  let last: T | undefined;
  /** When the current run of failures started; null while the API answers. */
  let failingSince: number | null = null;
  let failures = 0;
  /**
   * A wake that has not been spent yet.
   *
   * Sticky because the signal usually lands while a request is already on the
   * wire (the job finished a moment after the answer we are holding was
   * written) and a signal dropped for that reason would cost the learner the
   * whole interval it was meant to save.
   */
  let woken = false;
  /** Ends the current wait early; null while nothing is waiting. */
  let ring: (() => void) | null = null;
  /**
   * Subscribed, and let go of, inside guards of their own.
   *
   * A wake is a shortcut to the answer and never the answer itself, so neither
   * end of it may be able to fail a watch on a job the API has already
   * accepted, that would put "the run could not be checked on" in front of a
   * learner whose run is still going, which is the one thing this module
   * exists to prevent. `lib/job-signal.ts` guards its own socket calls too;
   * this is the backstop for every other wake, including a socket module that
   * a suite has mocked without one of its exports.
   */
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = wake?.(() => {
      woken = true;
      const end = ring;
      ring = null;
      end?.();
    });
  } catch {
    // No wake, then, and the plain cadence below is the whole watch.
  }

  try {
    for (;;) {
      try {
        last = await fetcher();
        failingSince = null;
        failures = 0;
        if (isDone(last)) return last;
      } catch (err) {
        // The job keeps running on the server through a dropped request, so a
        // rejection is no reason to stop watching it. A long enough run of them
        // is, and even then it is reported as "still running", not as failed.
        failures += 1;
        if (failingSince === null) failingSince = now();
        else if (now() - failingSince >= failureGraceMs) throw new PollUnreachableError(last, err);
      }
      if (now() >= deadline) throw new PollTimeoutError(last);
      // Back off while the API is down: thirty learners polling a restarting API
      // every 1.2 s are the reason it comes back slowly.
      const wait =
        failures > 0 ? Math.min(maxIntervalMs, intervalMs * 2 ** (failures - 1)) : intervalMs;
      if (failures > 0) {
        // A wake buys nothing while the API is not answering: the backed-off
        // wait is served in full. A socket that reconnects after a restart
        // delivers everything it missed at once, and honouring those would put
        // every open browser straight back on the 1.2 s interval: against the
        // API the backoff above exists to let come up. It is remembered, not
        // discarded, so the first ordinary wait after the API answers again
        // still gets shortened by it.
        await sleep(wait);
      } else if (woken) {
        woken = false;
      } else {
        // The losing side of the race stays pending: the default sleep is a
        // 1.2 s timer that resolves into a promise nobody is holding.
        await Promise.race([
          sleep(wait),
          new Promise<void>((resolve) => {
            ring = resolve;
          }),
        ]);
        ring = null;
        woken = false;
      }
    }
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // Nothing left to undo, and nothing worth failing a settled watch over.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Coming back on its own                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The first wait after a failure, and the ceiling the retries back off to.
 *
 * Short enough that an API restart in the middle of a class is over before the
 * learner has decided to reload, long enough that thirty browsers waiting on
 * the same restarting API do not become the reason it comes back slowly. The
 * ceiling is the same {@link MAX_INTERVAL_MS} the run poll uses.
 */
export const RECOVERY_FIRST_WAIT_MS = 3_000;

/**
 * Try `retry` again, by itself, while a page is stuck on a failed load.
 *
 * Without it, a page that failed to load stays failed after the API comes
 * back, and a learner whose lab wifi blinked is left reading a red line about
 * a server that is answering again. This is the other half of
 * {@link RetryNotice}: the button
 * stays, because a learner who wants to act now should be able to, and the
 * page also picks itself up.
 *
 * Three things bring it back, in the order they are likely: the browser saying
 * the connection returned, the tab being looked at again, and a wait that
 * doubles from three seconds to ten. `active` is the page's own "I am showing
 * a failure" flag, so nothing polls while anything is on screen.
 */
export function useRecoverWhenBack(
  active: boolean,
  retry: () => void,
  { firstWaitMs = RECOVERY_FIRST_WAIT_MS, maxIntervalMs = MAX_INTERVAL_MS } = {},
): void {
  const latest = useRef(retry);
  latest.current = retry;

  useEffect(() => {
    if (!active) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const again = () => {
      if (stopped) return;
      attempt += 1;
      latest.current();
      schedule();
    };
    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(again, Math.min(maxIntervalMs, firstWaitMs * 2 ** attempt));
    };
    // A connection that has just come back, or a tab the learner has returned
    // to, is worth an immediate attempt rather than waiting out the backoff.
    const now = () => {
      if (document.visibilityState === 'hidden') return;
      attempt = 0;
      again();
    };

    schedule();
    window.addEventListener('online', now);
    document.addEventListener('visibilitychange', now);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', now);
      document.removeEventListener('visibilitychange', now);
    };
  }, [active, firstWaitMs, maxIntervalMs]);
}
