import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DelayedError, Job, Queue, Worker } from 'bullmq';
import IORedis, { Redis } from 'ioredis';
import { captureException } from '../observability/errors';
import { recordJobOutcome, setQueueDepthSource } from '../observability/metrics';
import { JobDeferredUntil, JobHandler, JobKind, JobPayload, JobQueue } from './job-queue';

const QUEUE_NAME = 'learnsdlc-jobs';

/**
 * How long a graceful close may take before the connections are cut. Under
 * compose's stop_grace_period of 60s, leaving room to close the database and
 * exit before SIGKILL.
 */
export const SHUTDOWN_DEADLINE_MS = 50_000;

/**
 * How long the request path waits for Redis to accept a job.
 *
 * `enqueue` is awaited inside the HTTP request that pressed Run or Submit, and
 * ioredis retries a command across a reconnect rather than rejecting it, so a
 * Redis that is down turned both buttons into a request that never answered:
 * no status code, no timeout, nothing for the learner to act on. Three seconds
 * absorbs a restart and still leaves the browser an answer it can show.
 */
export const ENQUEUE_DEADLINE_MS = 3_000;

/** What a learner is told when the queue would not take the work. */
export const QUEUE_UNAVAILABLE_MESSAGE =
  'The grading queue could not be reached, so this could not be started. Your work is saved. Try again in a moment.';

/** BullMQ's own wording for a job that stalled past `maxStalledCount`. */
export const STALLED_OUT_MESSAGE = 'job stalled more than allowable limit';

/**
 * A job BullMQ has given up on: either the last attempt failed, or the job
 * stalled more times than it allows and the handler was never called at all.
 * Nothing else will touch the row after this, so somebody has to write it
 * back: see `setTerminalFailureSink`.
 */
export interface TerminalJobFailure {
  kind: JobKind;
  /** The submission or execution-run row this job carried. */
  id: string;
  reason: 'stalled' | 'attempts-exhausted';
  attempts: number;
  /** BullMQ's message. For the log; never learner-facing. */
  detail: string;
}

export type TerminalFailureSink = (failure: TerminalJobFailure) => void | Promise<void>;

let terminalFailureSink: TerminalFailureSink | null = null;

/**
 * Register who writes a terminally failed job back to the database.
 *
 * The queue has no repositories and must not grow any: it is the one piece of
 * this app that has to keep working while the database is the thing that is
 * broken. So it reports, and `JobRecoveryService` (which already owns the
 * wording for an interrupted job) writes. Same shape as
 * `setQueueDepthSource`, for the same reason.
 */
export function setTerminalFailureSink(sink: TerminalFailureSink | null): void {
  terminalFailureSink = sink;
}

/**
 * How long a worker may hold a job's lock without renewing it, how often each
 * worker looks for jobs whose lock has expired, and how many times one job may
 * be re-delivered that way before BullMQ fails it itself.
 *
 * The defaults are the production numbers. The queue's own spec passes shorter
 * ones, because the stall-out path is otherwise two minutes of waiting to
 * observe one event.
 */
export interface StallTuning {
  lockDuration: number;
  stalledInterval: number;
  maxStalledCount: number;
}

export const PRODUCTION_STALL_TUNING: StallTuning = {
  lockDuration: 30_000,
  stalledInterval: 10_000,
  maxStalledCount: 3,
};

/**
 * Durable queue backed by Redis + BullMQ: the production backend.
 *
 * Why this matters: a submission being graded when the process dies is not
 * lost. BullMQ holds the job in Redis and, once the dead worker's lock
 * expires, marks it stalled and hands it to another worker, which re-runs the
 * handler. Handlers reload state from the database and overwrite their result
 * row, so re-execution is safe. This also lets workers scale horizontally:
 * several API/worker processes share one queue.
 */
export class BullQueue implements JobQueue {
  readonly durable = true;
  readonly name = 'redis-bullmq';

  private readonly logger = new Logger(BullQueue.name);
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private workerConnection: Redis | null = null;

