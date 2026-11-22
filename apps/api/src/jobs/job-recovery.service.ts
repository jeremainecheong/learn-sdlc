import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { ExecutionRunEntity, SubmissionEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { setTerminalFailureSink, TerminalJobFailure } from './bull.queue';
import { JobsService } from './jobs.service';

const INTERRUPTED_MESSAGE =
  'This submission was interrupted because the server restarted while it was being graded. ' +
  'Nothing was lost — your workspace is saved. Press Submit again to grade it.';

const GAVE_UP_MESSAGE =
  'This submission could not be graded because the grader kept failing to run it. ' +
  'Nothing was lost — your workspace is saved. Press Submit again, and tell your instructor if it happens twice.';

/** A row nothing has finished writing yet; anything else must not be touched. */
const IN_FLIGHT = In(['queued', 'running']);

/**
 * Reconciliation for jobs that end without their handler writing a row.
 *
 * Two ways that happens, and this service covers both.
 *
 * **The process died.** The in-process queue cannot resume work that was
 * queued or running when the process went away, so on boot every such row is
 * marked failed with an actionable message. Otherwise a learner watches a
 * spinner that never resolves.
 *
 * **The durable queue gave up.** Redis holds the job across a restart, so
 * those rows must be left alone at boot: failing them would destroy work that
 * is about to be redone. But BullMQ also stops retrying eventually: past
 * `maxStalledCount` it fails the job itself without ever calling the handler,
 * and a job whose last attempt throws is not retried again either. Nothing in
 * this app runs at that moment, so the row would sit at "running" until the
 * next restart. `BullQueue` reports those, and the sink registered below
 * writes them back.
 */
@Injectable()
export class JobRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobRecoveryService.name);

  constructor(
    @InjectRepository(SubmissionEntity) private readonly submissions: Repository<SubmissionEntity>,
    @InjectRepository(ExecutionRunEntity) private readonly runs: Repository<ExecutionRunEntity>,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.jobs.durable) {
      // The durable queue owns retry: a job whose worker died is re-delivered
      // once its lock expires, so failing these rows here would destroy work
      // that is about to be redone. What it does not own is the end of the
      // line, which is what the sink is for.
      setTerminalFailureSink((failure) => this.recordTerminalFailure(failure));
      this.logger.log(
        `durable queue (${this.jobs.backendName}) — interrupted jobs are retried; ` +
          'a job the queue gives up on is marked failed as it happens',
      );
      return;
    }

    const stranded = { status: IN_FLIGHT };

    const submissions = await this.submissions.update(stranded, {
      status: 'failed',
      error: INTERRUPTED_MESSAGE,
    });
    const runs = await this.runs.update(stranded, { status: 'failed', error: 'This run was interrupted by a server restart. Your saved work is unchanged. Press Run again.' });

    const total = (submissions.affected || 0) + (runs.affected || 0);
    if (total > 0) {
      this.logger.warn(
        `recovered ${submissions.affected || 0} interrupted submission(s) and ` +
          `${runs.affected || 0} interrupted run(s) from a previous process — marked failed so learners can retry`,
      );
    }
  }

  /**
   * Write back a job the queue has given up on.
   *
   * Scoped to a row still queued or running, always: a stalled job can be
   * re-delivered while an earlier delivery is still finishing, and a verdict
   * that landed in between must never be overwritten by this. The same guard
   * makes the write idempotent if the sink is somehow called twice.
   */
  async recordTerminalFailure({ kind, id, reason, attempts, detail }: TerminalJobFailure): Promise<void> {
    const why =
      reason === 'stalled'
        ? 'stalled out (its worker kept dying mid-job)'
        : `failed on all ${attempts} attempt(s)`;

    const affected =
      kind === 'submission'
        ? (
            await this.submissions.update(
              { id, status: IN_FLIGHT },
              { status: 'failed', error: reason === 'stalled' ? INTERRUPTED_MESSAGE : GAVE_UP_MESSAGE },
            )
          ).affected
        : (await this.runs.update({ id, status: IN_FLIGHT }, { status: 'failed', error: 'The run could not finish after repeated worker failures. Your saved work is unchanged. Press Run again.' })).affected;

    if (affected) {
      this.logger.warn(`${kind} ${id} ${why} — marked failed so the learner can retry (${detail})`);
    } else {
      // Not a problem: the handler got there first, which is the common case
      // for a stall that resolved on a later delivery.
      this.logger.log(`${kind} ${id} ${why}, but its row had already been written`);
    }
  }

  /**
   * Nest runs this after the queue has drained. Leaving a sink pointed at
   * repositories whose connection is closing would turn a late failure event
   * into a database error on the way out.
   */
  onApplicationShutdown(): void {
    if (this.jobs.durable) setTerminalFailureSink(null);
  }
}
