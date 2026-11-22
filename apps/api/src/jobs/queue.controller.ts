import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { QueuePositionView } from '@learnsdlc/shared';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { ExecutionRunEntity, SubmissionEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { JobsService } from './jobs.service';
import { QueuePositionQuery } from './queue.dto';

/**
 * Where a learner's own job sits in the line.
 *
 * This is a route the waiting screen polls rather than a field on
 * `ExecutionRunView` or `SubmissionView`, for two reasons: the number would
 * otherwise only be as fresh as whatever last refetched the row, and putting
 * it on the views would tie the queue to `toView` in two other services.
 *
 * A position is not a status. The row's own `status` says whether the work is
 * queued, running or finished; the queue says how many jobs the scheduler
 * would start first. A row that is queued but absent from the queue (the
 * restart case `JobRecoveryService` reconciles) honestly answers `ahead: null`,
 * and the screen prints a plain "Queued".
 */
@Controller('queue')
@UseGuards(RateLimitGuard)
export class QueueController {
  constructor(
    private readonly jobs: JobsService,
    @InjectRepository(ExecutionRunEntity)
    private readonly runs: Repository<ExecutionRunEntity>,
    @InjectRepository(SubmissionEntity)
    private readonly submissions: Repository<SubmissionEntity>,
  ) {}

  /**
   * A poll every two seconds for two minutes is sixty, so 120 a minute leaves
   * a screen that reconnects room to catch up without letting a script walk
   * the id space.
   */
  @RateLimit(120, 60)
  @Get('position')
  async position(
    @CurrentUser() user: AuthUser,
    @Query() query: QueuePositionQuery,
  ): Promise<QueuePositionView> {
    // Ownership before anything is said. Without this the route is an oracle
    // for whether an id exists and for how busy other people are, which is a
    // thing a learner can watch their whole class through.
    const status = await this.statusOfOwnedRow(user.id, query);
    if (!status) throw new NotFoundException('nothing queued with that id');

    const state = status === 'queued' || status === 'running' ? status : 'done';
    const kind = query.kind === 'run' ? 'run' : 'submission';
    const ahead = state === 'queued' ? this.jobs.queuePosition(kind, query.id) : null;
    return {
      state,
      ahead,
      estimateSeconds: ahead === null ? null : this.jobs.estimateSeconds(kind, ahead),
    };
  }

  /** The row's status, or null when it is not this learner's row. */
  private async statusOfOwnedRow(
    userId: string,
    query: QueuePositionQuery,
  ): Promise<string | null> {
    // An id that is not a uuid is a 404, not a 500: Postgres rejects the
    // comparison outright and sqlite simply matches nothing, and "check what
    // you asked for" is the same answer either way.
    try {
      if (query.kind === 'run') {
        const run = await this.runs.findOne({
          where: { id: query.id, userId },
          select: { id: true, status: true },
        });
        return run?.status ?? null;
      }
      const submission = await this.submissions.findOne({
        where: { id: query.id, userId },
        select: { id: true, status: true },
      });
      return submission?.status ?? null;
    } catch {
      return null;
    }
  }
}
