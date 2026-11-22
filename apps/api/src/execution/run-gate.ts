import { ServiceUnavailableException } from '@nestjs/common';
import { AI_BUSY_CODE } from '@learnsdlc/shared';
import { config } from '../config';

/**
 * What a learner is told when the runner is full rather than absent. The
 * absent case has its own sentence (RUNNER_UNAVAILABLE_MESSAGE); this is
 * the other half, and it says the true thing: the code did not run, nothing
 * was lost, and the reason is the rest of the class rather than their work.
 */
export const SANDBOX_BUSY_MESSAGE =
  'The code runner is busy with the rest of the class, so this did not run. ' +
  'Your work is saved. Try again in a moment.';

/**
 * A 503 rather than a 500: the request was fine, the capacity was not, and a
 * retry is the right response. `reason` separates the two refusals for the
 * log: a deadline means the line moved too slowly, a full queue means it was
 * already too long to join.
 */
export class SandboxBusyError extends ServiceUnavailableException {
  constructor(
    readonly reason: 'deadline' | 'queue-full',
    readonly waitedMs: number,
  ) {
    super(SANDBOX_BUSY_MESSAGE);
  }
}

/**
 * The AI gate's half. The model calls queue at a RunGate of their own
 * (OpenAiProvider), and a refusal there is its own error rather than the
 * runner's, so a review refused after its wait is not filed as a provider
 * failure, nor a turn as a model that did not answer. This sentence says
 * what happened.
 */
export const AI_BUSY_MESSAGE =
  'The AI is busy with the rest of the class, so this did not run. ' +
  'Your work is saved. Try again in a minute.';

/**
 * The AI gate's refusal: a 503 with the same two reasons as the runner's, and
 * a body that carries AI_BUSY_CODE beside the sentence so a client can say
 * "busy" by the code (the guided mentor's panel does).
 */
export class AiBusyError extends ServiceUnavailableException {
  constructor(
    readonly reason: 'deadline' | 'queue-full',
    readonly waitedMs: number,
  ) {
    super({ statusCode: 503, error: 'Service Unavailable', code: AI_BUSY_CODE, message: AI_BUSY_MESSAGE });
  }
}

export interface RunGateOptions {
  /**
   * Longest a caller waits for a slot before the gate refuses. Defaults to
   * RUNNER_MAX_WAIT_MS so the single-argument constructor is already bounded.
   */
  maxWaitMs?: number;
  /** Most callers allowed to wait at once; an arrival past it is refused straight away. */
  maxWaiting?: number;
  /**
   * The error a refused caller receives. Defaults to the runner's
   * SandboxBusyError; the AI gate passes its own (AiBusyError) so no code
   * runner sentence can reach a model call.
   */
  busy?: (reason: 'deadline' | 'queue-full', waitedMs: number) => Error;
}

/** A waiter's handles, kept together so a refusal can settle and unschedule it. */
interface Waiter {
  admit: () => void;
  refuse: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  stopListening: (() => void) | null;
}

/**
 * A fair, fixed-size, bounded gate around the sandbox runner.
 *
 * The runner container is sized for a fixed number of concurrent children
 * (docker-compose.yml sets `mem_limit` as the slot count × RUN_MEMORY_MB plus
 * the server, with `pids_limit` to match). The job queue alone cannot enforce
 * that number, because not every sandbox run comes from a job: the incident drill runs the container from the request path, so
 * the cap has to live at the runner call itself: whatever asks for a run
 * (a queued grading job or a learner pressing "Run health check") waits here.
 *
 * Waiters are released in arrival order, so a burst on one route cannot starve
 * the queue behind it indefinitely. Arrival order alone is not enough, though:
 * an unbounded FIFO turns a class-sized burst into requests held open for as
 * long as the burst takes to drain (forty health checks at two slots is about
 * eleven minutes for the last of them, with the browser, the proxy and the
 * learner all giving up somewhere in the middle and retrying into the same
 * line). So the wait carries a deadline and the line carries a ceiling, and a
 * caller past either is told the runner is busy while it still means
 * something.
 */
export class RunGate {
  private inFlight = 0;
  private readonly waiting: Waiter[] = [];
  private readonly maxWaitMs: number;
  private readonly maxWaiting: number;
  private readonly busy: (reason: 'deadline' | 'queue-full', waitedMs: number) => Error;

  constructor(
    private readonly limit: number,
    options: RunGateOptions = {},
  ) {
    if (limit < 1) throw new Error(`RunGate limit must be at least 1, got ${limit}`);
    this.maxWaitMs = options.maxWaitMs ?? config.runnerMaxWaitMs;
    this.maxWaiting = options.maxWaiting ?? config.runnerMaxWaiting;
    this.busy = options.busy ?? ((reason, waitedMs) => new SandboxBusyError(reason, waitedMs));
  }

  /** Number of callers waiting for a slot, for tests and metrics. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Run `work` with a slot held. The slot is released whether the work
   * resolves or throws; a leak here would wedge every later run. Rejects with
   * the gate's busy error (`SandboxBusyError` unless `busy` names another) when
   * no slot arrives inside the deadline, or when the line is already at its
   * ceiling: in both cases `work` is never called.
   */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      // Cancellation can arrive after admission but before this continuation.
      // Work already running owns its cancellation so its slot is not released
      // while an underlying operation is still in flight.
      signal?.throwIfAborted();
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.reject(this.busy('queue-full', 0));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { admit: resolve, refuse: reject, timer: null, stopListening: null };
      // The timer is unref'd so a gate with someone waiting never on its own
      // keeps the process alive past a shutdown, and it is cleared on both
      // exits below so a settled waiter leaves nothing scheduled behind it.
      waiter.timer = setTimeout(() => this.giveUp(waiter), this.maxWaitMs);
      waiter.timer.unref?.();
      this.waiting.push(waiter);
      if (signal) {
        const aborted = () => this.giveUp(waiter, signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        waiter.stopListening = () => signal.removeEventListener('abort', aborted);
        if (signal.aborted) aborted();
      }
    });
  }

  /** The deadline fired: drop this waiter and refuse it, leaving the line intact. */
  private giveUp(waiter: Waiter, error: Error = this.busy('deadline', this.maxWaitMs)): void {
    const at = this.waiting.indexOf(waiter);
    if (at === -1) return;
    this.waiting.splice(at, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    waiter.stopListening?.();
    waiter.stopListening = null;
    waiter.refuse(error);
  }

  private release(): void {
    const next = this.waiting.shift();
    // Hand the slot straight to the next waiter rather than decrementing and
    // letting it re-check: between the two there is no window for a newly
    // arrived caller to jump the line.
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.timer = null;
      next.stopListening?.();
      next.stopListening = null;
      next.admit();
    } else this.inFlight -= 1;
  }
}
