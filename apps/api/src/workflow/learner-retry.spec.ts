import 'reflect-metadata';
import { ConflictException, Logger, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { EMPTY_STORY, SOLE_TASK_KEY, serialiseStory } from '@learnsdlc/shared';
import { PhasesController } from './phases.controller';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent, StoryChecks } from '../content/content.types';
import { writtenPhase } from '../../test/quiz-fixture';
import { strictlyReviewed } from '../../test/strict-evidence-fixture';
import {
  COMPILER_IDENTITY,
  compilePack,
  editablePathsOf,
  gradedUnitsOf,
  soleTaskFor,
  type AuthoredTask,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskResetEntity,
  TaskStateEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { phaseRollup, taskRollup } from '../feedback/checkers';
import { RESET_REFUSALS, RETRY_REFUSALS, retryKeeps } from './learner-reset';
import { evidenceNeededAt, requiredTasksWithoutEvidence } from './strict-gate';
import { WorkflowService } from './workflow.service';
import { legacyDesignPhase } from '../../test/legacy-design-phase';

/**
 * The learner's retry of a phase (or task) they have completed, through the
 * same two routes as "Start this task over". One test per rule of the brief,
 * on a real sqlite schema: what a retry puts back and what it keeps, the
 * sole-task path on TaskTrackr, the signed-off path, the refusals that stay,
 * the later phases and the completion record left as they were, and the
 * strict gate asking for a new reviewed pass before the task counts again.
 */
const SHIPPED = 'tasktrackr';
const TEACHER = 'ms-tan-retry';
const V_FLAT = 'v-flat';
const V_TEACHER = 'v-teacher';

describe('the learner retry of a completed phase', () => {
  let dataSource: DataSource;
  let enrollments: Repository<EnrollmentEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let submissions: Repository<SubmissionEntity>;
  let taskStates: Repository<TaskStateEntity>;
  let releases: Repository<ReleaseRecordEntity>;
  let content: ContentService;
  let workflow: WorkflowService;
  let shipped: ProjectContent;
  let teacher: ProjectContent;
  let written: PhaseContent;
  let E0: string;
  let E1: string;
  const learner = 'learner-retry';
  const PASSED_AT = '2026-10-20T09:00:00.000Z';
  const PHASE_PASSED_AT = '2026-10-21T09:00:00.000Z';

  const inherited = (project: ProjectContent): Record<string, AuthoredTask[]> =>
    Object.fromEntries(
      project.phases.map((phase) => [
        phase.key,
        [{ taskKey: 'main', order: 1, owns: editablePathsOf(phase), gradedUnits: gradedUnitsOf(phase) }],
      ]),
    );

  const taskLike = (over: Partial<CompiledTask>): CompiledTask => ({ ...soleTaskFor(written), ...over });

  /** One phase split as given; every other phase its inherited `main`. */
  const installAt = (key: string, split: CompiledTask[]): void => {
    const main = compilePack(teacher, { authored: inherited(teacher) }).phases;
    const phases: CompiledPhaseTasks[] = main.map((entry) =>
      entry.key === key ? { key: entry.key, tasks: split } : entry,
    );
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      {
        versionId: V_FLAT,
        content: shipped,
        compiler: COMPILER_IDENTITY,
        phases: shipped.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] })),
      },
      { versionId: V_TEACHER, content: teacher, compiler: COMPILER_IDENTITY, phases },
    ]);
    workflow = new WorkflowService(
      enrollments,
      phaseStates,
      releases,
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
  };
  const install = (split: CompiledTask[]): void => installAt('design', split);

  /** Exclusive: `story` owns E0, `scope` owns E1. Both required. */
  const exclusive = (over: Partial<CompiledTask> = {}) => [
    taskLike({ taskKey: 'story', order: 1, title: 'The story', owns: [E0], ...over }),
    taskLike({ taskKey: 'scope', order: 2, title: 'The scope note', owns: [E1] }),
  ];

  /** Design is the phase the learner stands on, Requirements passed behind them. */
  const enrol = async (slug = TEACHER): Promise<Record<string, string>> => {
    const view = await workflow.enroll(learner, slug);
    const ids: Record<string, string> = Object.fromEntries(view.phases.map((phase) => [phase.key, phase.id]));
    await phaseStates.update(ids.requirements, { status: 'passed', passedAt: PHASE_PASSED_AT });
    await phaseStates.update(ids.design, { status: 'in_progress', unlockedAt: new Date().toISOString() });
    await enrollments.update({ id: view.id }, { currentPhaseOrder: 2 });
    return ids;
  };

  /** The task row (minted if the board never got one) as a pass leaves it. */
  const passTask = async (phaseStateId: string, taskKey: string, over: Partial<TaskStateEntity> = {}) => {
    await dataSource
      .createQueryBuilder()
      .insert()
      .into(TaskStateEntity)
      .values({ phaseStateId, taskKey, userId: learner })
      .orIgnore()
      .execute();
    await taskStates.update(
      { phaseStateId, taskKey },
      { status: 'passed', passedAt: PASSED_AT, bestScore: 90, attempts: 2, ...over },
    );
  };
  const passPhase = (id: string) =>
    phaseStates.update(id, { status: 'passed', passedAt: PHASE_PASSED_AT, bestScore: 90, attempts: 3 });

  const row = (phaseStateId: string, taskKey: string) => taskStates.findOneByOrFail({ phaseStateId, taskKey });
  const phaseRow = (id: string) => phaseStates.findOneByOrFail({ id });
  const version = async (id: string) => (await phaseRow(id)).workspaceUpdatedAt ?? null;
  const enrolment = () => enrollments.findOneByOrFail({ userId: learner });
  /** A row as a comparison reads it: every column but the clock the ORM moves. */
  const asStored = <T extends { updatedAt?: Date }>(value: T) => {
    const { updatedAt: _ignored, ...rest } = value;
    return rest;
  };

  /** A strictly reviewed pass of `task`, carrying `resetEpoch`. */
  const strictPass = (phaseStateId: string, task: CompiledTask, resetEpoch: number | null) =>
    submissions.save(
      submissions.create({
        phaseStateId,
        userId: learner,
        taskKey: task.taskKey,
        status: 'completed',
        passed: true,
        score: 90,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: strictlyReviewed(task.rubric),
        resetEpoch,
      } as Partial<SubmissionEntity>),
    );

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    enrollments = dataSource.getRepository(EnrollmentEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    submissions = dataSource.getRepository(SubmissionEntity);
    taskStates = dataSource.getRepository(TaskStateEntity);
    releases = dataSource.getRepository(ReleaseRecordEntity);
    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject(SHIPPED);
    const storyOver = (phase: PhaseContent): PhaseContent => {
      const documents = legacyDesignPhase(phase);
      const record = 'design/story.json';
      return {
        ...documents,
        artifactKind: 'story',
        checks: { ...(writtenPhase().checks as StoryChecks), record },
        files: [...documents.files, { path: record, content: serialiseStory(EMPTY_STORY), editable: true, language: 'json' }],
      };
    };
    teacher = {
      ...shipped,
      slug: TEACHER,
      title: 'TaskTrackr (Ms Retry)',
      version: '1.0.0',
      phases: shipped.phases.map((phase) => (phase.key === 'design' ? storyOver(phase) : phase)),
    };
    written = teacher.phases.find((phase) => phase.key === 'design')!;
    [E0, E1] = editablePathsOf(written);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the plan', () => {
    it('on a passed task names the files put back and says the earlier pass and every attempt are kept', async () => {
      install(exclusive());
      const ids = await enrol();
      await workflow.saveWorkspace(learner, ids.design, { [E0]: 'story words', [E1]: 'scope words' });
      await passTask(ids.design, 'story');

      const plan = await workflow.planTaskReset(learner, ids.design, 'story');

      expect(plan).toEqual({
        restores: [E0],
        reseeds: [],
        protectedBy: [],
        dropsPendingProposal: false,
        refusal: null,
        retry: {
          wholePhase: false,
          keeps: retryKeeps({ wholePhase: false, signedOff: false, movedOn: false, completed: false }),
        },
      });
      expect(plan.retry!.keeps).toBe(
        'Your earlier pass, its date, your best score and every attempt stay in your history. ' +
          'This task counts as passed again once a new submission passes the same review.',
      );
    });

    it('on a task that has not passed is a plain start-over, with no retry', async () => {
      install(exclusive());
      const ids = await enrol();
      expect((await workflow.planTaskReset(learner, ids.design, 'story')).retry).toBeNull();
    });

    it('names each further thing a retry keeps: a signature, the phases opened since, a finished project', () => {
      expect(retryKeeps({ wholePhase: true, signedOff: true, movedOn: true, completed: true })).toBe(
        'Your earlier pass, its date, your best score and every attempt stay in your history. ' +
          "Your teacher's signature stays with that earlier pass. " +
          'The phases you have opened since stay open. ' +
          'Your project stays complete. ' +
          'This phase counts as passed again once a new submission passes the same review.',
      );
      // moved on but not finished: the project cannot complete until this passes again
      expect(retryKeeps({ wholePhase: false, signedOff: false, movedOn: true, completed: false })).toBe(
        'Your earlier pass, its date, your best score and every attempt stay in your history. ' +
          'The phases you have opened since stay open. ' +
          'You need to pass it again before you can complete the project. ' +
          'This task counts as passed again once a new submission passes the same review.',
      );
    });
  });

  describe('a retry of a passed task on an authored list', () => {
    it('puts the task back in progress for a new attempt and keeps its pass date, best score, attempts and every revision', async () => {
      install(exclusive());
      const ids = await enrol();
      const saved = await workflow.saveWorkspace(learner, ids.design, { [E0]: 'story words', [E1]: 'scope words' });
      await passTask(ids.design, 'story');
      await passTask(ids.design, 'scope');
      await passPhase(ids.design);
      const earlier = await submissions.save(
        submissions.create({ phaseStateId: ids.design, userId: learner, taskKey: 'story', status: 'completed', passed: true }),
      );

      const result = await workflow.resetTask(learner, ids.design, 'story', saved.version);

      expect(result.workspace).toEqual({ [E1]: 'scope words' });
      const after = await row(ids.design, 'story');
      expect([after.status, after.passedAt, after.bestScore, after.attempts, after.resetCount]).toEqual([
        'in_progress', PASSED_AT, 90, 2, 1,
      ]);
      expect(after.resetAt).toEqual(expect.any(String));
      // the board: the task is being retried, and its earlier pass is still on it
      expect(result.task).toMatchObject({ key: 'story', status: 'in_progress', passedAt: PASSED_AT, bestScore: 90, attempts: 2 });
      expect(result.task.resetAt).toEqual(after.resetAt);
      // the sibling is untouched
      expect((await row(ids.design, 'scope')).status).toBe('passed');
      // a required task comes off the gate, so the phase row comes down with it, keeping its pass date and score
      const phase = await phaseRow(ids.design);
      expect([phase.status, phase.passedAt, phase.bestScore, phase.attempts]).toEqual(['in_progress', PHASE_PASSED_AT, 90, 3]);
      // nothing is deleted: the earlier revision is kept, stamped with the run that ended
      const kept = await submissions.find({ where: { phaseStateId: ids.design } });
      expect(kept.map((one) => [one.id, one.resetEpoch])).toEqual([[earlier.id, 0]]);
      // the bytes the retry put back are kept as a copy
      const copies = await dataSource.manager.find(TaskResetEntity);
      expect(copies.map((copy) => [copy.taskStateId, copy.files])).toEqual([[after.id, { [E0]: 'story words' }]]);
    });

    it('an optional task retried leaves the phase row passed', async () => {
      install([exclusive()[0], { ...exclusive()[1], required: false }]);
      const ids = await enrol();
      await passTask(ids.design, 'story');
      await passTask(ids.design, 'scope');
      await passPhase(ids.design);
      await workflow.resetTask(learner, ids.design, 'scope', await version(ids.design));
      expect((await row(ids.design, 'scope')).status).toBe('in_progress');
      const phase = await phaseRow(ids.design);
      expect([phase.status, phase.passedAt]).toEqual(['passed', PHASE_PASSED_AT]);
    });

    it('a signed-off task may be retried: the signature stays with the earlier pass, and the plan says so', async () => {
      install(exclusive({ signOff: true }));
      const ids = await enrol();
      await passTask(ids.design, 'story', { signedOffBy: 'teacher-1', signedOffAt: PASSED_AT });

      const plan = await workflow.planTaskReset(learner, ids.design, 'story');
      expect(plan.refusal).toBeNull();
      expect(plan.retry!.keeps).toContain("Your teacher's signature stays with that earlier pass.");

      await workflow.resetTask(learner, ids.design, 'story', await version(ids.design));
      const after = await row(ids.design, 'story');
      expect([after.status, after.signedOffBy, after.signedOffAt, after.passedAt]).toEqual([
        'in_progress', 'teacher-1', PASSED_AT, PASSED_AT,
      ]);
      // a sign-off task is passed only by a countersignature: the old one does not stand in for a new one
      const tasks = content.getTasksForEnrollment(await enrolment(), 'design');
      const story = tasks.find((one) => one.taskKey === 'story')!;
      await taskStates.update({ id: after.id }, { status: 'passed' });
      await strictPass(ids.design, story, 0);
      const missing = await requiredTasksWithoutEvidence(dataSource.manager, { id: ids.design }, tasks, learner);
      expect(missing.map((one) => one.taskKey)).toContain('story');
    });
  });

  describe('refusals on a passed task, each one sentence, nothing written', () => {
    const unchanged = async (id: string, key: string) => {
      const kept = await row(id, key);
      expect([kept.status, kept.resetCount]).toEqual(['passed', 0]);
      expect(await dataSource.manager.count(TaskResetEntity)).toBe(0);
    };

    it('a teacher review pending still refuses', async () => {
      install(exclusive());
      const ids = await enrol();
      await passTask(ids.design, 'story', { awaitingSignOff: true });
      expect((await workflow.planTaskReset(learner, ids.design, 'story')).refusal).toBe(RETRY_REFUSALS.awaitingSignOff);
      await expect(workflow.resetTask(learner, ids.design, 'story', null)).rejects.toBeInstanceOf(ConflictException);
      await unchanged(ids.design, 'story');
    });

    it('a submission of the task still being checked', async () => {
      install(exclusive());
      const ids = await enrol();
      await passTask(ids.design, 'story');
      await submissions.save(submissions.create({ phaseStateId: ids.design, userId: learner, taskKey: 'story', status: 'running' }));
      const plan = await workflow.planTaskReset(learner, ids.design, 'story');
      expect(plan.refusal).toBe(RETRY_REFUSALS.submissionInFlight);
      expect(plan.retry).not.toBeNull();
      await expect(workflow.resetTask(learner, ids.design, 'story', null)).rejects.toThrow(RETRY_REFUSALS.submissionInFlight);
      await unchanged(ids.design, 'story');
    });

    it('a run still going, when the task owns the phase\'s execution', async () => {
      install(exclusive());
      const ids = await enrol();
      await phaseStates.update(ids.implementation, { status: 'in_progress' });
      await passTask(ids.implementation, 'main');
      await dataSource.manager.save(dataSource.manager.create(ExecutionRunEntity, {
        phaseStateId: ids.implementation, userId: learner, kind: 'run', status: 'queued',
      } as never));
      await expect(workflow.resetTask(learner, ids.implementation, 'main', null)).rejects.toThrow(RETRY_REFUSALS.runInFlight);
      await unchanged(ids.implementation, 'main');
    });

    it('a quiz stays refused: a quiz is reset by the teacher', async () => {
      install([
        ...exclusive(),
        taskLike({ taskKey: 'concepts', order: 3, required: false, checkKind: 'quiz', artefactType: 'quiz' as never, owns: [] }),
      ]);
      const ids = await enrol();
      await passTask(ids.design, 'concepts');
      await expect(workflow.resetTask(learner, ids.design, 'concepts', null)).rejects.toThrow(RESET_REFUSALS.quiz);
      await unchanged(ids.design, 'concepts');
    });
  });

  describe('grading integrity and the gates', () => {
    /** Implementation as the phase the learner stands on, its `main` passed on strictly reviewed work. */
    const onImplementation = async () => {
      install(exclusive());
      const ids = await enrol();
      await passPhase(ids.design);
      await enrollments.update({ userId: learner }, { currentPhaseOrder: 3 });
      await phaseStates.update(ids.implementation, { status: 'in_progress', unlockedAt: PASSED_AT });
      const tasks = content.getTasksForEnrollment(await enrolment(), 'implementation');
      const main = tasks.find((one) => one.taskKey === 'main')!;
      await passTask(ids.implementation, 'main');
      await passPhase(ids.implementation);
      await strictPass(ids.implementation, main, null);
      const gaps = () => requiredTasksWithoutEvidence(dataSource.manager, { id: ids.implementation }, tasks, learner);
      return { ids, tasks, main, gaps };
    };

    it('the earlier pass does not count again: a teacher\'s board Pass does not stand in, and a new reviewed pass does', async () => {
      const { ids, main, gaps } = await onImplementation();
      expect(await gaps()).toEqual([]); // guard: the earlier pass was evidence

      await workflow.resetTask(learner, ids.implementation, 'main', await version(ids.implementation));

      await expect(workflow.advance(learner, ids.implementation)).rejects.toThrow('This phase must pass before advancing.');
      // a board-only pass (a teacher's Pass writes the rows, no revision)
      await taskStates.update({ phaseStateId: ids.implementation, taskKey: 'main' }, { status: 'passed' });
      await phaseStates.update(ids.implementation, { status: 'passed' });
      expect((await gaps()).map((one) => one.taskKey)).toEqual(['main']);
      await expect(workflow.advance(learner, ids.implementation)).rejects.toThrow('strict evidence review');
      // a new reviewed pass of the new run
      await strictPass(ids.implementation, main, 1);
      expect(await gaps()).toEqual([]);
    });

    it('a new pass moves the task\'s passedAt and the board through the graders\' own roll-ups', async () => {
      const { ids, tasks } = await onImplementation();
      await workflow.resetTask(learner, ids.implementation, 'main', await version(ids.implementation));
      const held = await row(ids.implementation, 'main');
      const now = '2026-10-31T10:00:00.000Z';
      const task = taskRollup(held, tasks[0], { passed: true, overall: 95 }, now);
      expect(task).toMatchObject({ status: 'passed', passedAt: now, bestScore: 95 });
      const phase = phaseRollup(await phaseRow(ids.implementation), tasks, [{ ...held, ...task }], { passed: true, overall: 95 }, now);
      expect(phase.status).toBe('passed');
      // a failed new attempt keeps the earlier pass on the task
      expect(taskRollup(held, tasks[0], { passed: false, overall: 40 }, now)).toMatchObject({
        status: 'submitted', passedAt: PASSED_AT, bestScore: 90,
      });
    });
  });

  describe('later phases and the completion record', () => {
    it('a phase behind the learner retries without touching the phases opened since, their releases or the enrolment', async () => {
      install(exclusive());
      const ids = await enrol();
      const board = await enrolment();
      await passTask(ids.requirements, 'main');
      await releases.save(releases.create({
        enrollmentId: board.id, userId: learner, phaseStateId: ids.requirements, phaseKey: 'requirements',
        phaseOrder: 1, version: 'v1', score: 90, notes: null,
      } as Partial<ReleaseRecordEntity>));
      const beforeDesign = await phaseRow(ids.design);
      const beforeLater = await phaseStates.find({ where: { enrollmentId: board.id }, order: { phaseOrder: 'ASC' } });
      const beforeReleases = await releases.find();

      const plan = await workflow.planTaskReset(learner, ids.requirements, 'main');
      expect(plan.retry!.keeps).toContain('The phases you have opened since stay open.');
      expect(plan.retry!.keeps).toContain('You need to pass it again before you can complete the project.');
      await workflow.resetTask(learner, ids.requirements, 'main', await version(ids.requirements));

      expect((await phaseRow(ids.requirements)).status).toBe('in_progress');
      expect(asStored(await phaseRow(ids.design))).toEqual(asStored(beforeDesign));
      const afterLater = await phaseStates.find({ where: { enrollmentId: board.id }, order: { phaseOrder: 'ASC' } });
      expect(afterLater.filter((one) => one.phaseOrder > 1).map(asStored)).toEqual(
        beforeLater.filter((one) => one.phaseOrder > 1).map(asStored),
      );
      expect(afterLater.some((one) => one.status === 'locked' && one.phaseOrder <= 2)).toBe(false);
      expect(asStored(await enrolment() as never)).toEqual(asStored(board as never));
      expect(await releases.find()).toEqual(beforeReleases);
      // Continue on a phase behind the learner is the retried advance: nothing moves
      await workflow.advance(learner, ids.requirements);
      expect((await enrolment()).currentPhaseOrder).toBe(2);
    });

    it('a finished project stays finished: the completion record and the releases do not move', async () => {
      install(exclusive());
      const ids = await enrol();
      const completedAt = '2026-10-25T12:00:00.000Z';
      const states = await phaseStates.find({ where: { userId: learner }, order: { phaseOrder: 'ASC' } });
      const last = states[states.length - 1];
      for (const state of states) await passPhase(state.id);
      await enrollments.update({ userId: learner }, { completed: true, completedAt, currentPhaseOrder: last.phaseOrder });
      await passTask(ids.requirements, 'main');
      const board = await enrolment();
      await releases.save(releases.create({
        enrollmentId: board.id, userId: learner, phaseStateId: ids.requirements, phaseKey: 'requirements',
        phaseOrder: 1, version: 'v1', score: 90, notes: 'shipped',
      } as Partial<ReleaseRecordEntity>));
      const beforeReleases = await releases.find();

      const plan = await workflow.planTaskReset(learner, ids.requirements, 'main');
      expect(plan.retry!.keeps).toContain('Your project stays complete.');
      expect(plan.retry!.keeps).not.toContain('You need to pass it again');
      await workflow.resetTask(learner, ids.requirements, 'main', await version(ids.requirements));

      const after = await enrolment();
      expect([after.completed, after.completedAt, after.currentPhaseOrder]).toEqual([true, completedAt, last.phaseOrder]);
      expect(await releases.find()).toEqual(beforeReleases);
      // a finished project draws no Continue, so the gate asks nothing of the retried phase
      const lastRow = await phaseRow(last.id);
      await expect(
        evidenceNeededAt(dataSource.manager, after, lastRow, {
          phases: teacher.phases,
          tasksFor: (key) => content.getTasksForEnrollment(after, key),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('a sole-task phase (TaskTrackr) retries as its one task', () => {
    const soleIds = async () => {
      install(exclusive());
      return enrol(SHIPPED);
    };

    it('plans the retry of the whole phase', async () => {
      const ids = await soleIds();
      await passPhase(ids.requirements);
      const plan = await workflow.planTaskReset(learner, ids.requirements, '');
      const requirements = shipped.phases.find((phase) => phase.key === 'requirements')!;
      expect(plan.refusal).toBeNull();
      expect(plan.restores).toEqual(editablePathsOf(requirements).slice().sort());
      expect(plan.retry).toEqual({
        wholePhase: true,
        keeps: retryKeeps({ wholePhase: true, signedOff: false, movedOn: true, completed: false }),
      });
    });

    it('puts the phase back in progress, keeping its pass date, score, attempts and every revision, and writes no task row', async () => {
      const ids = await soleIds();
      await passPhase(ids.requirements);
      const requirements = shipped.phases.find((phase) => phase.key === 'requirements')!;
      const [owned] = editablePathsOf(requirements);
      // the learner's bytes as a save would have stored them (the room validates the record; this spec does not need to)
      await phaseStates.update(ids.requirements, { workspace: { [owned]: 'my story' } });
      const earlier = await submissions.save(
        submissions.create({ phaseStateId: ids.requirements, userId: learner, taskKey: '', status: 'completed', passed: true }),
      );
      const beforeDesign = await phaseRow(ids.design);

      const result = await workflow.resetTask(learner, ids.requirements, '', null);

      expect(result.workspace[owned]).toBeUndefined();
      const phase = await phaseRow(ids.requirements);
      expect([phase.status, phase.passedAt, phase.bestScore, phase.attempts]).toEqual(['in_progress', PHASE_PASSED_AT, 90, 3]);
      expect(result.task).toMatchObject({ key: '', status: 'in_progress', passedAt: PHASE_PASSED_AT, bestScore: 90, attempts: 3 });
      expect(await taskStates.count()).toBe(0);
      const kept = await submissions.find({ where: { phaseStateId: ids.requirements } });
      expect(kept.map((one) => [one.id, one.resetEpoch])).toEqual([[earlier.id, null]]);
      // the copy is keyed by the phase row, which IS the sole task's row
      const copies = await dataSource.manager.find(TaskResetEntity);
      expect(copies.map((copy) => [copy.taskStateId, Object.keys(copy.files)])).toEqual([[ids.requirements, [owned]]]);
      expect(asStored(await phaseRow(ids.design))).toEqual(asStored(beforeDesign));
      // the gate wants the phase passed again before Continue, and only a new verdict writes that
      const sole = content.getTasksForEnrollment(await enrolment(), 'requirements');
      const roll = phaseRollup(phase, sole, [], { passed: true, overall: 92 }, '2026-10-31T10:00:00.000Z');
      expect(roll).toEqual({ status: 'passed', passedAt: '2026-10-31T10:00:00.000Z', bestScore: 92 });
    });

    it('a sole-task phase that has not passed keeps the sole-task refusal', async () => {
      const ids = await soleIds();
      expect((await workflow.planTaskReset(learner, ids.design, '')).refusal).toBe(RESET_REFUSALS.soleTask);
      await expect(workflow.resetTask(learner, ids.design, '', null)).rejects.toThrow(RESET_REFUSALS.soleTask);
    });

    it('a passed sole-task phase with a submission being checked refuses in the retry\'s words', async () => {
      const ids = await soleIds();
      await passPhase(ids.requirements);
      await submissions.save(submissions.create({ phaseStateId: ids.requirements, userId: learner, taskKey: '', status: 'queued' }));
      await expect(workflow.resetTask(learner, ids.requirements, '', null)).rejects.toThrow(RETRY_REFUSALS.submissionInFlight);
      expect((await phaseRow(ids.requirements)).status).toBe('passed');
      expect(await dataSource.manager.count(TaskResetEntity)).toBe(0);
    });

    it('a passed sole-task phase asked about by another key is an unknown task', async () => {
      const ids = await soleIds();
      await passPhase(ids.requirements);
      await expect(workflow.resetTask(learner, ids.requirements, 'main', null)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

/**
 * A sole-task phase's key is the empty key, which a `:taskKey` segment cannot
 * carry, so TaskTrackr's retry has the phase-level pair: they answer "the
 * phase's only task" as the phase-level submit does.
 */
describe('the phase-level retry routes (GET/POST /phases/:id/reset)', () => {
  const content = new ContentService();
  content.loadAll();
  const requirements = content.getPhase(SHIPPED, 'requirements');
  const tasksFor = jest.fn((): CompiledTask[] => [soleTaskFor(requirements)]);
  const workflow = {
    loadOwnedState: jest.fn(async () => ({ state: { id: 'ps-1', phaseKey: 'requirements' }, enrollment: {} })),
    planTaskReset: jest.fn(async () => ({ refusal: null })),
    resetTask: jest.fn(async () => ({ version: 'v' })),
  };
  const controller = new PhasesController(workflow as never, {} as never, {} as never, {} as never, { getTasksForEnrollment: tasksFor } as never);
  const user = { id: 'u-1' } as never;

  it('plan and reset the phase\'s only task: the sole key on TaskTrackr', async () => {
    await controller.phaseResetPlan(user, 'ps-1');
    expect(workflow.planTaskReset).toHaveBeenCalledWith('u-1', 'ps-1', SOLE_TASK_KEY);
    await controller.resetPhase(user, 'ps-1', { baseVersion: '2026-10-31T00:00:00.000Z' });
    expect(workflow.resetTask).toHaveBeenCalledWith('u-1', 'ps-1', SOLE_TASK_KEY, '2026-10-31T00:00:00.000Z');
  });

  it('the authored key on a phase of one authored task', async () => {
    tasksFor.mockReturnValueOnce([{ ...soleTaskFor(requirements), taskKey: 'main' }]);
    await controller.phaseResetPlan(user, 'ps-1');
    expect(workflow.planTaskReset).toHaveBeenLastCalledWith('u-1', 'ps-1', 'main');
  });

  it('are GET and POST :id/reset on the phases controller', () => {
    const route = (handler: object) => [Reflect.getMetadata(PATH_METADATA, handler), Reflect.getMetadata(METHOD_METADATA, handler)];
    expect(route(PhasesController.prototype.phaseResetPlan)).toEqual([':id/reset', RequestMethod.GET]);
    expect(route(PhasesController.prototype.resetPhase)).toEqual([':id/reset', RequestMethod.POST]);
  });
});
