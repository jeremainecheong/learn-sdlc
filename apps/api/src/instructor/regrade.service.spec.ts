import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import type { FeedbackReport } from '@learnsdlc/shared';
import { RUNBOOK_OLDER_FORMAT_ROOM, RUNNER_UNAVAILABLE_MESSAGE } from '@learnsdlc/shared';
import * as atomicModule from '../db/atomic';
import { ContentService } from '../content/content.service';
import type { CompiledTask } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  RegradeBatchEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { RunnerUnavailableError, type FeedbackService } from '../feedback/feedback.service';
import type { JobsService } from '../jobs/jobs.service';
import { InstructorCaller } from './cohort-scope';
import { SKIP_REASONS, RegradeService, type TaskRegradeCandidate } from './regrade.service';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { layoutFromManifest } from '../content/legacy-layout';
import { memoryDataSource } from '../../test/support/memory-db';

const OLD_PACK = '0.9.0';

const report = (overall: number, passed: boolean): FeedbackReport => ({
  overall,
  passed,
  passThreshold: 70,
  criteria: [],
  checks: [],
  aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'local' },
  aiReliance: { hintsThisPhase: 0, index: 0 },
  integrity: {
    relianceFlag: false,
    relianceIndex: 0,
    mentorPasteFlag: false,
    noEffortFlag: false,
    note: '',
  },
});

/** What `FeedbackService` throws when the sandbox was never reached. */
const runnerDown = (): Error => new RunnerUnavailableError();

let ids = 0;
/**
 * A submission id that sorts after the one before it.
 *
 * `submissionId()` is time-ordered in the product for exactly this reason:
 * sqlite stores `createdAt` to the second, so every row a test writes lands
 * inside one and both the newest-per-task join (`MAX(CAST(id AS text))`) and
 * `attemptNumbers` (`ORDER BY createdAt, id`) settle the tie on the id.
 */
