import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { ContentService } from '../content/content.service';
import { soleTaskFor } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { strictlyReviewed } from '../../test/strict-evidence-fixture';
import { WorkflowService } from './workflow.service';

/**
 * What a room is told about two doors a teacher's lever can make a phase look
 * open on, when the server would refuse both.
 *
 *  - The answer key. `SolutionService.read` opens only on the strict
 *    gate's own evidence, so the phase detail says when the board reads
 *    passed but that evidence is not in (`solution.awaitingReview`), and no
 *    room draws a door the route refuses. TaskTrackr's normal pass: a
 *    strictly reviewed revision: leaves the field unset.
 *  - A teacher's Unlock early + Pass on a phase AHEAD of the learner
 *    reads passed, and `advance` refuses it because it is not the phase the
 *    learner stands on. The detail says so (`notReachedYet`), and the refusal
 *    names the real reason rather than "must pass", which the phase has.
 */
describe('room doors follow the gate', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let workflow: WorkflowService;
  let learnerId = '';
  let enrollmentId = '';
  let states: PhaseStateEntity[] = [];

  const manager = () => dataSource.manager;
  const phase = (key: string): PhaseStateEntity => states.find((s) => s.phaseKey === key)!;

  /** What a teacher's phase-wide Pass writes: the board, and no revision. */
  const boardPass = (key: string): Promise<unknown> =>
    manager().update(PhaseStateEntity, phase(key).id, {
      status: 'passed',
      passedAt: new Date().toISOString(),
      bestScore: 70,
    });

  /** The learner's own strictly reviewed pass, which `advance` requires. */
  const reviewedPass = async (key: string): Promise<void> => {
    await boardPass(key);
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: phase(key).id,
        userId: learnerId,
        status: 'completed',
        passed: true,
        score: 90,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: strictlyReviewed(soleTaskFor(content.getPhase('tasktrackr', key)).rubric),
      }),
    );
  };

  const standOn = (order: number): Promise<unknown> =>
    manager().update(EnrollmentEntity, enrollmentId, { currentPhaseOrder: order });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
    const learner = await manager().save(
      manager().create(UserEntity, { email: 'doors@class.edu', passwordHash: 'x', displayName: 'doors' }),
    );
    learnerId = learner.id;
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId: learnerId,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
        packVersion: content.getProject('tasktrackr').version,
      }),
    );
    enrollmentId = enrollment.id;
    states = [];
    for (const p of content.getProject('tasktrackr').phases) {
      states.push(
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId,
            userId: learnerId,
            phaseKey: p.key,
            phaseOrder: p.order,
            status: 'in_progress',
            attempts: 0,
            unlockedAt: new Date().toISOString(),
          }),
        ),
      );
    }
  });

  describe('the answer-key door', () => {
    it('says the door is waiting on a review where the board reads passed with no reviewed pass', async () => {
      await standOn(3);
      await boardPass('implementation');
      const detail = await workflow.phaseDetail(learnerId, phase('implementation').id);
      expect(detail.status).toBe('passed');
      expect(detail.solution).toMatchObject({ available: true, awaitingReview: true });
    });

    it('leaves TaskTrackr’s payload exactly as it was once the reviewed pass is in', async () => {
      await standOn(3);
      await reviewedPass('implementation');
      const detail = await workflow.phaseDetail(learnerId, phase('implementation').id);
      // Field for field: no new key on the mainline.
      expect(detail.solution).toEqual({ available: true, files: 4, readAt: null });
      const summary = await workflow.phaseDetail(learnerId, phase('implementation').id, 'summary');
      expect(summary.solution).toEqual({ available: true, files: 4, readAt: null });
    });

    it('adds nothing to a phase that has not passed, whose door no room draws anyway', async () => {
      await standOn(3);
      const detail = await workflow.phaseDetail(learnerId, phase('implementation').id);
      expect(detail.solution).toEqual({ available: true, files: 4, readAt: null });
    });

    it('carries the same answer on the shell’s summaries', async () => {
      await standOn(3);
      await boardPass('implementation');
      const all = await workflow.phaseSummaries(learnerId, 'tasktrackr');
      const implementation = all.find((one) => one.key === 'implementation');
      expect(implementation?.solution).toMatchObject({ awaitingReview: true });
    });
  });

  describe('a phase passed ahead of the learner', () => {
    // "Continue opens here once you reach it" must not be promised over a
    // teacher's board-only Pass, because reaching the phase does not open
    // Continue: the strict gate still wants the learner's own
    // reviewed pass. So the ahead phase names what the gate will want, by the
    // gate's own predicate, and the room can say which of the two it is.
    it('says the phase is not reached yet, and names the reviewed pass the gate will still want', async () => {
      await standOn(3);
      await boardPass('testing');
      const detail = await workflow.phaseDetail(learnerId, phase('testing').id);
      expect(detail.status).toBe('passed');
      expect(detail.notReachedYet).toBe(true);
      expect(detail.evidenceNeeded).toEqual([{ key: '', title: 'Testing' }]);
      const summary = (await workflow.phaseSummaries(learnerId, 'tasktrackr')).find((one) => one.key === 'testing');
      expect(summary?.notReachedYet).toBe(true);
      expect(summary?.evidenceNeeded).toEqual([{ key: '', title: 'Testing' }]);
    });

    it('names no gap where the learner earned their own reviewed pass ahead of time', async () => {
      await standOn(3);
      await reviewedPass('testing');
      const detail = await workflow.phaseDetail(learnerId, phase('testing').id);
      expect(detail.notReachedYet).toBe(true);
      expect('evidenceNeeded' in detail).toBe(false);
    });

    it('keeps each promise once the learner reaches the phase', async () => {
      // Board-only: reaching it leaves the gate wanting the same review.
      await standOn(3);
      await reviewedPass('implementation');
      await boardPass('testing');
      await workflow.advance(learnerId, phase('implementation').id);
      const reached = await workflow.phaseDetail(learnerId, phase('testing').id);
      expect('notReachedYet' in reached).toBe(false);
      expect(reached.evidenceNeeded).toEqual([{ key: '', title: 'Testing' }]);
      await expect(workflow.advance(learnerId, phase('testing').id)).rejects.toThrow(
        'Submit this phase for a strict evidence review before advancing.',
      );
    });

    it('opens Continue on reaching a phase whose own reviewed pass is in', async () => {
      await standOn(3);
      await reviewedPass('implementation');
      await reviewedPass('testing');
      await workflow.advance(learnerId, phase('implementation').id);
      const reached = await workflow.phaseDetail(learnerId, phase('testing').id);
      expect('evidenceNeeded' in reached).toBe(false);
      await workflow.advance(learnerId, phase('testing').id);
      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, { id: enrollmentId });
      expect(enrollment.currentPhaseOrder).toBe(5);
    });

    it('is absent on the phase the learner stands on and on one they have moved past', async () => {
      await standOn(3);
      await reviewedPass('design');
      await reviewedPass('implementation');
      const current = await workflow.phaseDetail(learnerId, phase('implementation').id);
      const past = await workflow.phaseDetail(learnerId, phase('design').id);
      expect('notReachedYet' in current).toBe(false);
      expect('notReachedYet' in past).toBe(false);
    });

    it('is absent on a finished course', async () => {
      await standOn(6);
      await manager().update(EnrollmentEntity, enrollmentId, { completed: true });
      await boardPass('maintenance');
      const detail = await workflow.phaseDetail(learnerId, phase('maintenance').id);
      expect('notReachedYet' in detail).toBe(false);
    });

    it('is still refused by advance, which now names the real reason', async () => {
      await standOn(3);
      await boardPass('testing');
      const refusal = await workflow.advance(learnerId, phase('testing').id).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(BadRequestException);
      // No promise about what reaching it opens: over a board-only Pass the
      // gate still wants a review once the learner gets there.
      expect((refusal as Error).message).toBe(AHEAD_REFUSAL);
      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, { id: enrollmentId });
      expect(enrollment.currentPhaseOrder).toBe(3);
    });

    it('refuses a phase unlocked early and not passed in the same true words', async () => {
      await standOn(3);
      await expect(workflow.advance(learnerId, phase('testing').id)).rejects.toThrow(AHEAD_REFUSAL);
    });

    // The refusal is not raised for every phase that is not the current one,
    // including one the learner has moved past:
    // a phase behind the learner is a retried advance, answered with the
    // enrolment as it stands and nothing written.
    it('answers Continue on a phase the learner has moved past with the enrolment unchanged', async () => {
      await standOn(3);
      await reviewedPass('requirements');
      const view = await workflow.advance(learnerId, phase('requirements').id);
      expect(view.currentPhaseOrder).toBe(3);
      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, { id: enrollmentId });
      expect(enrollment.currentPhaseOrder).toBe(3);
      expect(await manager().count(ReleaseRecordEntity)).toBe(0);
    });
  });
});

const AHEAD_REFUSAL =
  'This phase is ahead of the one you are on, so it cannot be continued from yet. Finish the phase you are on first.';
