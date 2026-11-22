/**
 * The ordered, bounded fan-out that one submission's sandbox runs go through.
 *
 * A review's runs are independent jobs (each a fresh machine with its own
 * bytes), so how many of them run at once changes the learner's wait and
 * nothing else, provided three things hold. This helper is where they hold:
 *
 * - **Jobs start in index order**, at most `fanout` at a time. The caller's
 *   list is the serial order, so the runner is asked for the same jobs in
 *   the same order; only when each starts moves.
 * - **Results come back by index**, never by completion, so the report reads
 *   them in the serial order however the machines finished.
 * - **A failure reads as it did.** Every job that started is allowed to
 *   settle, so nothing is left unhandled, and `runOrdered` rethrows the
 *   rejection with the **lowest index**. Once any rejection is seen, no
 *   further job is started. At fanout 1 that is exactly the serial loop
 *   (it stopped at the first failure), and at any fanout the lowest-index
 *   rejection is the one the serial loop would have met first, because every
 *   job before it had already started.
 *
 * `fanout` is a positive whole number or `Infinity` (start everything at
 * once, as `Promise.allSettled` over a mapped list does).
 */

export type OrderedJob<T> = () => Promise<T>;

/** One job's outcome, or `undefined` for a job never started because an earlier rejection was seen. */
export type OrderedOutcome<T> = PromiseSettledResult<T> | undefined;

function checkFanout(fanout: number): void {
  if (!(fanout === Infinity || (Number.isInteger(fanout) && fanout >= 1))) {
    throw new RangeError(`fanout must be a positive whole number or Infinity, not ${fanout}`);
  }
}

/**
 * Run the jobs, at most `fanout` at once, and hand back every outcome by
 * index without reading or rethrowing any. For a caller that decides later
 * whether a result is read at all (a Testing review's speculative mutants).
 */
export function settleOrdered<T>(jobs: readonly OrderedJob<T>[], fanout: number): Promise<OrderedOutcome<T>[]> {
  checkFanout(fanout);
  const outcomes: OrderedOutcome<T>[] = new Array(jobs.length).fill(undefined);
  return new Promise((resolve) => {
    let next = 0;
    let running = 0;
    let refused = false;
    const pump = (): void => {
      while (!refused && running < fanout && next < jobs.length) {
        const at = next;
        next += 1;
        running += 1;
        let started: Promise<T>;
        try {
          started = Promise.resolve(jobs[at]());
        } catch (reason) {
          started = Promise.reject(reason);
        }
        started
          .then(
            (value) => {
              outcomes[at] = { status: 'fulfilled', value };
            },
            (reason: unknown) => {
              outcomes[at] = { status: 'rejected', reason };
              refused = true;
            },
          )
          .then(() => {
            running -= 1;
            pump();
          });
      }
      if (running === 0) resolve(outcomes);
    };
    pump();
  });
}

/** The lowest-index rejection among the outcomes, if any. */
export function firstRejection<T>(outcomes: readonly OrderedOutcome<T>[]): PromiseRejectedResult | undefined {
  return outcomes.find((outcome): outcome is PromiseRejectedResult => outcome?.status === 'rejected');
}

/**
 * Run the jobs, at most `fanout` at once, and return their results by index;
 * if any rejected, rethrow the lowest-index rejection once every started job
 * has settled.
 */
export function runOrdered<T>(jobs: readonly OrderedJob<T>[], fanout: number): Promise<T[]> {
  checkFanout(fanout);
  return settleOrdered(jobs, fanout).then((outcomes) => {
    const failed = firstRejection(outcomes);
    if (failed) throw failed.reason;
    return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
  });
}