const orderedId = (): string =>
  `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/**
 * Regrade a phase across a class after a content fix.
 *
 * The three invariants these tests exist to hold are the ones that make a
 * class-wide regrade safe to run without asking anybody: a score never goes
 * down, a pass is never withdrawn, and `attempts` never moves. Everything else
 * here is about the batch not lying; its counters, its one-at-a-time rule,
 * and what it does when the runner is not there.
 */
describe('RegradeService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: RegradeService;
  let gradeSnapshot: jest.Mock;
  let queued: string[];

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let learnerId = '';
  let otherLearnerId = '';
  let testingStateId = '';
  let parentId = '';

  const manager = () => dataSource.manager;
  const state = (id: string) => manager().findOneByOrFail(PhaseStateEntity, { id });
  const batches = () => manager().find(RegradeBatchEntity, {});

  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(
      manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }),
    );

  /** Enrol, the way WorkflowService.enroll materialises a board. */
  async function enrol(userId: string, projectSlug = 'tasktrackr'): Promise<PhaseStateEntity[]> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId, projectSlug, currentPhaseOrder: 1 }),
    );
    const states: PhaseStateEntity[] = [];
    for (const phase of content.getProject(projectSlug).phases) {
      states.push(
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId,
            phaseKey: phase.key,
            phaseOrder: phase.order,
            status: phase.order === 1 ? 'in_progress' : 'locked',
          }),
        ),
      );
    }
    return states;
  }

  const submit = (over: Partial<SubmissionEntity>) =>
    manager().save(
      manager().create(SubmissionEntity, {
        status: 'completed',
        packVersion: OLD_PACK,
        workspaceSnapshot: { 'tests/test_tasks.py': 'def test_x(): pass\n' },
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        ...over,
      }),
    );

  /** Run every job the batch enqueued, in the order the queue took them. */
  const drain = async (): Promise<void> => {
    const ids = [...queued];
    queued.length = 0;
    for (const id of ids) await service.processRegrade({ id });
  };

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
    jest.restoreAllMocks();
    queued = [];
    gradeSnapshot = jest.fn(async () => report(88, true));
    const feedback = { gradeSnapshot } as unknown as FeedbackService;
    const jobs = {
      register: jest.fn(),
      enqueue: jest.fn(async (_kind: string, payload: { id: string }) => {
        queued.push(payload.id);
      }),
    } as unknown as JobsService;
    service = new RegradeService(dataSource, content, feedback, jobs);

    const danaRow = await saveUser({
      email: 'dana@learnsdlc.test',
      displayName: 'Dana Chen',
      role: 'INSTRUCTOR',
    });
    const samRow = await saveUser({ email: 'sam@learnsdlc.test', role: 'INSTRUCTOR' });
    const tuesday = await manager().save(
      manager().create(CohortEntity, {
        name: 'Tuesday class',
        joinCode: 'ABCDEFGH',
        ownerUserId: danaRow.id,
      }),
    );
    const thursday = await manager().save(
      manager().create(CohortEntity, {
        name: 'Thursday class',
        joinCode: 'JKLMNPQR',
        ownerUserId: samRow.id,
      }),
    );
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday.id };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday.id };

    learnerId = (
      await saveUser({ email: 'ada@learnsdlc.test', displayName: 'Ada Lovelace', cohort: tuesday.id })
    ).id;
    otherLearnerId = (
      await saveUser({ email: 'alan@learnsdlc.test', displayName: 'Alan Turing', cohort: thursday.id })
    ).id;

    // Ada: testing submitted once, scored 62 on the old pack, phase open.
    const states = await enrol(learnerId);
    const testing = states.find((row) => row.phaseKey === 'testing')!;
    testingStateId = testing.id;
    await manager().update(PhaseStateEntity, testing.id, {
      status: 'submitted',
      bestScore: 62,
      attempts: 3,
    });
    parentId = (
      await submit({
        phaseStateId: testing.id,
        userId: learnerId,
        score: 62,
        passed: false,
        report: report(62, false),
      })
    ).id;

    // and a second phase with work in it, so a second batch has something to
    // ask for while the first is still running.
    const design = states.find((row) => row.phaseKey === 'design')!;
    await manager().update(PhaseStateEntity, design.id, {
      status: 'submitted',
      bestScore: 55,
      attempts: 1,
    });
    await submit({
      phaseStateId: design.id,
      userId: learnerId,
      score: 55,
      passed: false,
      report: report(55, false),
    });

    // Alan, in another class, with the same shape of work.
    const theirs = await enrol(otherLearnerId);
    const theirTesting = theirs.find((row) => row.phaseKey === 'testing')!;
    await manager().update(PhaseStateEntity, theirTesting.id, {
      status: 'submitted',
      bestScore: 62,
      attempts: 3,
    });
    await submit({
      phaseStateId: theirTesting.id,
      userId: otherLearnerId,
      score: 62,
      passed: false,
      report: report(62, false),
    });
  });

  const dto = (over: Partial<Parameters<RegradeService['start']>[1]> = {}) => ({
    projectSlug: 'tasktrackr',
    phaseKey: 'testing' as const,
    scope: 'stale-pack' as const,
    reason: 'The hidden boundary test was wrong; fixed in 1.0.0.',
    ...over,
  });

  /**
   * A learner pinned to a version whose Deployment is in the older format (TaskTrackr 4.0.0's, a config task with no
   * runbook record): the plan leaves them out with the room's own sentence, so the instructor reads a skip and not a
   * failure; a job planned before a republish moved the pin fails closed with the same sentence.
   */
  describe('a phase the learner\'s pinned version holds in the older format', () => {
    let deploymentStateId = '';
    const pin = async (versionId: string) => {
      const state = await manager().findOneByOrFail(PhaseStateEntity, { id: deploymentStateId });
      await manager().update(EnrollmentEntity, { id: state.enrollmentId }, { projectVersionId: versionId });
    };

    beforeEach(async () => {
      const pinned = new ContentService();
      pinned.installVersions([
        { versionId: 'tasktrackr-5', content: content.getProject('tasktrackr') },
        { versionId: 'tasktrackr-4', content: new ContentService().loadProject(layoutFromManifest(olderTaskTrackrPack()).source) },
      ]);
      const jobs = {
        register: jest.fn(),
        enqueue: jest.fn(async (_kind: string, payload: { id: string }) => { queued.push(payload.id); }),
      } as unknown as JobsService;
      service = new RegradeService(dataSource, pinned, { gradeSnapshot } as unknown as FeedbackService, jobs);
      const deployment = (await manager().find(PhaseStateEntity, { where: { userId: learnerId, phaseKey: 'deployment' } }))[0];
      deploymentStateId = deployment.id;
      await manager().update(PhaseStateEntity, deployment.id, { status: 'submitted', bestScore: 40, attempts: 1 });
      await submit({ phaseStateId: deployment.id, userId: learnerId, score: 40, passed: false, report: report(40, false), workspaceSnapshot: { 'api/Dockerfile': 'FROM python:3.12\n' } });
    });

    it('skips the learner at plan time with the room\'s sentence', async () => {
      await pin('tasktrackr-4');
      const view = await service.preview(dana, dto({ phaseKey: 'deployment', scope: 'everyone' }));
      expect(view.requested).toBe(0);
      expect(view.skipped).toEqual([{ userId: learnerId, displayName: 'Ada Lovelace', reason: RUNBOOK_OLDER_FORMAT_ROOM }]);
      expect(gradeSnapshot).not.toHaveBeenCalled();
    });

    it('counts a job planned before the pin moved as a failure with that sentence, and grades nothing', async () => {
      await pin('tasktrackr-5');
      const started = await service.start(dana, dto({ phaseKey: 'deployment', scope: 'everyone' }));
      expect(started.requested).toBe(1);
      await pin('tasktrackr-4');
      await drain();
      expect(gradeSnapshot).not.toHaveBeenCalled();
      const view = await service.status(dana, started.id);
      expect([view.done, view.failed]).toEqual([0, 1]);
      const fresh = await manager().findOneByOrFail(SubmissionEntity, { regradeOf: (await manager().findOneByOrFail(SubmissionEntity, { phaseStateId: deploymentStateId, regradeOf: IsNull() })).id });
      expect(fresh.error).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
    });
  });

  describe('the dry run', () => {
    it('names who would be re-run and writes nothing at all', async () => {
      const view = await service.preview(dana, dto());
      expect(view.id).toBe('');
      expect(view.requested).toBe(1);
      expect(view.candidates).toEqual([
        {
          userId: learnerId,
          displayName: 'Ada Lovelace',
          phaseStateId: testingStateId,
          // A candidate is a (learner, task) pair, and on a phase
          // whose compiled list is the synthesised sole task that pair is the
          // learner and the empty key; the key the revision already carries.
          taskKey: '',
          taskTitle: content.getPhase('tasktrackr', 'testing').title,
          submissionId: parentId,
          attempt: 1,
          score: 62,
          passed: false,
          packVersion: OLD_PACK,
        },
      ]);
      expect(await batches()).toEqual([]);
      expect(await manager().count(AuditEventEntity)).toBe(0);
      // three: Ada's testing and design attempts, and Alan's testing one.
      expect(await manager().count(SubmissionEntity)).toBe(3);
    });

    it('leaves out a learner whose verdict already came from the pack on disk', async () => {
      await manager().update(
        SubmissionEntity,
        { id: parentId },
        { packVersion: content.getProject('tasktrackr').version },
      );
      const stale = await service.preview(dana, dto());
      expect([stale.requested, stale.skipped]).toEqual([0, []]);
      // and `everyone` is the escape hatch for a fix that did not bump it
      const everyone = await service.preview(dana, dto({ scope: 'everyone' }));
      expect(everyone.requested).toBe(1);
    });

    it('says why each learner it cannot include is left out', async () => {
      await manager().update(SubmissionEntity, { id: parentId }, { workspaceSnapshot: null });
      const view = await service.preview(dana, dto({ scope: 'everyone' }));
      expect(view.requested).toBe(0);
      expect(view.skipped).toEqual([
        { userId: learnerId, displayName: 'Ada Lovelace', reason: SKIP_REASONS.pruned },
      ]);
    });

    it('does not regrade a legacy revision against mutable current execution evidence', async () => {
      await manager().update(SubmissionEntity, { id: parentId }, { contextSnapshot: null });
      const view = await service.preview(dana, dto({ scope: 'everyone' }));
      expect(view.requested).toBe(0);
      expect(view.skipped[0].reason).toBe(SKIP_REASONS.pruned);
      expect(gradeSnapshot).not.toHaveBeenCalled();
    });

    it('leaves out a 2.x Requirements snapshot, read by its file name only, and counts it in the receipt', async () => {
      const requirements = (await manager().find(PhaseStateEntity, { where: { userId: learnerId, phaseKey: 'requirements' } }))[0];
      await submit({
        phaseStateId: requirements.id,
        userId: learnerId,
        score: 40,
        passed: false,
        report: report(40, false),
        workspaceSnapshot: { 'requirements/my-story.md': '# US-4 Overdue report\n' },
      });
      const view = await service.preview(dana, dto({ phaseKey: 'requirements', scope: 'everyone' }));
      expect(view.requested).toBe(0);
      expect(view.skipped).toEqual([{ userId: learnerId, displayName: 'Ada Lovelace', reason: SKIP_REASONS.storySnapshot2x }]);
      expect(SKIP_REASONS.storySnapshot2x).toMatch(/^2\.x snapshot, not regraded/);
      expect(gradeSnapshot).not.toHaveBeenCalled();
    });

    it('a revision whose snapshot turns out to be 2.x at run time is counted as a failure and not graded', async () => {
      const started = await service.start(dana, dto());
      await manager().update(SubmissionEntity, { id: parentId }, { workspaceSnapshot: { 'requirements/my-story.md': '# US-4\n', 'tests/test_tasks.py': 'x' } });
      await drain();
      expect(gradeSnapshot).not.toHaveBeenCalled();
      const view = await service.status(dana, started.id);
      expect([view.done, view.failed]).toEqual([0, 1]);
      const fresh = await manager().findOneByOrFail(SubmissionEntity, { regradeOf: parentId });
      expect(fresh.error).toBe(SKIP_REASONS.storySnapshot2x);
    });

    it('leaves out a phase that is already being graded', async () => {
      await manager().update(SubmissionEntity, { id: parentId }, { status: 'queued' });
      const view = await service.preview(dana, dto({ scope: 'everyone' }));
      expect(view.skipped[0].reason).toBe(SKIP_REASONS.inFlight);
    });

    it('never reaches a learner in a class that is not the caller\'s', async () => {
      const view = await service.preview(sam, dto({ scope: 'everyone' }));
      expect(view.candidates!.map((row) => row.userId)).toEqual([otherLearnerId]);
    });

    it('answers a malformed learner id with the 404 the console expects, not a query error', async () => {
      // Postgres raises on a malformed uuid; the shape check in scopedLearner
      // is what keeps that from surfacing as a 500.
      await expect(
        service.preview(dana, dto({ scope: 'everyone', userId: 'not-a-uuid' })),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.start(dana, dto({ scope: 'everyone', userId: 'not-a-uuid' })),
      ).rejects.toThrow(NotFoundException);
      // and a learner in someone else's class reads the same way as no learner.
      await expect(
        service.preview(sam, dto({ scope: 'everyone', userId: learnerId })),
      ).rejects.toThrow(NotFoundException);
      expect(await batches()).toHaveLength(0);
    });
  });

  describe('running one', () => {
    it('adds a revision beside the old verdict rather than editing it, and raises the score', async () => {
      const started = await service.start(dana, dto());
      expect(started.requested).toBe(1);
      await drain();

      const rows = await manager().find(SubmissionEntity, { where: { phaseStateId: testingStateId } });
      expect(rows).toHaveLength(2);
      // By name, not by time: both rows land inside the one second sqlite
      // stores, so `createdAt` is not an order here.
      const old = rows.find((row) => row.id === parentId)!;
      const fresh = rows.find((row) => row.regradeOf === parentId)!;
      // the old verdict is exactly as it was
      expect([old.id, old.score, old.passed, old.packVersion, old.regradeOf]).toEqual([
        parentId,
        62,
        false,
        OLD_PACK,
        null,
      ]);
      // and the new one points back at it, on the pack that is on disk
      expect([fresh.regradeOf, fresh.regradeBatchId, fresh.status, fresh.score, fresh.passed]).toEqual(
        [parentId, started.id, 'completed', 88, true],
      );
      expect(fresh.packVersion).toBe(content.getProject('tasktrackr').version);
      // the files it was graded on are the ones the old revision kept
      expect(fresh.workspaceSnapshot).toEqual(old.workspaceSnapshot);
      expect(gradeSnapshot.mock.calls[0][1].workspace).toEqual(old.workspaceSnapshot);
      expect(fresh.contextSnapshot).toEqual(old.contextSnapshot);
      expect(gradeSnapshot.mock.calls[0][1]).toMatchObject(old.contextSnapshot!);

      const after = await state(testingStateId);
      expect([after.bestScore, after.status, after.attempts]).toEqual([88, 'passed', 3]);
      expect(after.passedAt).toBeTruthy();

      const finished = await service.status(dana, started.id);
      expect([finished.status, finished.done, finished.failed]).toEqual(['finished', 1, 0]);
      // the one number the finished notice can say something true with
      expect(finished.newPasses).toBe(1);
      expect(finished.finishedAt).toBeTruthy();
    });

    it('re-runs the revision at the clock that revision was graded at', async () => {
      // A testing suite that reads the run clock
      // answers a different question at a different date, so a matrix appealed
      // in September has to be re-run at the day it was submitted on; the
      // same contract `packVersion` already has.
      await manager().update(SubmissionEntity, { id: parentId }, { runClock: '2026-03-01' });

      const started = await service.start(dana, dto());
      await drain();

      expect(gradeSnapshot.mock.calls[0][1].runClock).toBe('2026-03-01');
      const fresh = (
        await manager().find(SubmissionEntity, { where: { phaseStateId: testingStateId } })
      ).find((row) => row.regradeOf === parentId)!;
      expect([fresh.regradeBatchId, fresh.runClock]).toEqual([started.id, '2026-03-01']);
    });

    it('never lowers a score and never withdraws a pass', async () => {
      await manager().update(
        PhaseStateEntity,
        { id: testingStateId },
        { status: 'passed', bestScore: 91, passedAt: '2026-09-01T10:00:00.000Z' },
      );
      gradeSnapshot.mockResolvedValue(report(40, false));

      const started = await service.start(dana, dto());
      await drain();

      const after = await state(testingStateId);
      expect([after.bestScore, after.status, after.attempts]).toEqual([91, 'passed', 3]);
      expect(after.passedAt).toBe('2026-09-01T10:00:00.000Z');
      // nobody newly passed, because nobody's standing moved
      expect((await service.status(dana, started.id)).newPasses).toBe(0);
      // the new verdict is still recorded; it just does not take anything away
      const fresh = await manager().findOneByOrFail(SubmissionEntity, { regradeOf: parentId });
      expect([fresh.score, fresh.passed]).toEqual([40, false]);
      expect((await service.status(dana, started.id)).done).toBe(1);
    });

    it('leaves a learner in another class untouched', async () => {
      await service.start(dana, dto());
      await drain();
      const theirs = await manager().find(SubmissionEntity, { where: { userId: otherLearnerId } });
      expect(theirs).toHaveLength(1);
      expect(theirs[0].regradeOf).toBeNull();
    });

    it('writes one row into the trail per learner, with the reason and both pack versions', async () => {
      const started = await service.start(dana, dto());
      await drain();
      // Sorted by name rather than by time: sqlite stores `createdAt` to the
      // second and both rows land inside one, so time is not an order here.
      const rows = (await manager().find(AuditEventEntity, {})).sort((a, b) =>
        a.event.localeCompare(b.event),
      );
      expect(rows.map((row) => row.event)).toEqual(['phase.regrade', 'regrade.start']);
      const [regrade, start] = rows;
      expect([start.actorUserId, start.targetId]).toEqual([dana.id, started.id]);
      expect([regrade.actorUserId, regrade.subjectUserId, regrade.targetId]).toEqual([
        dana.id,
        learnerId,
        testingStateId,
      ]);
      expect(regrade.reason).toBe(dto().reason);
      expect(regrade.detail).toMatchObject({
        from: 62,
        to: 88,
        packVersionFrom: OLD_PACK,
        packVersionTo: content.getProject('tasktrackr').version,
      });
    });

    it('refuses a reason too short to act on', async () => {
      await expect(service.start(dana, dto({ reason: 'fixed' }))).rejects.toThrow(
        BadRequestException,
      );
      expect(await batches()).toEqual([]);
    });

    it('refuses a batch with nobody in it rather than writing an empty one', async () => {
      await manager().update(SubmissionEntity, { id: parentId }, { workspaceSnapshot: null });
      await expect(service.start(dana, dto({ scope: 'everyone' }))).rejects.toThrow(
        BadRequestException,
      );
      expect(await batches()).toEqual([]);
    });

    it('refuses a second batch for the same class while one is running, by the index', async () => {
      await service.start(dana, dto());
      // A different phase, so this is the class-level rule being enforced and
      // not the per-phase in-flight index standing in for it.
      const second = () => service.start(dana, dto({ phaseKey: 'design' }));
      await expect(second()).rejects.toThrow(ConflictException);
      await expect(second()).rejects.toThrow(
        'A regrade started by Dana Chen is still running. Wait for it to finish.',
      );
      expect(await manager().count(RegradeBatchEntity)).toBe(1);

      // and once it has finished, the class can be regraded again
      await drain();
      await expect(second()).resolves.toMatchObject({ status: 'running' });
      expect(await manager().count(RegradeBatchEntity)).toBe(2);
    });

    it('stops the whole batch when the runner cannot be reached, and changes no phase', async () => {
      gradeSnapshot.mockRejectedValue(runnerDown());
      const started = await service.start(dana, dto());
      await drain();

      const view = await service.status(dana, started.id);
      expect([view.status, view.done, view.failed]).toEqual(['stopped', 0, 0]);
      const after = await state(testingStateId);
      expect([after.bestScore, after.status, after.attempts]).toEqual([62, 'submitted', 3]);
      const fresh = await manager().findOneByOrFail(SubmissionEntity, { regradeOf: parentId });
      expect([fresh.status, fresh.error]).toEqual(['failed', RUNNER_UNAVAILABLE_MESSAGE]);
      // nothing was written about this learner, because nothing happened to them
      expect(
        (await manager().find(AuditEventEntity, {})).map((row) => row.event),
      ).toEqual(['regrade.start']);
    });

    it('counts a revision that could not be re-graded and keeps the old verdict', async () => {
      gradeSnapshot.mockRejectedValue(new Error('the analyzer blew up'));
      const started = await service.start(dana, dto());
      await drain();

      const view = await service.status(dana, started.id);
      expect([view.status, view.done, view.failed]).toEqual(['finished', 0, 1]);
      const old = await manager().findOneByOrFail(SubmissionEntity, { id: parentId });
      expect([old.score, old.passed]).toEqual([62, false]);
      const after = await state(testingStateId);
      expect([after.bestScore, after.status]).toEqual([62, 'submitted']);
    });

    it('keeps a second instructor out of the batch, with a 404', async () => {
      const started = await service.start(dana, dto());
      await expect(service.status(sam, started.id)).rejects.toThrow(NotFoundException);
      await expect(service.status(sam, 'not-a-uuid')).rejects.toThrow(NotFoundException);
    });
  });

  /* ----------------------- several tasks in a phase ---------------------- */

  /**
   * A regrade's unit of work is not *the learner* but *the learner and the
   * task*: a written phase may hold more than one,
   * each with its own newest revision, its own row and its own half of the
   * phase's gate. The four things these tests hold are the four a task grain
   * can break; the candidate list, the task a job grades against, the sentence
   * for a revision whose task has gone, and the phase status two jobs of one
   * phase agree on.
   */
  describe('several tasks in a phase', () => {
    const task = (over: Partial<CompiledTask>): CompiledTask =>
      ({
        taskKey: 'story',
        order: 1,
        required: true,
        signOff: false,
        checkKind: 'markdown',
        artefactType: 'story',
        artefactPath: 'requirements/draft.md',
        title: 'The story',
        brief: '',
        objectives: [],
        owns: ['requirements/draft.md'],
        gradedUnits: [{ kind: 'rule', id: 'story-format' }],
        rubric: { passThreshold: 70, criteria: [] },
        ...over,
      }) as CompiledTask;

    const STORY = task({});
    const SCOPE = task({
      taskKey: 'scope',
      order: 2,
      title: 'The scope note',
      artefactPath: 'requirements/scope.md',
      owns: ['requirements/scope.md'],
      gradedUnits: [{ kind: 'rule', id: 'scope-note' }],
    });
    const SPLIT: CompiledTask[] = [STORY, SCOPE];

    /**
     * Pin the requirements phase to a hand-built two-task list.
     *
     * Hand-built rather than published, so the test does not depend on the
     * publish path; every other phase keeps answering the real accessor, so
     * the sole-task board beside it is the
     * one the rest of this file drives.
     */
    const pinSplit = (tasks: CompiledTask[] = SPLIT): void => {
      const real = content.getTasksForEnrollment.bind(content);
      jest
        .spyOn(content, 'getTasksForEnrollment')
        .mockImplementation((enrollment, key) =>
          key === 'requirements' ? [...tasks] : real(enrollment, key),
        );
    };

    /** One learner's requirements phase, submitted, with a revision per named task. */
    async function splitWork(
      userId: string,
      keys: string[] = ['story', 'scope'],
    ): Promise<{ stateId: string; revisions: Record<string, string> }> {
      const state = await manager().findOneByOrFail(PhaseStateEntity, {
        userId,
        phaseKey: 'requirements',
      });
      await manager().update(
        PhaseStateEntity,
        { id: state.id },
        { status: 'submitted', bestScore: 40, attempts: 2 },
      );
      const revisions: Record<string, string> = {};
      for (const key of keys) {
        revisions[key] = (
          await submit({
            // Ordered ids, because sqlite stores `createdAt` to the second and
            // every revision here lands inside one: the newest-per-task join
            // and `attemptNumbers` both break that tie on the id, exactly as
            // `submissionId()` makes them do in the product.
            id: orderedId(),
            phaseStateId: state.id,
            userId,
            taskKey: key,
            score: 40,
            passed: false,
            report: report(40, false),
          })
        ).id;
      }
      for (const one of SPLIT) {
        await manager().save(
          manager().create(TaskStateEntity, {
            phaseStateId: state.id,
            userId,
            taskKey: one.taskKey,
            status: 'submitted',
            bestScore: 40,
            attempts: 1,
          }),
        );
      }
      return { stateId: state.id, revisions };
    }

    const split = (over: Record<string, unknown> = {}) =>
      dto({ phaseKey: 'requirements' as const, scope: 'everyone' as const, ...over });

    const taskRows = (stateId: string) =>
      manager().find(TaskStateEntity, { where: { phaseStateId: stateId }, order: { taskKey: 'ASC' } });

    it('one candidate per learner per task', async () => {
      const bea = await saveUser({
        email: 'bea@learnsdlc.test',
        displayName: 'Bea Okafor',
        cohort: dana.cohort,
      });
      await enrol(bea.id);
      const ada = await splitWork(learnerId);
      const hers = await splitWork(bea.id);
      pinSplit();

      const view = await service.preview(dana, split());
      expect(view.requested).toBe(4);
      // Learner order first (the email order `plan` already reads in) then
      // task order, so the panel's list and the export read the same way.
      expect(
        (view.candidates as TaskRegradeCandidate[]).map((row) => [
          row.displayName,
          row.taskKey,
          row.taskTitle,
          row.submissionId,
        ]),
      ).toEqual([
        ['Ada Lovelace', 'story', 'The story', ada.revisions.story],
        ['Ada Lovelace', 'scope', 'The scope note', ada.revisions.scope],
        ['Bea Okafor', 'story', 'The story', hers.revisions.story],
        ['Bea Okafor', 'scope', 'The scope note', hers.revisions.scope],
      ]);
      // `attempt` stays the revision number in the learner's own list for the
      // whole phase, because `phase_states.attempts` beside it is a sum over
      // the phase's tasks (a declared looseness of split phases) and the two
      // numbers on one panel have to mean the same thing.
      expect(view.candidates!.map((row) => row.attempt)).toEqual([1, 2, 1, 2]);

      const started = await service.start(dana, split());
      expect(started.requested).toBe(4);
      expect(queued).toHaveLength(4);
      // Each enqueued revision carries its own task's key, so the per-task
      // in-flight index admits all four rather than refusing the second of
      // each pair as a phase that is already being graded.
      const fresh = await manager().find(SubmissionEntity, {
        where: { regradeBatchId: started.id },
      });
      expect(fresh.map((row) => row.taskKey).sort()).toEqual(['scope', 'scope', 'story', 'story']);
      expect(started.skipped).toEqual([]);
    });

    it('a learner who submitted one task of two is skipped for the other, by name', async () => {
      const ada = await splitWork(learnerId, ['story']);
      pinSplit();

      const view = await service.preview(dana, split());
      expect((view.candidates as TaskRegradeCandidate[]).map((row) => row.taskKey)).toEqual([
        'story',
      ]);
      expect(view.skipped).toEqual([
        { userId: learnerId, displayName: 'Ada Lovelace', reason: SKIP_REASONS.noSubmission },
      ]);
      expect(ada.revisions.scope).toBeUndefined();
    });

    it('a revision naming a task the pinned version no longer declares is counted as a failure, by sentence', async () => {
      const ada = await splitWork(learnerId);
      pinSplit();
      const started = await service.start(dana, split());
      const story = (
        await manager().findOneByOrFail(SubmissionEntity, { regradeOf: ada.revisions.story })
      ).id;

      // The pinned version moved between the plan and the job: neither of the
      // two keys it now declares is `story`. Two, because a list of one is a
      // phase with one task and that phase's only task is what a revision of it
      // is about, whatever key the row carries.
      pinSplit([SCOPE, task({ taskKey: 'extra', order: 2, title: 'Something else' })]);
      await service.processRegrade({ id: story });

      const fresh = await manager().findOneByOrFail(SubmissionEntity, { id: story });
      expect([fresh.status, fresh.error]).toEqual(['failed', SKIP_REASONS.unknownTask]);
      expect(gradeSnapshot).not.toHaveBeenCalled();
      // the old verdict is exactly where it was
      const old = await manager().findOneByOrFail(SubmissionEntity, {
        id: ada.revisions.story,
      });
      expect([old.score, old.passed, old.status]).toEqual([40, false, 'completed']);
      const after = await state(ada.stateId);
      expect([after.status, after.bestScore]).toEqual(['submitted', 40]);
      expect((await service.status(dana, started.id)).failed).toBe(1);
    });

    it('the regrade grades a task-scoped revision against its own task', async () => {
      await splitWork(learnerId);
      pinSplit();
      await service.start(dana, split());
      await drain();

      expect(
        gradeSnapshot.mock.calls.map((call) => [
          call[3].taskKey,
          (call[2] as CompiledTask[]).map((one) => one.taskKey),
        ]),
      ).toEqual([
        ['story', ['story', 'scope']],
        ['scope', ['story', 'scope']],
      ]);
    });

    it('a regrade that passes one of two required tasks leaves the phase submitted', async () => {
      // The regrade is a writer of phase status and it writes through the one
      // roll-up: the quantifier is over the pinned version's required keys, so
      // one task's new verdict cannot open a phase its sibling has not passed.
      // With `nextPhaseStatus` here instead, this phase reads `passed` on one
      // task's evidence and `advance` refuses it; the two surfaces
      // disagreeing is the defect.
      const ada = await splitWork(learnerId, ['story']);
      pinSplit();
      const started = await service.start(dana, split());
      await drain();

      const after = await state(ada.stateId);
      expect([after.status, after.passedAt]).toEqual(['submitted', null]);
      expect((await taskRows(ada.stateId)).map((row) => [row.taskKey, row.status])).toEqual([
        ['scope', 'submitted'],
        ['story', 'passed'],
      ]);
      // and nobody newly passed, because no phase opened
      expect((await service.status(dana, started.id)).newPasses).toBe(0);
    });

    it('two regrade jobs for two tasks of one phase leave it passed', async () => {
      const ada = await splitWork(learnerId);
      pinSplit();
      await service.start(dana, split());
      const jobs = [...queued];
      queued.length = 0;

      await Promise.all(jobs.map((id) => service.processRegrade({ id })));

      const after = await state(ada.stateId);
      expect([after.status, after.bestScore]).toEqual(['passed', 88]);
      expect(after.passedAt).toBeTruthy();
      // `attempts` never moves: a regrade is not an attempt, on either row.
      expect(after.attempts).toBe(2);
      expect((await taskRows(ada.stateId)).map((row) => [row.taskKey, row.status, row.attempts])).toEqual(
        [
          ['scope', 'passed', 1],
          ['story', 'passed', 1],
        ],
      );
    });

    it('without the transaction the same two jobs leave the phase shut with every task passed', async () => {
      // The lock has a test rather than a comment. With the read-then-write of
      // the two rows outside one transaction, each job rolls the phase up from
      // a board that cannot see its sibling's task row yet, and both write
      // `submitted` over a phase whose required tasks have all passed;
      // exactly the state nothing later heals.
      jest
        .spyOn(atomicModule, 'atomic')
        .mockImplementation((source, work) => work(source.manager));
      const ada = await splitWork(learnerId);
      pinSplit();
      await service.start(dana, split());
      const jobs = [...queued];
      queued.length = 0;

      await Promise.all(jobs.map((id) => service.processRegrade({ id })));

      const after = await state(ada.stateId);
      expect(after.status).toBe('submitted');
      expect((await taskRows(ada.stateId)).map((row) => row.status)).toEqual(['passed', 'passed']);
    });

    it('a sole-task board yields the candidates it yields today, in order', async () => {
      // TaskTrackr equivalence: the grouping is `(phaseStateId, taskKey)`
      // and every revision of a sole-task phase carries the one key, so the
      // candidate list is row for row and in order the list a grouping by
      // `(phaseStateId)` alone would build.
      const bea = await saveUser({
        email: 'bea@learnsdlc.test',
        displayName: 'Bea Okafor',
        cohort: dana.cohort,
      });
      const hers = await enrol(bea.id);
      const theirTesting = hers.find((row) => row.phaseKey === 'testing')!;
      await manager().update(PhaseStateEntity, theirTesting.id, {
        status: 'submitted',
        bestScore: 50,
      });
      // two revisions, so the newest-per-task grouping has something to decide
      await submit({
        id: orderedId(),
        phaseStateId: theirTesting.id,
        userId: bea.id,
        score: 30,
        passed: false,
        report: report(30, false),
      });
      const newest = await submit({
        id: orderedId(),
        phaseStateId: theirTesting.id,
        userId: bea.id,
        score: 50,
        passed: false,
        report: report(50, false),
      });

      const view = await service.preview(dana, dto({ scope: 'everyone' }));
      expect(
        (view.candidates as TaskRegradeCandidate[]).map((row) => [
          row.displayName,
          row.taskKey,
          row.submissionId,
          row.attempt,
        ]),
      ).toEqual([
        ['Ada Lovelace', '', parentId, 1],
        ['Bea Okafor', '', newest.id, 2],
      ]);
      expect(view.skipped).toEqual([]);
    });

    /**
     * The regrade is the fifth writer of a phase's status, and it is the one
     * that can be asked to re-run a revision from a run that has ended.
     *
     * A quiz paper belongs to an **attempt epoch**; `quiz_attempts.epoch`,
     * stamped at draw from `task_states.resetCount`, which is the column the
     * teacher's audited `task-reset` increments. An instructor regrading a
     * PRE-RESET revision holds a verdict about a paper of a run the learner no
     * longer has: writing it would put the score the reset nulled back on the
     * new run's row and, on a verdict that passes, pass the task on the
     * strength of the very attempt the teacher had just handed back.
     *
     * So the regraded verdict is stored on its own revision (that is the
     * appeal's record and it is written before this transaction opens) and it
     * moves no gate: not the task row, not `bestScore`, not the pass and not
     * the phase roll-up. It is the same rule `FeedbackService.writeVerdict`
     * keeps against the grading job that was in flight when the reset
     * committed, asked through the same one predicate.
     */
    describe('a regraded quiz paper of a run that has ended', () => {
      const QUIZ = task({
        taskKey: 'concepts',
        order: 2,
        required: true,
        checkKind: 'quiz',
        artefactType: 'quiz',
        artefactPath: null,
        title: 'Concept check',
        owns: [],
        gradedUnits: [{ kind: 'question', id: 'q-one' }],
      });

      /**
       * Ada's requirements phase: the artefact task passed, the quiz not, and
       * one quiz revision whose paper is in the record.
       *
       * `resetCount` is the run the ROW is on and `epoch` the run the PAPER is
       * of, taken apart here for the one reason they can differ in the product:
       * a reset landed between the hand-in and this regrade.
       */
      async function quizWork(opts: {
        resetCount: number;
        epoch: number;
        voided?: boolean;
      }): Promise<{ stateId: string; revisionId: string; attemptId: string }> {
        const state = await manager().findOneByOrFail(PhaseStateEntity, {
          userId: learnerId,
          phaseKey: 'requirements',
        });
        await manager().update(
          PhaseStateEntity,
          { id: state.id },
          { status: 'submitted', bestScore: null, attempts: 3 },
        );
        await manager().save(
          manager().create(TaskStateEntity, {
            phaseStateId: state.id,
            userId: learnerId,
            taskKey: 'story',
            status: 'passed',
            bestScore: 90,
            passedAt: '2026-09-19T09:00:00.000Z',
            attempts: 1,
          }),
        );
        await manager().save(
          manager().create(TaskStateEntity, {
            phaseStateId: state.id,
            userId: learnerId,
            taskKey: 'concepts',
            // what a reset leaves behind: open again, and the score nulled
            status: 'in_progress',
            bestScore: null,
            attempts: 3,
            resetCount: opts.resetCount,
          }),
        );
        const revision = await submit({
          id: orderedId(),
          phaseStateId: state.id,
          userId: learnerId,
          taskKey: 'concepts',
          score: 60,
          passed: false,
          report: report(60, false),
        });
        const paper = await manager().save(
          manager().create(QuizAttemptEntity, {
            phaseStateId: state.id,
            userId: learnerId,
            taskKey: 'concepts',
            epoch: opts.epoch,
            projectVersionId: 'v-teacher-quiz',
            packVersion: OLD_PACK,
            submissionId: revision.id,
            paper: [],
            answers: { 'q-one': ['a'] },
            score: 60,
            passed: false,
            startedAt: '2026-09-18T09:00:00.000Z',
            submittedAt: '2026-09-18T09:10:00.000Z',
            voidedAt: opts.voided ? '2026-09-19T09:00:00.000Z' : null,
          }),
        );
        return { stateId: state.id, revisionId: revision.id, attemptId: paper.id };
      }

      /** Run the one job the batch enqueued for the quiz revision. */
      const regradeTheQuiz = async (): Promise<string> => {
        pinSplit([STORY, QUIZ]);
        const started = await service.start(dana, split());
        await drain();
        return started.id;
      };

      const quizRow = (stateId: string) =>
        manager().findOneByOrFail(TaskStateEntity, { phaseStateId: stateId, taskKey: 'concepts' });

      it('moves no gate when the paper is of the run the teacher closed', async () => {
        // Three failed papers, then the teacher's reset: the row is on run 1
        // and the paper under appeal is of run 0.
        const ada = await quizWork({ resetCount: 1, epoch: 0 });
        const batchId = await regradeTheQuiz();

        // The regraded verdict passes, and passes nothing.
        expect(gradeSnapshot).toHaveBeenCalledTimes(1);
        const row = await quizRow(ada.stateId);
        expect(row.status).toBe('in_progress');
        expect(row.passedAt).toBeNull();
        // The number the reset nulled stays null: a `Math.max` against this
        // verdict would put the closed run's score on the open run's row.
        expect(row.bestScore).toBeNull();
        expect(row.resetCount).toBe(1);

        const after = await state(ada.stateId);
        expect(after.status).toBe('submitted');
        expect(after.passedAt).toBeNull();
        expect(after.bestScore).toBeNull();

        // The appeal is still in the record: the regraded revision carries its
        // own verdict, beside the revision it re-ran, which is untouched.
        const fresh = await manager().findOneByOrFail(SubmissionEntity, {
          regradeOf: ada.revisionId,
        });
        expect([fresh.status, fresh.score, fresh.passed]).toEqual(['completed', 88, true]);
        expect(fresh.report!.overall).toBe(88);
        const old = await manager().findOneByOrFail(SubmissionEntity, { id: ada.revisionId });
        expect([old.status, old.score, old.passed]).toEqual(['completed', 60, false]);
        // and the paper is neither rewritten nor voided by the appeal
        const sheet = await manager().findOneByOrFail(QuizAttemptEntity, { id: ada.attemptId });
        expect([sheet.epoch, sheet.score, sheet.voidedAt]).toEqual([0, 60, null]);

        // The batch counted the work and claims no pass it did not open.
        const status = await service.status(dana, batchId);
        expect([status.done, status.failed, status.newPasses]).toEqual([1, 0, 0]);
        // and the trail still carries the appeal
        expect(
          await manager().count(AuditEventEntity, { where: { event: 'phase.regrade' } }),
        ).toBe(1);
      });

      it('moves no gate when the paper the revision names was voided', async () => {
        // The other half of *of no run at all*: a paper a reset closed without
        // a sheet is of the same epoch as the row and is still no evidence.
        const ada = await quizWork({ resetCount: 0, epoch: 0, voided: true });
        await regradeTheQuiz();

        const row = await quizRow(ada.stateId);
        expect([row.status, row.bestScore, row.passedAt]).toEqual(['in_progress', null, null]);
        const after = await state(ada.stateId);
        expect([after.status, after.bestScore]).toEqual(['submitted', null]);
      });

      it('moves the row as a regrade always does when the paper is of the run in progress', async () => {
        // The converse, and the half that must not be lost: nobody reset this
        // task, so the appeal's verdict is of the run the learner is on and it
        // opens the task and the phase exactly as a regrade always has.
        const ada = await quizWork({ resetCount: 0, epoch: 0 });
        const batchId = await regradeTheQuiz();

        const row = await quizRow(ada.stateId);
        expect(row.status).toBe('passed');
        expect(row.bestScore).toBe(88);
        expect(row.passedAt).toEqual(expect.any(String));
        // `attempts` never moves: a regrade is not an attempt, on either row.
        expect(row.attempts).toBe(3);

        const after = await state(ada.stateId);
        expect(after.status).toBe('passed');
        expect(after.passedAt).toBeTruthy();
        // the mean over the required keys: the artefact task's 90 and the 88
        expect(after.bestScore).toBe(89);
        expect((await service.status(dana, batchId)).newPasses).toBe(1);
      });

      it('leaves a regrade of a task that is not a quiz exactly as it was', async () => {
        // The predicate is `isQuizTask`, asked first: a written task has no
        // paper and no epoch, so a reset of ITS row withholds nothing here;
        // the regrade moves it as it always has, and the guard costs it no
        // read of `quiz_attempts` at all.
        const phase = await manager().findOneByOrFail(PhaseStateEntity, {
          userId: learnerId,
          phaseKey: 'requirements',
        });
        await manager().update(
          PhaseStateEntity,
          { id: phase.id },
          { status: 'submitted', bestScore: 40, attempts: 2 },
        );
        await manager().save(
          manager().create(TaskStateEntity, {
            phaseStateId: phase.id,
            userId: learnerId,
            taskKey: 'story',
            status: 'in_progress',
            bestScore: null,
            attempts: 1,
            resetCount: 1,
          }),
        );
        const revision = await submit({
          id: orderedId(),
          phaseStateId: phase.id,
          userId: learnerId,
          taskKey: 'story',
          score: 40,
          passed: false,
          report: report(40, false),
        });

        pinSplit([STORY, QUIZ]);
        await service.start(dana, split());
        await drain();

        const row = await manager().findOneByOrFail(TaskStateEntity, {
          phaseStateId: phase.id,
          taskKey: 'story',
        });
        expect([row.status, row.bestScore]).toEqual(['passed', 88]);
        expect(revision.taskKey).toBe('story');
        // and the phase stays shut on the quiz it still holds
        expect((await state(phase.id)).status).toBe('submitted');
      });

      /**
       * A written task's revision of a
       * run that has ended (stamped by the reset that ended it) moves no
       * gate when it is regraded. The regrade row copies the parent's epoch,
       * and the trail says what happened: of an earlier run, moved no gate.
       */
      it('moves no gate for a written task\'s revision of an earlier run, and says so', async () => {
        const phase = await manager().findOneByOrFail(PhaseStateEntity, {
          userId: learnerId,
          phaseKey: 'requirements',
        });
        await manager().update(
          PhaseStateEntity,
          { id: phase.id },
          { status: 'submitted', bestScore: 40, attempts: 2 },
        );
        await manager().save(
          manager().create(TaskStateEntity, {
            phaseStateId: phase.id,
            userId: learnerId,
            taskKey: 'story',
            status: 'in_progress',
            bestScore: null,
            attempts: 1,
            resetCount: 1,
          }),
        );
        const revision = await submit({
          id: orderedId(),
          phaseStateId: phase.id,
          userId: learnerId,
          taskKey: 'story',
          score: 40,
          passed: false,
          report: report(40, false),
          resetEpoch: 0,
        });

        pinSplit([STORY, QUIZ]);
        await service.start(dana, split());
        await drain();

        const row = await manager().findOneByOrFail(TaskStateEntity, {
          phaseStateId: phase.id,
          taskKey: 'story',
        });
        expect([row.status, row.bestScore]).toEqual(['in_progress', null]);
        const regraded = await manager().findOneByOrFail(SubmissionEntity, {
          regradeOf: revision.id,
        });
        expect(regraded.resetEpoch).toBe(0);
        // the verdict is kept on the new revision: it is the record
        expect(regraded.status).toBe('completed');
        const trail = await manager().findOneByOrFail(AuditEventEntity, { event: 'phase.regrade' });
        expect((trail.detail as Record<string, unknown>).run).toBe('of an earlier run, moved no gate');
      });

      /**
       * A legacy NULL-epoch parent whose
       * run a learner reset ends AFTER `start` read its epoch but BEFORE the
       * regrade row was inserted leaves that row NULL; the reset stamped the
       * parent, and the row did not exist yet. The job takes the parent's
       * (now final) epoch, so the strict gate never reads the regrade as
       * evidence of the current run.
       */
      it('a regrade row inserted after a reset stamped its NULL parent takes the parent\'s epoch', async () => {
        const phase = await manager().findOneByOrFail(PhaseStateEntity, {
          userId: learnerId,
          phaseKey: 'requirements',
        });
        await manager().update(PhaseStateEntity, { id: phase.id }, { status: 'submitted', bestScore: 40, attempts: 2 });
        await manager().save(
          manager().create(TaskStateEntity, {
            phaseStateId: phase.id,
            userId: learnerId,
            taskKey: 'story',
            status: 'in_progress',
            bestScore: null,
            attempts: 1,
            resetCount: 0,
          }),
        );
        const revision = await submit({
          id: orderedId(),
          phaseStateId: phase.id,
          userId: learnerId,
          taskKey: 'story',
          score: 40,
          passed: false,
          report: report(40, false),
          resetEpoch: null,
        });

        pinSplit([STORY, QUIZ]);
        await service.start(dana, split());
        // the race's outcome: the reset committed between start's read of the
        // parent and the regrade row's insert
        await manager().update(SubmissionEntity, { id: revision.id }, { resetEpoch: 0 });
        await manager().update(TaskStateEntity, { phaseStateId: phase.id, taskKey: 'story' }, { resetCount: 1 });
        const queued = await manager().findOneByOrFail(SubmissionEntity, { regradeOf: revision.id });
        expect(queued.resetEpoch).toBeNull();
        await drain();

        const regraded = await manager().findOneByOrFail(SubmissionEntity, { regradeOf: revision.id });
        expect(regraded.resetEpoch).toBe(0);
        const row = await manager().findOneByOrFail(TaskStateEntity, { phaseStateId: phase.id, taskKey: 'story' });
        expect([row.status, row.bestScore]).toEqual(['in_progress', null]);
      });
    });
  });
});