  constructor(
    private readonly redisUrl: string,
    /** Jobs worked at once; JobsService passes JOB_CONCURRENCY as config resolves it. */
    private readonly concurrency: number,
    /** Tries per job; JobsService passes JOB_ATTEMPTS as config resolves it. */
    private readonly attempts: number,
    private readonly enqueueDeadlineMs = ENQUEUE_DEADLINE_MS,
    private readonly stall: StallTuning = PRODUCTION_STALL_TUNING,
  ) {
    // Only the connection BullMQ *blocks* on needs unlimited retries per
    // request (the worker's, below). On the producer that setting is what
    // makes a dead Redis hang the request path instead of failing it, so this
    // one gets a bounded count. The offline queue stays on so a reconnect of
    // a second or two is absorbed rather than answered with a 503; the bound
    // that matters is the deadline in `enqueue`.
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: 3 });
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    // One Redis round trip per scrape and none otherwise, so an idle
    // deployment pays nothing for the gauge.
    setQueueDepthSource(() => this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed'));
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
    if (!this.worker) this.startWorker();
  }

  private startWorker(): void {
    // The worker blocks on its own connection; it must not share the queue's.
    this.workerConnection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job, token?: string) => {
        const handler = this.handlers.get(job.name as JobKind);
        if (!handler) throw new Error(`no handler registered for job kind "${job.name}"`);
        try { await handler(job.data as JobPayload); }
        catch (error) {
          if (error instanceof JobDeferredUntil) {
            await job.moveToDelayed(Math.max(Date.now() + 100, error.timestamp), token);
            throw new DelayedError();
          }
          throw error;
        }
      },
      {
        connection: this.workerConnection,
        concurrency: this.concurrency,
        // A worker that dies mid-job holds its lock for at most this long;
        // afterwards the job is considered stalled and re-delivered.
        lockDuration: this.stall.lockDuration,
        stalledInterval: this.stall.stalledInterval,
        maxStalledCount: this.stall.maxStalledCount,
      },
    );

    this.worker.on('completed', (job) => recordJobOutcome(job.name, 'completed'));
    this.worker.on('failed', (job, err) => {
      recordJobOutcome(job?.name ?? 'unknown', 'failed');
      captureException(err, {
        kind: job?.name,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
      });
      // Metrics and a Sentry event were the whole of this listener, so a job
      // BullMQ gave up on left its row at "queued" or "running" for ever.
      void this.reportTerminalFailure(job, err);
    });
    this.worker.on('stalled', (jobId) =>
      this.logger.warn(`job ${jobId} stalled (a worker died mid-job) — re-queued for retry`),
    );
    this.worker.on('error', (err) => this.logger.error(`queue worker error: ${err.message}`));
  }

  /**
   * Report a job BullMQ has stopped retrying, so its row can be written back.
   *
   * `finishedOn` is BullMQ's own signal: `moveToFailed` sets it only on the
   * branch that does not retry, which covers both ways a job ends for good:
   * the last attempt throwing, and stalling past `maxStalledCount`, where the
   * handler is never called at all and no code of ours has run. Deriving the
   * same answer from `attemptsMade` against `opts.attempts` would be a second,
   * drifting copy of BullMQ's arithmetic.
   */
  private async reportTerminalFailure(job: Job | undefined, err: Error): Promise<void> {
    const sink = terminalFailureSink;
    // No job means BullMQ could not even load it; there is no row to name.
    if (!sink || !job || !job.finishedOn) return;
    const id = (job.data as JobPayload | undefined)?.id;
    if (!id) return;

    const detail = err?.message ?? '';
    const failure: TerminalJobFailure = {
      kind: job.name as JobKind,
      id,
      reason: detail === STALLED_OUT_MESSAGE ? 'stalled' : 'attempts-exhausted',
      attempts: job.attemptsMade,
      detail,
    };
    try {
      await sink(failure);
    } catch (sinkErr) {
      this.logger.error(
        `could not record the terminal failure of ${failure.kind} ${id}: ${(sinkErr as Error).message}`,
      );
    }
  }

  /**
   * Accept work, or say within a bounded time that it could not be accepted.
   *
   * The race is the point. ioredis carries a command across a reconnect rather
   * than rejecting it, which is right for a worker and wrong for the request
   * path: with Redis unreachable, Run and Submit awaited this call for ever
   * and the browser was left with a request that never answered. A rejection
   * here becomes a 503 the learner can act on, and the caller is expected to
   * mark its row failed on the way out.
   */
  async enqueue(kind: JobKind, payload: JobPayload): Promise<void> {
    const added = this.queue.add(kind, payload, {
      // A stable id makes enqueueing idempotent: a retried HTTP request cannot
      // create a duplicate grading job for the same row. (BullMQ forbids ':'.)
      jobId: `${kind}-${payload.id}`,
      attempts: this.attempts,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      deadline = setTimeout(() => resolve('timeout'), this.enqueueDeadlineMs);
    });
    const outcome = await Promise.race([
      added.then(
        () => 'added' as const,
        (err: Error) => err,
      ),
      expiry,
    ]).finally(() => clearTimeout(deadline));

    if (outcome === 'added') return;

    // Nothing is waiting on the add any more; a late rejection would surface
    // as an unhandled rejection and take the process down.
    added.catch(() => undefined);
    const why =
      outcome === 'timeout'
        ? `did not accept the job within ${this.enqueueDeadlineMs}ms`
        : `refused the job: ${outcome.message}`;
    this.logger.error(`queue ${why} (Redis status: ${this.connection.status}) — answering 503`);
    throw new ServiceUnavailableException(QUEUE_UNAVAILABLE_MESSAGE);
  }

  /**
   * Round-trip to Redis so a broken connection surfaces immediately. Health
   * probes must answer fast: a hanging probe is worse than a failing one,
   * because the orchestrator learns nothing until its own timeout fires.
   */
  async ping(): Promise<void> {
    await this.connection.ping();
  }

  /**
   * The durable queue does not say where a job sits. Answering would be a
   * Redis round trip per learner per two seconds for a number nobody in the
   * compose deployment is watching; the learner sees a plain "Queued" instead.
   */
  positionOf(): number | null {
    return null;
  }

  /** No position means no estimate: there is nothing to multiply. */
  recentDurationMs(): number | null {
    return null;
  }

  async onIdle(): Promise<void> {
    for (let i = 0; i < 600; i++) {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
      if ((counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0) === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * close() lets in-flight jobs finish before the worker stops, while Redis
   * answers. When it does not, BullMQ's close ends in a QUIT that ioredis
   * queues behind a reconnect that may never come, and the deploy would sit
   * there until SIGKILL. Past the deadline the connections are cut instead:
   * a job interrupted this way is re-delivered to the next worker, which is
   * the same outcome SIGKILL would have produced, only sooner and logged.
   */
  async shutdown(): Promise<void> {
    // A scrape during shutdown must not touch a queue that is closing.
    setQueueDepthSource(null);

    // Not 'ready' means Redis is not answering, and a graceful worker close
    // waits for the jobs in flight to finish, which cannot happen without the
    // connection they need. Worse, BullMQ only stops its lock-renewal timer
    // once close() gets past that wait (Worker.close -> lockManager.close),
    // and that timer reschedules itself, so it holds the event loop open for
    // ever: measured, a process that called shutdown() in 3 ms and then never
    // exited. Forcing the close skips the wait and stops the timer. The jobs
    // it abandons are re-delivered to the next worker, which is exactly what
    // the deadline branch below already does, only sooner and cleanly.
    const gracefulPossible = this.connection.status === 'ready';

    const graceful = (async () => {
      await this.worker?.close(!gracefulPossible);
      await this.queue.close();
      // BullMQ ends the queue's client itself but leaves the worker's, which
      // it treats as shared. A QUIT on an already-ended client rejects, and
      // that rejection means nothing here.
      await Promise.all(
        [this.workerConnection?.quit(), this.connection.quit()].map((quit) => quit?.catch(() => undefined)),
      );
    })();
    // Not 'ready' means a QUIT cannot be delivered; waiting would only spend
    // the grace period on a queue that will not answer.
    const budget = gracefulPossible ? SHUTDOWN_DEADLINE_MS : 0;
    // The deadline timer has to be cleared on the graceful path too. Left
    // pending it keeps the event loop alive for the whole budget, so a clean
    // stop would still take the full deadline to exit: the opposite of what
    // the deadline is for.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      deadline = setTimeout(() => resolve('timeout'), budget);
    });
    const outcome = await Promise.race([
      graceful.then(
        () => 'closed' as const,
        (err: Error) => err,
      ),
      expiry,
    ]).finally(() => clearTimeout(deadline));

    if (outcome !== 'closed') {
      const why = outcome === 'timeout' ? `did not close within ${budget}ms` : `close failed: ${outcome.message}`;
      this.logger.warn(
        `queue ${why} (Redis status: ${this.connection.status}); ` +
          'cutting connections — any in-flight job is re-delivered to the next worker',
      );
      // The worker's blocking duplicate is BullMQ's; disconnect() is the
      // public way to end it. Not awaited: on a connection that never became
      // ready it waits for a readiness that will not come.
      this.worker?.disconnect().catch(() => undefined);
      // Cutting the sockets below rejects any queued QUIT; that is the
      // expected end of the graceful path now, not an error to surface.
      graceful.catch(() => undefined);
    }

    // Whatever the graceful path managed, nothing of ours may keep
    // reconnecting after this returns: an ended client ignores this, a
    // reconnecting one stops.
    this.workerConnection?.disconnect();
    this.connection.disconnect();
  }
}
