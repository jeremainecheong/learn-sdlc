import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { BullQueue } from './bull.queue';
import { InProcessQueue } from './in-process.queue';
import { JobHandler, JobKind, JobPayload, JobQueue } from './job-queue';

/**
 * The async backbone: slow work (sandbox runs, feedback pipelines, model
 * calls) is enqueued and processed off the request path, so web requests stay
 * fast and untrusted code never runs inside a request.
 *
 * Backend is chosen by configuration, and the rest of the app cannot tell the
 * difference: REDIS_URL selects the durable Redis/BullMQ queue (jobs survive a
 * restart and workers scale horizontally); without it, an in-process queue
 * keeps local dev and CI dependency-free.
 */
@Injectable()
export class JobsService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly queue: JobQueue;

  constructor() {
    this.queue = config.redisUrl
      ? new BullQueue(config.redisUrl, config.jobConcurrency, config.jobAttempts)
      : new InProcessQueue(config.jobConcurrency);
    this.logger.log(
      `job queue: ${this.queue.name} (durable: ${this.queue.durable ? 'yes — survives restarts' : 'no — set REDIS_URL for durability'})`,
    );
  }

  /** True when in-flight jobs survive a process restart. */
  get durable(): boolean {
    return this.queue.durable;
  }

  get backendName(): string {
    return this.queue.name;
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.queue.register(kind, handler);
  }

  async enqueue(kind: JobKind, payload: JobPayload): Promise<void> {
    await this.queue.enqueue(kind, payload);
  }

  /** Resolve when no work is outstanding: used by tests. */
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  /** Where this job sits in the line, or null when the backend cannot say. */
  queuePosition(kind: JobKind, id: string): number | null {
    return this.queue.positionOf?.(kind, id) ?? null;
  }

  /**
   * Seconds this job is likely to wait, or null. Never shown as a promise:
   * the caller renders it as "about 40 seconds", and null renders as nothing
   * at all rather than as zero.
   *
   * `ahead` jobs share `jobConcurrency` slots, so the wait is that many
   * batches of a typical job, rounded to ten seconds so the number does not
   * twitch, and floored at ten so it never reads as "about 0 seconds".
   */
  estimateSeconds(kind: JobKind, ahead: number): number | null {
    const median = this.queue.recentDurationMs?.(kind) ?? null;
    if (median === null) return null;
    const batches = Math.ceil(Math.max(ahead, 0) / Math.max(config.jobConcurrency, 1));
    const seconds = (batches * median) / 1000;
    return Math.max(10, Math.round(seconds / 10) * 10);
  }

  /** Bounded backing-store check for health probes. */
  ping(): Promise<void> {
    return this.queue.ping();
  }

  /**
   * Drain in `beforeApplicationShutdown`, which Nest runs *before* every
   * `onApplicationShutdown` hook, including the one that closes the database.
   * Draining later would let the connection close underneath a job that is
   * still writing its result, losing completed work on every deploy.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.logger.log('draining job queue before shutdown…');
    await this.queue.shutdown();
    this.logger.log('job queue drained');
  }
}
