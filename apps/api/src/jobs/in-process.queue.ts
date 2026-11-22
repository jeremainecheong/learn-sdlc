import { Logger } from '@nestjs/common';
import { recordJobOutcome } from '../observability/metrics';
import { JobHandler, JobKind, JobPayload, JobQueue } from './job-queue';

/**
 * How many recent durations an estimate is drawn from. Twenty is
 * a lab's worth of runs: long enough that one slow outlier does not move the
 * median, short enough that the number still describes the class in the room
 * rather than the one before it.
 */
export const DURATION_SAMPLES = 20;

/**
 * Below this many samples there is no estimate at all. A median of two data
 * points is a guess with a number on it, and a wrong number beside a queue is
 * worse than no number.
 */
export const DURATION_MINIMUM = 5;

/** The bucket jobs that name no owner share. Never a real user id. */
const UNOWNED = '';

/**
 * Dependency-free queue for local development and CI.
 *
 * Bounded concurrency keeps slow work (sandbox runs, model calls, feedback
 * pipelines) off the request path. It is NOT durable: work in flight when the
 * process dies is lost, which is why JobRecoveryService reconciles stranded
 * rows to a failed state on boot. Set REDIS_URL to get the durable backend.
 *
 * Dispatch is round robin over owners rather than first in, first out.
 * Otherwise a learner who presses Run ten times would put ten jobs in front
 * of everybody else's first one, which is exactly the shape a class of forty
 * makes at the same moment. Arrival order inside one owner is untouched, and
 * a job with no owner shares one turn with the other unowned jobs: it is
 * never worse off than under first in, first out.
 */
export class InProcessQueue implements JobQueue {
  readonly durable = false;
  readonly name = 'in-process';

  private readonly logger = new Logger(InProcessQueue.name);
  private readonly handlers = new Map<JobKind, JobHandler>();
  /** One arrival-ordered queue per owner. An owner with no work is deleted. */
  private readonly queues = new Map<string, { kind: JobKind; payload: JobPayload }[]>();
  /** Owner ids in the order they get their next turn. */
  private turns: string[] = [];
  /** Pending jobs across every owner, kept so drain() stays a cheap loop. */
  private pendingCount = 0;
  /** Milliseconds the last few completed jobs of each kind took. */
  private readonly durations = new Map<JobKind, number[]>();
  private active = 0;
  private idleResolvers: (() => void)[] = [];
  private draining = false;

  constructor(private readonly concurrency = 2) {}

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  async enqueue(kind: JobKind, payload: JobPayload): Promise<void> {
    if (this.draining) throw new Error('queue is shutting down');
    const owner = payload.ownerId || UNOWNED;
    let queue = this.queues.get(owner);
    if (!queue) {
      queue = [];
      this.queues.set(owner, queue);
      // A new owner joins the back of the rotation: the people already
      // waiting keep the places they were given.
      this.turns.push(owner);
    }
    queue.push({ kind, payload });
    this.pendingCount += 1;
    setImmediate(() => this.drain());
  }

  /** Take the next job the rotation offers, and rotate. */
  private take(): { kind: JobKind; payload: JobPayload } | null {
    while (this.turns.length > 0) {
      const owner = this.turns.shift()!;
      const queue = this.queues.get(owner);
      if (!queue || queue.length === 0) {
        this.queues.delete(owner);
        continue;
      }
      const job = queue.shift()!;
      this.pendingCount -= 1;
      if (queue.length > 0) this.turns.push(owner);
      else this.queues.delete(owner);
      return job;
    }
    return null;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pendingCount > 0) {
      const next = this.take();
      if (!next) break;
      const { kind, payload } = next;
      const handler = this.handlers.get(kind);
      if (!handler) {
        this.logger.error(`no handler registered for job kind "${kind}"`);
        continue;
      }
      this.active += 1;
      const startedAt = Date.now();
      handler(payload)
        // Counted here as well as in the durable queue so a dashboard reads
        // the same series whichever backend a deployment runs.
        .then(() => {
          recordJobOutcome(kind, 'completed');
          this.recordDuration(kind, Date.now() - startedAt);
        })
        .catch((err) => {
          recordJobOutcome(kind, 'failed');
          this.logger.error(`job ${kind}:${payload.id} failed: ${(err as Error).stack || err}`);
        })
        .finally(() => {
          this.active -= 1;
          if (this.active === 0 && this.pendingCount === 0) {
            for (const resolve of this.idleResolvers.splice(0)) resolve();
          }
          this.drain();
        });
    }
  }

  /**
   * Only jobs that finished are sampled. A job that failed in a second is a
   * true measurement of nothing a learner is waiting for, and letting those
   * into the median would tell the class the line is short when it is not.
   */
  private recordDuration(kind: JobKind, ms: number): void {
    const samples = this.durations.get(kind) ?? [];
    samples.push(ms);
    if (samples.length > DURATION_SAMPLES) samples.splice(0, samples.length - DURATION_SAMPLES);
    this.durations.set(kind, samples);
  }

  /**
   * How many jobs the scheduler would start before this one. 0 means next in
   * line. Null for a job that is not pending: it is running, it is finished,
   * or it was never here (the restart case JobRecoveryService reconciles).
   *
   * Walks the same rotation `take()` would, without moving it.
   */
  positionOf(kind: JobKind, id: string): number | null {
    const turns = [...this.turns];
    const cursors = new Map<string, number>();
    let ahead = 0;
    while (turns.length > 0) {
      const owner = turns.shift()!;
      const queue = this.queues.get(owner);
      if (!queue) continue;
      const at = cursors.get(owner) ?? 0;
      const job = queue[at];
      if (!job) continue;
      if (job.kind === kind && job.payload.id === id) return ahead;
      ahead += 1;
      cursors.set(owner, at + 1);
      if (at + 1 < queue.length) turns.push(owner);
    }
    return null;
  }

  /** The median of the last few completed jobs of this kind, or null. */
  recentDurationMs(kind: JobKind): number | null {
    const samples = this.durations.get(kind) ?? [];
    if (samples.length < DURATION_MINIMUM) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  async onIdle(): Promise<void> {
    if (this.active === 0 && this.pendingCount === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  /** Nothing to reach: the queue lives in this process. */
  async ping(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.draining = true;
    await this.onIdle();
  }
}
