import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { ExecutionRunEntity, SubmissionEntity } from '../db/entities';
import { setTerminalFailureSink } from './bull.queue';
import { JobRecoveryService } from './job-recovery.service';
import type { JobsService } from './jobs.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The row a job leaves behind when nothing else will write it.
 *
 * Boot recovery is the in-process queue's case: work that was queued or
 * running when the process died cannot resume itself. The durable queue's case
 * is the opposite at boot: those jobs are about to be retried, so failing
 * them would destroy work, and only becomes this service's business when
 * BullMQ gives up, which is what `recordTerminalFailure` is for.
 */
describe('JobRecoveryService', () => {
  let dataSource: DataSource;
  let submissions: Repository<SubmissionEntity>;
  let runs: Repository<ExecutionRunEntity>;

  const service = (durable: boolean) =>
    new JobRecoveryService(submissions, runs, { durable, backendName: durable ? 'redis-bullmq' : 'in-process' } as JobsService);

  const addSubmission = (status: SubmissionEntity['status'], extra: Partial<SubmissionEntity> = {}) =>
    submissions.save(submissions.create({ phaseStateId: 'phase-1', userId: 'learner-1', status, ...extra }));

  const addRun = (status: ExecutionRunEntity['status']) =>
    runs.save(runs.create({ phaseStateId: 'phase-1', userId: 'learner-1', kind: 'run', status }));

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    submissions = dataSource.getRepository(SubmissionEntity);
    runs = dataSource.getRepository(ExecutionRunEntity);
  });

  afterAll(async () => {
    setTerminalFailureSink(null);
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.manager.clear(SubmissionEntity);
    await dataSource.manager.clear(ExecutionRunEntity);
    setTerminalFailureSink(null);
  });

  describe('at boot', () => {
    it('fails work the dead process was holding, and leaves finished work alone', async () => {
      const queued = await addSubmission('queued');
      const running = await addRun('running');
      const done = await addSubmission('completed', { score: 88, passed: true });

      await service(false).onApplicationBootstrap();

      expect((await submissions.findOneByOrFail({ id: queued.id })).status).toBe('failed');
      expect((await submissions.findOneByOrFail({ id: queued.id })).error).toContain('Press Submit again');
      expect((await runs.findOneByOrFail({ id: running.id })).status).toBe('failed');
      const untouched = await submissions.findOneByOrFail({ id: done.id });
      expect(untouched.status).toBe('completed');
      expect(untouched.score).toBe(88);
    });

    it('leaves the durable queue its in-flight work, because it is about to be retried', async () => {
      const running = await addSubmission('running');

      await service(true).onApplicationBootstrap();

      expect((await submissions.findOneByOrFail({ id: running.id })).status).toBe('running');
    });
  });

  describe('when the queue gives up on a job', () => {
    it('marks a stalled submission failed with the interrupted message', async () => {
      const row = await addSubmission('running');

      await service(true).recordTerminalFailure({
        kind: 'submission',
        id: row.id,
        reason: 'stalled',
        attempts: 4,
        detail: 'job stalled more than allowable limit',
      });

      const failed = await submissions.findOneByOrFail({ id: row.id });
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('interrupted');
      expect(failed.error).toContain('Press Submit again');
      // BullMQ's own wording says nothing to a learner and names our plumbing.
      expect(failed.error).not.toMatch(/stall|bullmq|redis|job/i);
    });

    it('says the grader kept failing when the attempts ran out, not that the server restarted', async () => {
      const row = await addSubmission('queued');

      await service(true).recordTerminalFailure({
        kind: 'submission',
        id: row.id,
        reason: 'attempts-exhausted',
        attempts: 3,
        detail: 'grading blew up',
      });

      const failed = await submissions.findOneByOrFail({ id: row.id });
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('could not be graded');
      expect(failed.error).not.toContain('restarted');
      expect(failed.error).not.toContain('blew up');
    });

    it('never overwrites a row that already reached a verdict', async () => {
      // A stalled job can be re-delivered while an earlier delivery is still
      // finishing; the verdict that landed in between is the real one.
      const row = await addSubmission('completed', { score: 91, passed: true });

      await service(true).recordTerminalFailure({
        kind: 'submission',
        id: row.id,
        reason: 'stalled',
        attempts: 4,
        detail: 'job stalled more than allowable limit',
      });

      const kept = await submissions.findOneByOrFail({ id: row.id });
      expect(kept.status).toBe('completed');
      expect(kept.score).toBe(91);
      expect(kept.error).toBeNull();
    });

    it('marks an execution run failed too, so the Run panel stops spinning', async () => {
      const row = await addRun('running');

      await service(true).recordTerminalFailure({
        kind: 'run',
        id: row.id,
        reason: 'attempts-exhausted',
        attempts: 3,
        detail: 'runner unavailable',
      });

      expect((await runs.findOneByOrFail({ id: row.id })).status).toBe('failed');
    });
  });
});
