import { describe, expect, it, vi } from 'vitest';
import {
  FAILURE_GRACE_MS,
  MAX_INTERVAL_MS,
  PollTimeoutError,
  PollUnreachableError,
  pollUntil,
} from '@/lib/poll';

/**
 * The watch a learner sits in front of while their submission is graded.
 *
 * Its two failure modes mean opposite things ("the job is slow" and "we
 * cannot see the job") and neither is "the job failed", which is the mistake
 * that made learners resubmit and spend a second attempt on a run that was
 * already going. The clock and the wait are injectable, so a minute and a half
 * of grace costs nothing to test.
 */

/** A clock that only moves when the poll sleeps, and a sleep that only moves it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: (ms: number) => {
      waits.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A wait nothing but a wake can end, so a wake is the only thing under test. */
const neverResolves = () => new Promise<void>(() => {});

/** The socket's side of a wake: hold the resume, and count the teardown. */
function wakeHarness() {
  let resume = () => {};
  const off = vi.fn();
  return {
    off,
    fire: () => resume(),
    subscribe: (r: () => void) => {
      resume = r;
      return off;
    },
  };
}

/** Let the loop's own awaits settle; no timers are involved in these tests. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('pollUntil', () => {
  it('returns the first value that satisfies isDone, without sleeping', async () => {
    const clock = fakeClock();
    const fetcher = vi.fn().mockResolvedValue({ status: 'completed' });

    const value = await pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(value).toEqual({ status: 'completed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(clock.waits).toEqual([]);
  });

  it('keeps asking at the interval until the job is done', async () => {
    const clock = fakeClock();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValue({ status: 'completed' });

    await pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      intervalMs: 1200,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(clock.waits).toEqual([1200, 1200]);
  });

  it('gives up on a job that is merely slow with the last value it saw', async () => {
    const clock = fakeClock();
    const fetcher = vi.fn().mockResolvedValue({ status: 'running' });

    const err = await pollUntil(fetcher, () => false, {
      intervalMs: 1000,
      timeoutMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err).not.toBeInstanceOf(PollUnreachableError);
    expect((err as PollTimeoutError).last).toEqual({ status: 'running' });
    expect((err as Error).message).toContain('still running');
  });

  it('rides out a restart: a run of failed polls is not a failed job', async () => {
    const clock = fakeClock();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({ status: 'completed' });

    const value = await pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      intervalMs: 1200,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(value).toEqual({ status: 'completed' });
    // Four polls: three refusals and the answer. A poller that gave up after
    // three refusals would fail here.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('backs off while the API is down, up to the ceiling', async () => {
    const clock = fakeClock();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      pollUntil(fetcher, () => true, {
        intervalMs: 1200,
        timeoutMs: 60_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow();

    // 1.2s, doubling, and never past the ceiling: thirty learners polling a
    // restarting API every 1.2 s are why it comes back slowly.
    expect(clock.waits.slice(0, 4)).toEqual([1200, 2400, 4800, 9600]);
    expect(Math.max(...clock.waits)).toBe(MAX_INTERVAL_MS);
  });

  it('says the server could not be reached, not that the job failed, after the grace window', async () => {
    const clock = fakeClock();
    const reason = new TypeError('fetch failed');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running' })
      .mockRejectedValue(reason);

    const err = await pollUntil(fetcher, () => false, {
      intervalMs: 1200,
      timeoutMs: 10 * 60_000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PollUnreachableError);
    // Every caller already treats a timeout as "still running", which is what
    // this is, so it stays that class.
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as PollUnreachableError).reason).toBe(reason);
    expect((err as PollUnreachableError).last).toEqual({ status: 'running' });
    expect((err as Error).message).toContain('could not be reached');
  });

  /**
   * A wake is the socket saying "ask now" (`lib/job-signal.ts`). Every test
   * below hands in a `sleep` that never resolves, so nothing but a wake can
   * advance the loop, which is the assertion. The value still comes from the
   * fetcher every time: the signal shortens the wait and is never the answer.
   */
  it('asks again as soon as the wake fires, without waiting out the interval', async () => {
    const signal = wakeHarness();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValue({ status: 'completed' });

    const poll = pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      now: () => 1_000_000,
      sleep: neverResolves,
      wake: signal.subscribe,
    });

    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    signal.fire();

    expect(await poll).toEqual({ status: 'completed' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('remembers a wake that arrives while a fetch is in flight', async () => {
    const signal = wakeHarness();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => {
        // The job finished while this very request was on the wire.
        signal.fire();
        return { status: 'queued' };
      })
      .mockResolvedValue({ status: 'completed' });

    const poll = pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      now: () => 1_000_000,
      sleep: neverResolves,
      wake: signal.subscribe,
    });

    expect(await poll).toEqual({ status: 'completed' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes from the wake when the poll ends, whichever way it ends', async () => {
    const done = wakeHarness();
    await pollUntil(vi.fn().mockResolvedValue({ status: 'completed' }), () => true, {
      now: () => 1_000_000,
      wake: done.subscribe,
    });
    expect(done.off).toHaveBeenCalledTimes(1);

    const clock = fakeClock();
    const gaveUp = wakeHarness();
    const err = await pollUntil(vi.fn().mockResolvedValue({ status: 'running' }), () => false, {
      intervalMs: 1000,
      timeoutMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      wake: gaveUp.subscribe,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(gaveUp.off).toHaveBeenCalledTimes(1);
  });

  /**
   * The backoff is not advisory. A socket that reconnects during an API restart
   * delivers everything it missed at once, and a wake that shortened the
   * backed-off wait would put thirty browsers back on a 1.2 s interval against
   * the API that is still coming up: the thing the backoff exists to prevent.
   */
  it('ignores a wake while the API is not answering, so the backoff is served in full', async () => {
    const signal = wakeHarness();
    const waits: number[] = [];
    const fetcher = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    void pollUntil(fetcher, () => true, {
      intervalMs: 1200,
      now: () => 1_000_000,
      sleep: (ms: number) => {
        waits.push(ms);
        return neverResolves();
      },
      wake: signal.subscribe,
    });

    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([1200]);

    signal.fire();
    signal.fire();
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([1200]);
  });

  /**
   * The other half of that decision, and the half that is a behaviour rather
   * than a suppression: the signal is remembered. A socket that reconnected
   * mid-restart has already told us the job landed, so once the API answers
   * again there is nothing left to wait for.
   *
   * It is written as a guard because nothing else pins it: discarding the flag
   * beside the backed-off sleep instead of keeping it leaves every other test
   * in this file green.
   */
  it('spends a wake from the backoff on the first ordinary wait after the API answers', async () => {
    const signal = wakeHarness();
    const waits: number[] = [];
    let releaseBackoff = () => {};
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValue({ status: 'completed' });

    const poll = pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      intervalMs: 1200,
      now: () => 1_000_000,
      // Only the backed-off wait is ever served. Every ordinary wait after it
      // can be ended by nothing but a wake, which is what makes the last two
      // assertions below about the remembered signal and not about the clock.
      sleep: (ms: number) => {
        waits.push(ms);
        if (waits.length > 1) return neverResolves();
        return new Promise<void>((resolve) => {
          releaseBackoff = resolve;
        });
      },
      wake: signal.subscribe,
    });

    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([1200]);

    // The socket comes back and delivers what it missed. The backed-off wait is
    // still served in full …
    signal.fire();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // … and the signal is kept, so the first wait after the API answers again
    // is the one it shortens: there is no second sleep at all.
    releaseBackoff();
    await flush();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1200]);
    expect(await poll).toEqual({ status: 'completed' });
  });

  /**
   * A wake is a shortcut to the answer and never the answer itself, so
   * subscribing to one must not be able to fail a watch on a job the API has
   * already accepted. Telling a learner their run "could not be checked on"
   * while it runs is the exact mistake this module exists to avoid, and a
   * socket module mocked without one of its exports is enough to cause it.
   */
  it('never fails the watch when the wake refuses to subscribe', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 'completed' });

    const value = await pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      now: () => 1_000_000,
      wake: () => {
        throw new TypeError('No "getSocketState" export is defined on the mock');
      },
    });

    expect(value).toEqual({ status: 'completed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never fails a finished watch when letting go of the wake throws', async () => {
    const value = await pollUntil(vi.fn().mockResolvedValue({ status: 'completed' }), () => true, {
      now: () => 1_000_000,
      wake: () => () => {
        throw new TypeError('the socket has gone');
      },
    });

    expect(value).toEqual({ status: 'completed' });
  });

  /** Regression guard: a poll with no wake keeps its fixed cadence. */
  it('keeps its fixed cadence when no wake is given (regression guard)', async () => {
    const clock = fakeClock();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValue({ status: 'completed' });

    await pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      intervalMs: 1200,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(clock.waits).toEqual([1200, 1200]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('forgives a blip: one failure between two answers starts the grace over', async () => {
    const clock = fakeClock();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('one blip'))
      .mockResolvedValueOnce({ status: 'running' })
      .mockRejectedValueOnce(new TypeError('another, much later'))
      .mockResolvedValue({ status: 'completed' });

    // Long enough between the two blips that a counter which never reset would
    // have given up.
    const value = await pollUntil(fetcher, (v: { status: string }) => v.status === 'completed', {
      intervalMs: FAILURE_GRACE_MS,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(value).toEqual({ status: 'completed' });
  });
});
