import { firstRejection, runOrdered, settleOrdered } from './run-fanout';

/**
 * The ordered, bounded fan-out one submission's sandbox runs go through.
 *
 * Each job here is a deferred promise the test settles by hand, so the order
 * jobs start in, how many are in flight and the order they finish in are all
 * chosen by the test rather than by a timer.
 */
interface Deferred {
  started: boolean;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
}

function deferredJobs(count: number): { jobs: (() => Promise<string>)[]; held: Deferred[]; startOrder: number[]; inFlight: () => number; peak: () => number } {
  const held: Deferred[] = [];
  const startOrder: number[] = [];
  let running = 0;
  let most = 0;
  const jobs = Array.from({ length: count }, (_, at) => () => {
    startOrder.push(at);
    running += 1;
    most = Math.max(most, running);
    return new Promise<string>((resolve, reject) => {
      held[at] = {
        started: true,
        resolve: (value) => {
          running -= 1;
          resolve(value);
        },
        reject: (reason) => {
          running -= 1;
          reject(reason);
        },
      };
    });
  });
  return { jobs, held, startOrder, inFlight: () => running, peak: () => most };
}

/** Lets every pending callback run, so the helper can start what it is going to start. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('runOrdered: one submission’s runs, bounded and in order', () => {
  it('at fanout 1 jobs start strictly one after another in index order', async () => {
    const { jobs, held, startOrder } = deferredJobs(4);
    const done = runOrdered(jobs, 1);
    for (let at = 0; at < 4; at += 1) {
      await drain();
      // Exactly the jobs before this one, and this one, have started.
      expect(startOrder).toEqual(Array.from({ length: at + 1 }, (_, i) => i));
      held[at].resolve(`r${at}`);
    }
    await expect(done).resolves.toEqual(['r0', 'r1', 'r2', 'r3']);
  });

  it.each([2, 3, 4])('at fanout %i never more than that many in flight', async (fanout) => {
    const { jobs, held, startOrder, inFlight, peak } = deferredJobs(9);
    const done = runOrdered(jobs, fanout);
    // Finish them out of order (always the latest-started job still running),
    // checking the bound after every step.
    const finished = new Set<number>();
    while (finished.size < 9) {
      await drain();
      expect(inFlight()).toBeLessThanOrEqual(fanout);
      const running = startOrder.filter((at) => !finished.has(at));
      const at = running[running.length - 1];
      finished.add(at);
      held[at].resolve(`r${at}`);
    }
    await done;
    expect(peak()).toBe(fanout);
    // Whatever finished first, the jobs were started in index order.
    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('results are returned by index whatever the completion order', async () => {
    const { jobs, held } = deferredJobs(5);
    const done = runOrdered(jobs, 5);
    await drain();
    for (const at of [4, 2, 0, 3, 1]) held[at].resolve(`r${at}`);
    await expect(done).resolves.toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('every started job settles before a rejection is rethrown, and the rethrown one is the lowest index', async () => {
    const { jobs, held } = deferredJobs(4);
    let finished = false;
    const done = runOrdered(jobs, 4).finally(() => {
      finished = true;
    });
    done.catch(() => undefined);
    await drain();
    // The later job fails first; the earlier one fails after; one is still running.
    held[3].reject(new Error('job 3'));
    await drain();
    held[1].reject(new Error('job 1'));
    await drain();
    held[0].resolve('r0');
    await drain();
    expect(finished).toBe(false);
    held[2].resolve('r2');
    await expect(done).rejects.toThrow('job 1');
  });

  it('no job starts after a rejection is seen, so fanout 1 stops where the serial loop stopped', async () => {
    const { jobs, held, startOrder } = deferredJobs(4);
    const done = runOrdered(jobs, 1);
    done.catch(() => undefined);
    await drain();
    held[0].resolve('r0');
    await drain();
    held[1].reject(new Error('job 1'));
    await expect(done).rejects.toThrow('job 1');
    expect(startOrder).toEqual([0, 1]);
  });

  it('a job that throws before returning a promise counts as its rejection', async () => {
    const jobs = [
      async () => 'r0',
      () => {
        throw new Error('sync 1');
      },
      async () => 'r2',
    ];
    await expect(runOrdered(jobs as (() => Promise<string>)[], 3)).rejects.toThrow('sync 1');
  });

  it('an empty list settles at once, and an unbounded fanout starts everything together', async () => {
    await expect(runOrdered([], 1)).resolves.toEqual([]);
    const { jobs, held, startOrder } = deferredJobs(6);
    const done = runOrdered(jobs, Infinity);
    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5]);
    for (const one of held) one.resolve('x');
    await expect(done).resolves.toHaveLength(6);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses fanout %p', (fanout) => {
    expect(() => runOrdered([], fanout)).toThrow(RangeError);
  });
});

describe('settleOrdered: the outcomes, unread, for a caller that decides later', () => {
  it('keeps every outcome by index and does not throw on a rejection', async () => {
    const settled = await settleOrdered(
      [async () => 'a', async () => Promise.reject(new Error('b')), async () => 'c'],
      3,
    );
    expect(settled[0]).toEqual({ status: 'fulfilled', value: 'a' });
    expect(settled[1]).toMatchObject({ status: 'rejected' });
    expect(settled[2]).toEqual({ status: 'fulfilled', value: 'c' });
    expect(firstRejection(settled)?.reason).toEqual(new Error('b'));
  });

  it('leaves a job it never started as no outcome, and firstRejection skips it', async () => {
    const settled = await settleOrdered(
      [async () => Promise.reject(new Error('first')), async () => 'never'],
      1,
    );
    expect(settled).toHaveLength(2);
    expect(settled[1]).toBeUndefined();
    expect(firstRejection(settled)?.reason).toEqual(new Error('first'));
    expect(firstRejection([undefined, { status: 'fulfilled', value: 1 }])).toBeUndefined();
  });
});
