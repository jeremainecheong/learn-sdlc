import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import type { QuizChecks } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  soleTaskFor,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
} from '../db/entities';
import { relianceIndex } from './checkers';
import { QuizAttemptsService } from '../quiz/quiz-attempts.service';
import { WorkflowService } from '../workflow/workflow.service';
import { FeedbackService } from './feedback.service';
import { adoptOrphanRevisions, carriedTaskPass } from './legacy-revisions';
import { releaseExplanations, revealRuleFor } from './quiz-scoring';
import { quizPassed, strictTaskEvidencePassed } from './strict-evidence';

/**
 * The gates a quiz moves, and the one it must not.
 *
 * Four gates in two files ask about the phase's **sole non-quiz task**
 * rather than `tasks.length`, and none of them is a grading expression: they
 * are a history repair, a carried pass, its twin in the second creator, and
 * a learner-visible door. A quiz changes the task count on phases every
 * learner has already worked, so for every quiz-free shape the two
 * questions must give the same answer, that is the equivalence test, and it
 * is asserted here alongside the quiz shapes.
 *
 * The advance half of "a required quiz at its pass mark lets the phase
 * through" lives here too, and it is asked of `WorkflowService.
 * advance` rather than of the predicate: four callers re-ask
 * `strictTaskEvidencePassed` of a **stored** quiz report, and a report that
 * carried a `failed` check per wrong answer would open the phase through the
 * roll-up and then refuse the advance for ever, 100% as the real pass mark,
 * silently, for a teacher who set 80.
 */

const TEACHER = 'ms-tan-tasktrackr';
const V_QUIZ = 'v-teacher-quiz';
const V_TWO_EXECUTABLE = 'v-teacher-two-executable';
const learner = 'quiz-gate-learner';

/* ------------------------------- the fixtures ----------------------------- */

const QUESTIONS: QuizChecks['questions'] = [
  {
    id: 'q-one',
    stem: 'Fixture question one.',
    options: [
      { id: 'a', text: 'The right one' },
      { id: 'b', text: 'The other one' },
    ],
    correct: ['a'],
    explanation: 'Fixture explanation one.',
  },
  {
    id: 'q-two',
    stem: 'Fixture question two.',
    options: [
      { id: 'a', text: 'The right one' },
      { id: 'b', text: 'The other one' },
    ],
    correct: ['a'],
    explanation: 'Fixture explanation two.',
  },
  {
    id: 'q-three',
    stem: 'Fixture question three.',
    options: [
      { id: 'a', text: 'The right one' },
      { id: 'b', text: 'The other one' },
    ],
    correct: ['a'],
    explanation: 'Fixture explanation three.',
  },
  {
    id: 'q-four',
    stem: 'Fixture question four.',
    options: [
      { id: 'a', text: 'The right one' },
      { id: 'b', text: 'The other one' },
    ],
    correct: ['a'],
    explanation: 'Fixture explanation four.',
  },
  {
    id: 'q-five',
    stem: 'Fixture question five.',
    options: [
      { id: 'a', text: 'The right one' },
      { id: 'b', text: 'The other one' },
    ],
    correct: ['a'],
    explanation: 'Fixture explanation five.',
  },
];

/** A clearly fake fixture quiz, at the pass mark the whole design turns on. */
const QUIZ_CHECKS: QuizChecks = {
  kind: 'quiz',
  questions: QUESTIONS,
  shuffleOptions: false,
  passMark: 80,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
};

/** Four of five right, which is 80 against a mark of 80, and not 100. */
const FOUR_OF_FIVE: Record<string, string[]> = {
  'q-one': ['a'],
  'q-two': ['a'],
  'q-three': ['a'],
  'q-four': ['a'],
  'q-five': ['b'],
};

describe('the gates a quiz moves', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let workflow: WorkflowService;
  let feedback: FeedbackService;
  let attempts: QuizAttemptsService;
  let enrollments: Repository<EnrollmentEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let submissions: Repository<SubmissionEntity>;
  let taskStates: Repository<TaskStateEntity>;
  let quizRows: Repository<QuizAttemptEntity>;
  let shipped: ProjectContent;
  let teacher: ProjectContent;
  let ids: Record<string, string>;

  const phaseOf = (project: ProjectContent, key: string): PhaseContent =>
    project.phases.find((one) => one.key === key) as PhaseContent;

  const taskLike = (base: PhaseContent, over: Partial<CompiledTask>): CompiledTask => ({
    ...soleTaskFor(base),
    ...over,
  });

  /** The inherited artefact task of a copied project: keyed `main`, owning everything. */
  const inherited = (base: PhaseContent, order = 1): CompiledTask =>
    taskLike(base, { taskKey: INHERITED_TASK_KEY, order });

  /** A quiz beside it: no file, no unit of the phase's, its own sealed slice. */
  const quizTaskOn = (base: PhaseContent, over: Partial<CompiledTask> = {}): CompiledTask =>
    taskLike(base, {
      taskKey: 'concepts',
      order: 2,
      required: true,
      checkKind: 'quiz',
      artefactType: 'quiz',
      artefactPath: null,
      primaryPath: null,
      title: 'Concept check',
      owns: [],
      gradedUnits: QUESTIONS.map((question) => ({ kind: 'question' as const, id: question.id })),
      rubric: {
        passThreshold: 60,
        criteria: [
          {
            key: 'concepts',
            title: 'Concepts',
            weight: 1,
            description: 'Scored by the quiz your teacher set.',
          },
        ],
      },
      checks: QUIZ_CHECKS,
      ...over,
    } as Partial<CompiledTask>);

  /** Every phase at its inherited task, with the named phases given a quiz beside it. */
  const withQuizOn = (
    project: ProjectContent,
    keys: string[],
    over: Partial<CompiledTask> = {},
  ): CompiledPhaseTasks[] =>
    project.phases.map((one) => ({
      key: one.key,
      tasks: keys.includes(one.key)
        ? [inherited(one), quizTaskOn(one, over)]
        : [inherited(one)],
    }));

  const install = (
    ...versions: { versionId: string; content: ProjectContent; phases: CompiledPhaseTasks[] }[]
  ): void => {
    content.installVersions(versions.map((one) => ({ ...one, compiler: COMPILER_IDENTITY })));
  };

  const enrol = async (): Promise<void> => {
    const view = await workflow.enroll(learner, TEACHER);
    ids = Object.fromEntries(view.phases.map((one) => [one.key, one.id]));
  };

  /** A completed, strict-evidenced passing revision of one non-quiz task. */
  const evidence = (phaseKey: string, taskKey: string): Promise<SubmissionEntity> => {
    const rubric = phaseOf(teacher, phaseKey).rubric;
    return submissions.save(
      submissions.create({
        phaseStateId: ids[phaseKey],
        userId: learner,
        taskKey,
        status: 'completed',
        passed: true,
        workspaceSnapshot: { fixture: 'gate authority fixture' },
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: {
          assessmentMode: 'strict_binary',
          passed: true,
          checks: [
            {
              id: 'fixture',
              label: 'Mocked assessment fixture',
              status: 'passed',
              detail: 'Persisted gate authority only.',
            },
          ],
          tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
          aiReview: {
            provider: 'mock-ai',
            verdict: 'pass',
            criteriaEvidence: rubric.criteria.map((one) => ({
              key: one.key,
              met: true,
              evidence: 'Fixture evidence for the gate only.',
              issue: '',
              nextStep: '',
            })),
          },
        } as never,
      }),
    );
  };

  const passedRow = { status: 'passed' as const, passedAt: '2026-09-21T09:00:00.000Z', bestScore: 90 };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    enrollments = dataSource.getRepository(EnrollmentEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    submissions = dataSource.getRepository(SubmissionEntity);
    taskStates = dataSource.getRepository(TaskStateEntity);
    quizRows = dataSource.getRepository(QuizAttemptEntity);
    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject('tasktrackr');
    // A teacher's copy. TaskTrackr itself declares no quiz and is
    // not touched by anything in this file.
    teacher = { ...shipped, slug: TEACHER, title: 'TaskTrackr (Ms Tan)', version: '1.0.0' };
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    content = new ContentService();
    content.loadAll();
    feedback = new FeedbackService(
      submissions,
      phaseStates,
      enrollments,
      dataSource.getRepository('AssistantMessageEntity' as never) as never,
      content,
      {} as never,
      {} as never,
      { reviewSubmission: jest.fn() } as never,
      { enqueue: jest.fn(async () => undefined), register: jest.fn(), durable: false } as never,
      { emitJob: jest.fn() } as never,
      { onVerdict: jest.fn(async () => undefined) } as never,
    );
    workflow = new WorkflowService(
      enrollments,
      phaseStates,
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
    attempts = new QuizAttemptsService(quizRows);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /* ------------------ the history repairs -------------------------------- */

  describe('the history repairs follow the sole non-quiz task (proof 19)', () => {
    it('adopts a revision handed in before tasks were keyed onto the artefact task, never onto the quiz', async () => {
      install({ versionId: V_QUIZ, content: teacher, phases: withQuizOn(teacher, ['requirements']) });
      await enrol();
      // A revision handed in before the task grain existed: `submissions.
      // taskKey` is the column's default.
      const orphan = await submissions.save(
        submissions.create({
          phaseStateId: ids.requirements,
          userId: learner,
          taskKey: '',
          status: 'completed',
          passed: true,
        }),
      );

      await adoptOrphanRevisions(
        dataSource.manager,
        ids.requirements,
        content.getTasksForEnrollment(
          await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER }),
          'requirements',
        ),
      );

      const adopted = await submissions.findOneByOrFail({ id: orphan.id });
      expect(adopted.taskKey).toBe(INHERITED_TASK_KEY);
      expect(adopted.taskKey).not.toBe('concepts');
    });

    it('is the identity on every one-task shape, which is the equivalence test', async () => {
      install({ versionId: V_QUIZ, content: teacher, phases: withQuizOn(teacher, ['requirements']) });
      await enrol();
      const orphan = await submissions.save(
        submissions.create({
          phaseStateId: ids.design,
          userId: learner,
          taskKey: '',
          status: 'completed',
          passed: true,
        }),
      );
      const pin = await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER });
      await adoptOrphanRevisions(
        dataSource.manager,
        ids.design,
        content.getTasksForEnrollment(pin, 'design'),
      );
      expect((await submissions.findOneByOrFail({ id: orphan.id })).taskKey).toBe(INHERITED_TASK_KEY);
    });

    it('carries a passed phase onto the artefact task and not onto the quiz', () => {
      const requirements = phaseOf(teacher, 'requirements');
      const artefact = inherited(requirements);
      const quiz = quizTaskOn(requirements);
      const passed = { status: 'passed' as const, passedAt: '2026-09-21T09:00:00.000Z', bestScore: 82 };

      expect(carriedTaskPass(passed, [artefact, quiz], artefact)).toEqual({
        status: 'passed',
        passedAt: passed.passedAt,
        bestScore: 82,
      });
      // The quiz gets nothing: a quiz that did not exist cannot have been
      // passed, and a row seeded `passed` would be a mark nobody earned.
      expect(carriedTaskPass(passed, [artefact, quiz], quiz)).toBeNull();
      // The quiz-free shape answers exactly as it would without the quiz.
      expect(carriedTaskPass(passed, [artefact], artefact)).toEqual({
        status: 'passed',
        passedAt: passed.passedAt,
        bestScore: 82,
      });
      // Two executable tasks still name no single owner.
      const second = taskLike(requirements, { taskKey: 'scope', order: 2 });
      expect(carriedTaskPass(passed, [artefact, second], artefact)).toBeNull();
    });

    it('newTaskState answers identically to carriedTaskPass on every shape', () => {
      const requirements = phaseOf(teacher, 'requirements');
      const artefact = inherited(requirements);
      const quiz = quizTaskOn(requirements);
      const second = taskLike(requirements, { taskKey: 'scope', order: 2 });
      const state = {
        id: ids?.requirements ?? 'ps-1',
        status: 'passed' as const,
        passedAt: '2026-09-21T09:00:00.000Z',
        bestScore: 82,
      };
      const enrollment = { userId: learner } as EnrollmentEntity;

      // The second creator's own docstring says it exists *"only so that the
      // two creators cannot answer differently"*, which is exactly why it
      // moves with the first rather than being left to drift.
      for (const [tasks, task] of [
        [[artefact, quiz], artefact],
        [[artefact, quiz], quiz],
        [[artefact], artefact],
        [[artefact, second], artefact],
      ] as [CompiledTask[], CompiledTask][]) {
        const row = workflow['newTaskState'](enrollment, state, tasks, task) as Record<string, unknown>;
        const carried = carriedTaskPass(state, tasks, task);
        expect(row.status ?? null).toBe(carried?.status ?? null);
        expect(row.bestScore ?? null).toBe(carried?.bestScore ?? null);
      }
    });
  });

  /* --------------------- the door survives ------------------------------- */

  describe('the executable task’s door survives the quiz (proof 21)', () => {
    it('still draws the door on a code phase holding a passed task and a quiz', async () => {
      install({
        versionId: V_QUIZ,
        content: teacher,
        phases: withQuizOn(teacher, ['implementation'], { required: false }),
      });
      await enrol();
      const implementation = phaseOf(teacher, 'implementation');
      const pin = await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER });
      const tasks = content.getTasksForEnrollment(pin, 'implementation');
      expect(tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY, 'concepts']);

      const state = await phaseStates.findOneByOrFail({ id: ids.implementation });
      await taskStates.update(
        { phaseStateId: state.id, taskKey: INHERITED_TASK_KEY },
        { ...passedRow, solutionReadAt: '2026-09-21T10:00:00.000Z' },
      );
      const rows = await taskStates.find({ where: { phaseStateId: state.id } });

      // The board alone is a teacher's Pass, and the door stays shut on that
      // until the pass is reviewed. Asserted first so this test tells the two apart: without
      // the reviewed pass the door says it is awaiting review...
      const unreviewed = (await workflow['solutionMeta'](state, implementation, tasks, rows))!;
      expect(unreviewed.awaitingReview).toBe(true);

      // ...and with it the door is simply open, quiz or no quiz. A regression
      // that let the quiz beside the code task withdraw the door, or set
      // `awaitingReview` on every phase that holds a quiz, turns this red.
      await evidence('implementation', INHERITED_TASK_KEY);
      const door = (await workflow['solutionMeta'](state, implementation, tasks, rows))!;
      // The count test made this `available: false`, no button, no read line,
      // no journal event, no dossier field, and nothing refusing or failing.
      expect(door.available).toBe(true);
      expect(door.files).toBeGreaterThan(0);
      expect(door.readAt).toBe('2026-09-21T10:00:00.000Z');
      expect(door).not.toHaveProperty('awaitingReview');
    });

    it('still advertises no door when the phase holds two executable tasks', async () => {
      const implementation = phaseOf(teacher, 'implementation');
      install({
        versionId: V_TWO_EXECUTABLE,
        content: teacher,
        phases: teacher.phases.map((one) => ({ key: one.key, tasks: [inherited(one)] })),
      });
      await enrol();
      const state = await phaseStates.findOneByOrFail({ id: ids.implementation });
      const split = [
        inherited(implementation),
        taskLike(implementation, { taskKey: 'refactor', order: 2 }),
      ];
      // The shape the docstring was written for: no sole task, so no
      // phase-level door, and a learner is never offered one that belongs to
      // nobody.
      expect(await workflow['solutionMeta'](state, implementation, split, [])).toEqual({
        available: false,
        files: 0,
        readAt: null,
      });
    });

    it('is byte-identical for the one-task phase every teacher project ships', async () => {
      install({
        versionId: V_TWO_EXECUTABLE,
        content: teacher,
        phases: teacher.phases.map((one) => ({ key: one.key, tasks: [inherited(one)] })),
      });
      await enrol();
      const implementation = phaseOf(teacher, 'implementation');
      const state = await phaseStates.findOneByOrFail({ id: ids.implementation });
      await taskStates.update(
        { phaseStateId: state.id, taskKey: INHERITED_TASK_KEY },
        { solutionReadAt: '2026-09-21T11:00:00.000Z' },
      );
      const rows = await taskStates.find({ where: { phaseStateId: state.id } });
      expect(await workflow['solutionMeta'](state, implementation, [inherited(implementation)], rows)).toEqual({
        available: true,
        files: expect.any(Number),
        readAt: '2026-09-21T11:00:00.000Z',
      });
    });
  });

  /* ------------ a required quiz at 80 lets advance through ---------------- */

  describe('a required quiz that clears its pass mark advances the phase (proof 20)', () => {
    it('opens the phase and lets advance through at 4 of 5, not at 5 of 5', async () => {
      install({ versionId: V_QUIZ, content: teacher, phases: withQuizOn(teacher, ['requirements']) });
      await enrol();
      const pin = await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER });
      const tasks = content.getTasksForEnrollment(pin, 'requirements');
      const quizTask = tasks.find((one) => one.taskKey === 'concepts')!;

      // The artefact task's half, seeded: this spec is about the quiz's.
      await evidence('requirements', INHERITED_TASK_KEY);
      await taskStates.update(
        { phaseStateId: ids.requirements, taskKey: INHERITED_TASK_KEY },
        passedRow,
      );

      // The quiz's half, through the real path: a drawn paper, a hand-in, a
      // submit that names it, and the grading job.
      const paper = await attempts.start({
        phaseStateId: ids.requirements,
        userId: learner,
        taskKey: 'concepts',
        projectVersionId: V_QUIZ,
        epoch: 0,
        checks: QUIZ_CHECKS,
      });
      await attempts.handIn(paper.id, FOUR_OF_FIVE);
      const held = await phaseStates.findOneByOrFail({ id: ids.requirements });
      const view = await feedback.submit(
        phaseOf(teacher, 'requirements'),
        held,
        undefined,
        'concepts',
        { attemptId: paper.id },
      );
      await feedback.processSubmission({ id: view.id });

      const graded = await submissions.findOneByOrFail({ id: view.id });
      expect(graded.score).toBe(80);
      expect(graded.passed).toBe(true);
      // Not 100: the case the whole design turns on.
      expect(graded.report!.quiz).toMatchObject({ correctCount: 4, drawn: 5, passMark: 80 });
      // The second evaluator, asked of the STORED report exactly as `advance`
      // will ask it.
      expect(
        strictTaskEvidencePassed(quizTask, graded.report!, graded.report!.aiReview),
      ).toBe(quizPassed(80, 80));

      // The roll-up, with no change to `taskRollup` or `phaseRollup`.
      const row = await taskStates.findOneByOrFail({
        phaseStateId: ids.requirements,
        taskKey: 'concepts',
      });
      expect(row.status).toBe('passed');
      expect(row.bestScore).toBe(80);
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).status).toBe('passed');

      // And the product's own question, which a roll-up assertion alone would
      // have answered green while the learner could not leave the phase.
      await expect(workflow.advance(learner, ids.requirements)).resolves.toBeDefined();
      expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('in_progress');
      // The paper carries its verdict back.
      expect(await quizRows.findOneByOrFail({ id: paper.id })).toMatchObject({
        score: 80,
        passed: true,
        submissionId: view.id,
      });
    });

    it('keeps the phase shut when the required quiz fails', async () => {
      install({ versionId: V_QUIZ, content: teacher, phases: withQuizOn(teacher, ['requirements']) });
      await enrol();
      await evidence('requirements', INHERITED_TASK_KEY);
      await taskStates.update(
        { phaseStateId: ids.requirements, taskKey: INHERITED_TASK_KEY },
        passedRow,
      );

      const paper = await attempts.start({
        phaseStateId: ids.requirements,
        userId: learner,
        taskKey: 'concepts',
        projectVersionId: V_QUIZ,
        epoch: 0,
        checks: QUIZ_CHECKS,
      });
      await attempts.handIn(paper.id, { ...FOUR_OF_FIVE, 'q-four': ['b'] });
      const view = await feedback.submit(
        phaseOf(teacher, 'requirements'),
        await phaseStates.findOneByOrFail({ id: ids.requirements }),
        undefined,
        'concepts',
        { attemptId: paper.id },
      );
      await feedback.processSubmission({ id: view.id });

      expect((await submissions.findOneByOrFail({ id: view.id })).passed).toBe(false);
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).status).not.toBe('passed');
      await expect(workflow.advance(learner, ids.requirements)).rejects.toThrow(
        /must pass before advancing/,
      );
    });

    it('an optional quiz moves neither the gate nor the phase’s mean', async () => {
      install({
        versionId: V_QUIZ,
        content: teacher,
        phases: withQuizOn(teacher, ['requirements'], { required: false }),
      });
      await enrol();
      await evidence('requirements', INHERITED_TASK_KEY);
      await taskStates.update(
        { phaseStateId: ids.requirements, taskKey: INHERITED_TASK_KEY },
        passedRow,
      );
      await phaseStates.update(ids.requirements, { status: 'passed', passedAt: passedRow.passedAt, bestScore: 90 });

      const paper = await attempts.start({
        phaseStateId: ids.requirements,
        userId: learner,
        taskKey: 'concepts',
        projectVersionId: V_QUIZ,
        epoch: 0,
        checks: QUIZ_CHECKS,
      });
      await attempts.handIn(paper.id, { ...FOUR_OF_FIVE, 'q-four': ['b'] });
      const view = await feedback.submit(
        phaseOf(teacher, 'requirements'),
        await phaseStates.findOneByOrFail({ id: ids.requirements }),
        undefined,
        'concepts',
        { attemptId: paper.id },
      );
      await feedback.processSubmission({ id: view.id });

      // A failing OPTIONAL quiz is not in `requiredKeysOf`, so it moves
      // neither the phase's status nor its monotonic mean.
      const phaseRow = await phaseStates.findOneByOrFail({ id: ids.requirements });
      expect(phaseRow.status).toBe('passed');
      expect(phaseRow.bestScore).toBe(90);
      await expect(workflow.advance(learner, ids.requirements)).resolves.toBeDefined();
    });
  });

  /* --------- the lock a spent required quiz is, and the way out --------- */

  /**
   * The blocker, reproduced end to end, and its recovery.
   *
   * A required quiz failed on every allowed attempt shuts the phase and the
   * rest of the project behind it. The cap is compulsory on a required quiz, the count is
   * over the papers already handed in, and a live enrolment is never
   * re-pinned, so republishing with a larger cap does not reach the learner
   * who is stuck. The teacher's per-task **reset** is what reaches them, and
   * these are the assertions that it does.
   */
  describe('a required quiz with every attempt spent, and the reset that opens it', () => {
    /**
     * A paper drawn, answered, handed in and submitted, and **not** graded.
     *
     * The two halves are separate because the grading job is a separate act:
     * it is enqueued by the hand-in and run by a worker, and the gap between
     * the two is where a teacher's reset can land. Every case that does not
     * care about that gap uses `sitPaper` below, which closes it immediately.
     */
    const handInPaper = async (
      answers: Record<string, string[]>,
      epoch: number,
    ): Promise<{ attemptId: string; submissionId: string }> => {
      const paper = await attempts.start({
        phaseStateId: ids.requirements,
        userId: learner,
        taskKey: 'concepts',
        projectVersionId: V_QUIZ,
        epoch,
        checks: QUIZ_CHECKS,
      });
      await attempts.handIn(paper.id, answers);
      const view = await feedback.submit(
        phaseOf(teacher, 'requirements'),
        await phaseStates.findOneByOrFail({ id: ids.requirements }),
        undefined,
        'concepts',
        { attemptId: paper.id },
      );
      return { attemptId: paper.id, submissionId: view.id };
    };

    /** One whole paper: drawn, handed in, submitted and graded. */
    const sitPaper = async (
      answers: Record<string, string[]>,
      epoch: number,
    ): Promise<{ attemptId: string; submissionId: string }> => {
      const sat = await handInPaper(answers, epoch);
      await feedback.processSubmission({ id: sat.submissionId });
      return sat;
    };

    /**
     * What the teacher's `task-reset` writes: the task row, and the phase row
     * that comes down with a required task. Kept in this shape rather than
     * calling `InstructorService` so that this file stays about the gate; the
     * lever's own assertions are in `instructor.service.spec.ts`.
     */
    const resetQuizTask = async (): Promise<number> => {
      const row = await taskStates.findOneByOrFail({
        phaseStateId: ids.requirements,
        taskKey: 'concepts',
      });
      await taskStates.update(
        { id: row.id },
        {
          status: 'in_progress',
          passedAt: null,
          bestScore: null,
          resetAt: '2026-09-22T09:00:00.000Z',
          resetCount: row.resetCount + 1,
        },
      );
      await phaseStates.update(
        { id: ids.requirements, status: 'passed' },
        { status: 'in_progress', passedAt: null },
      );
      return row.resetCount + 1;
    };

    /** Three of five right, which is 60 against a mark of 80. */
    const failed = { ...FOUR_OF_FIVE, 'q-four': ['b'] };

    beforeEach(async () => {
      install({
        versionId: V_QUIZ,
        content: teacher,
        phases: withQuizOn(teacher, ['requirements']),
      });
      await enrol();
      await evidence('requirements', INHERITED_TASK_KEY);
      await taskStates.update(
        { phaseStateId: ids.requirements, taskKey: INHERITED_TASK_KEY },
        passedRow,
      );
    });

    it('shuts the phase and the course when every allowed paper has failed', async () => {
      const sat = [];
      for (const _ of [1, 2, 3]) sat.push(await sitPaper(failed, 0));

      // THE LOCK. Three papers at a limit of three, none of them passed.
      expect(await attempts.handedIn(ids.requirements, 'concepts', 0)).toBe(3);
      expect(
        (await taskStates.findOneByOrFail({ phaseStateId: ids.requirements, taskKey: 'concepts' }))
          .status,
      ).not.toBe('passed');
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).status).not.toBe(
        'passed',
      );
      await expect(workflow.advance(learner, ids.requirements)).rejects.toThrow(
        /must pass before advancing/,
      );
      // Every paper is in the record: three rows, none of them void.
      expect(sat).toHaveLength(3);
      expect(
        await quizRows.count({ where: { phaseStateId: ids.requirements, taskKey: 'concepts' } }),
      ).toBe(3);
    });

    it('opens again on the epoch a reset starts, and a pass there advances', async () => {
      for (const _ of [1, 2, 3]) await sitPaper(failed, 0);
      const epoch = await resetQuizTask();
      expect(epoch).toBe(1);

      // The attempts are back: counted over the new run, with every old paper
      // still in the record.
      expect(await attempts.handedIn(ids.requirements, 'concepts', epoch)).toBe(0);
      expect(await attempts.handedIn(ids.requirements, 'concepts', 0)).toBe(3);

      const { submissionId } = await sitPaper(FOUR_OF_FIVE, epoch);
      const graded = await submissions.findOneByOrFail({ id: submissionId });
      expect(graded.passed).toBe(true);
      // Attempt numbering restarts: this is the first paper of the new run,
      // and the report says so.
      expect(graded.report!.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });

      // The gate opens, and the product's own question answers yes.
      expect(
        (await taskStates.findOneByOrFail({ phaseStateId: ids.requirements, taskKey: 'concepts' }))
          .status,
      ).toBe('passed');
      await expect(workflow.advance(learner, ids.requirements)).resolves.toBeDefined();
      // Four papers in the record, not one deleted.
      expect(
        await quizRows.count({ where: { phaseStateId: ids.requirements, taskKey: 'concepts' } }),
      ).toBe(4);
    });

    it('does not let a pass from before the reset satisfy the gate after it', async () => {
      // STRICT EVIDENCE IS ASKED OF THE NEW RUN. `advance` re-asks
      // `strictTaskEvidencePassed` over the learner's stored submissions, and
      // a passing revision from before a reset is still stored: it is the
      // learner's record and nothing deletes it. What refuses is the task ROW
      // beside the submission: `advance` requires `row.status === 'passed'`
      // as a conjunct, and a reset withdraws exactly that. The same conjunct
      // is what already makes a written task's reset hold, so a quiz needs no
      // second mechanism.
      const { submissionId } = await sitPaper(FOUR_OF_FIVE, 0);
      await expect(workflow.advance(learner, ids.requirements)).resolves.toBeDefined();

      // Put the learner back on the phase and reset the quiz.
      await phaseStates.update(ids.design, { status: 'locked' });
      await enrollments.update({ userId: learner, projectSlug: TEACHER }, { currentPhaseOrder: 1 });
      const epoch = await resetQuizTask();

      // The old passing revision is still there and still passes the
      // predicate, and the gate is shut anyway.
      const stored = await submissions.findOneByOrFail({ id: submissionId });
      const quizTask = content
        .getTasksForEnrollment(
          await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER }),
          'requirements',
        )
        .find((one) => one.taskKey === 'concepts')!;
      expect(strictTaskEvidencePassed(quizTask, stored.report!, stored.report!.aiReview)).toBe(true);
      await expect(workflow.advance(learner, ids.requirements)).rejects.toThrow(
        /must pass before advancing/,
      );

      // And it stays shut until a paper of the NEW run passes.
      await sitPaper(failed, epoch);
      await expect(workflow.advance(learner, ids.requirements)).rejects.toThrow(
        /must pass before advancing/,
      );
      await sitPaper(FOUR_OF_FIVE, epoch);
      await expect(workflow.advance(learner, ids.requirements)).resolves.toBeDefined();
    });

    /**
     * The grading job that was already in flight when the reset committed.
     *
     * A hand-in enqueues a job; a worker runs it later. A teacher pressing
     * reset in that gap clears the task row: status, `passedAt`, `bestScore`.
     * Then the worker arrives holding a verdict for a paper of the run
     * that has just ended. Writing it would restore the score the reset nulled
     * and, on a passing paper, pass the task on a run the paper does not
     * belong to: the learner would be through on the strength of the attempt
     * their teacher had just handed back to them.
     *
     * So the verdict is kept and the gate is not moved. `quiz_attempts.epoch`
     * is stamped from `task_states.resetCount` at draw, and the row's
     * `resetCount` is read **under the enrolment lock** that serialises the
     * reset against the roll-up, so the comparison cannot straddle the commit
     * it is about.
     */
    it('keeps a verdict marked after a reset off the task, the score and the phase', async () => {
      // In flight: the sheet is in the record and the job is not yet run.
      const { attemptId, submissionId } = await handInPaper(FOUR_OF_FIVE, 0);
      // The teacher's reset commits while it is being marked.
      expect(await resetQuizTask()).toBe(1);
      // And the worker arrives with the verdict for the paper of the old run.
      await feedback.processSubmission({ id: submissionId });

      const row = await taskStates.findOneByOrFail({
        phaseStateId: ids.requirements,
        taskKey: 'concepts',
      });
      expect(row.status).not.toBe('passed');
      expect(row.passedAt).toBeNull();
      // The number the reset nulled stays null: a `Math.max` against this
      // verdict would put the old run's score back on the new run's row.
      expect(row.bestScore).toBeNull();
      expect(row.resetCount).toBe(1);

      const phase = await phaseStates.findOneByOrFail({ id: ids.requirements });
      expect(phase.status).not.toBe('passed');
      expect(phase.passedAt).toBeNull();
      expect(phase.bestScore).toBeNull();
      await expect(workflow.advance(learner, ids.requirements)).rejects.toThrow(
        /must pass before advancing/,
      );

      // And the record keeps every word of it. The revision is completed and
      // carries its own verdict, the paper carries its own score, and nothing
      // is deleted or voided: this is history, and an appeal reads it.
      const graded = await submissions.findOneByOrFail({ id: submissionId });
      expect(graded.status).toBe('completed');
      expect(graded.passed).toBe(true);
      expect(graded.score).toBe(80);
      const sheet = await quizRows.findOneByOrFail({ id: attemptId });
      expect(sheet.score).toBe(80);
      expect(sheet.passed).toBe(true);
      expect(sheet.epoch).toBe(0);
      expect(sheet.voidedAt).toBeNull();
      expect(
        await quizRows.count({ where: { phaseStateId: ids.requirements, taskKey: 'concepts' } }),
      ).toBe(1);
    });

    it('lands that same verdict on the task and the phase when no reset came', async () => {
      // The converse of the case above, one line shorter: nobody reset the
      // task under this job, so the verdict is of the current run and moves
      // the gate as usual.
      const { attemptId, submissionId } = await handInPaper(FOUR_OF_FIVE, 0);
      await feedback.processSubmission({ id: submissionId });

      const row = await taskStates.findOneByOrFail({
        phaseStateId: ids.requirements,
        taskKey: 'concepts',
      });
      expect(row.status).toBe('passed');
      expect(row.bestScore).toBe(80);
      expect(row.passedAt).toEqual(expect.any(String));
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).status).toBe('passed');
      await expect(workflow.advance(learner, ids.requirements)).resolves.toBeDefined();
      expect((await quizRows.findOneByOrFail({ id: attemptId })).score).toBe(80);
    });

    it('keeps what a spent run released, and withholds again on the run the reset starts', async () => {
      // THE COST OF THE RECOVERY, PINNED: a recorded decision rather than
      // something left implicit. See
      // `releaseExplanations`'s docstring for the whole of it; these are the
      // three facts that must not drift under it.
      //
      // 1. The LAST allowed paper of a run releases the explanation for every
      //    question it drew. That is the "attempts spent" door and it is the whole
      //    return a learner gets on a run they failed.
      const first = await sitPaper(failed, 0);
      const second = await sitPaper(failed, 0);
      const third = await sitPaper(failed, 0);
      const spent = await submissions.findOneByOrFail({ id: third.submissionId });
      expect(spent.report!.quiz).toMatchObject({ attempt: 3, attemptsLeft: 0 });
      expect(spent.report!.quiz!.questions.every((one) => one.explanation !== null)).toBe(true);
      // And the two before it withheld, because their run was not over.
      for (const { submissionId } of [first, second]) {
        const early = await submissions.findOneByOrFail({ id: submissionId });
        expect(early.report!.quiz!.questions.every((one) => one.explanation === null)).toBe(true);
      }

      // 2. The reset does not take it back. A report already written is the
      //    learner's record, and nothing rewrites one behind them, which is
      //    the same rule that keeps every paper in `quiz_attempts`.
      const epoch = await resetQuizTask();
      const afterReset = await submissions.findOneByOrFail({ id: third.submissionId });
      expect(afterReset.report!.quiz!.questions.every((one) => one.explanation !== null)).toBe(
        true,
      );

      // 3. The NEW run withholds from its own first paper, because that run is
      //    not over: the door is `attemptsLeft`, counted within the paper's own
      //    epoch, so a reset hands the attempts back and the seal with them.
      const fresh = await sitPaper(failed, epoch);
      const reopened = await submissions.findOneByOrFail({ id: fresh.submissionId });
      expect(reopened.report!.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });
      expect(reopened.report!.quiz!.questions.every((one) => one.explanation === null)).toBe(true);
      expect(reopened.report!.quiz!.questions.every((one) => one.concept === null)).toBe(true);

      // The key is in none of it, on either side of the reset: the one thing
      // that is never released, whatever a learner has spent.
      for (const id of [third.submissionId, fresh.submissionId]) {
        const row = await submissions.findOneByOrFail({ id });
        expect(JSON.stringify(row.report).replace(/"correctCount"/g, '"tally"')).not.toContain(
          'correct',
        );
      }
    });

    it('never releases an explanation a regraded revision withheld', async () => {
      // `attemptsLeft === 0` is one of the three doors `releaseExplanations`
      // opens on, and the numbers on a stored report are as-of the paper. The
      // first paper of three withheld its explanations; a reset and two more
      // papers later, re-reading that revision must still withhold them.
      const { submissionId } = await sitPaper(failed, 0);
      const first = await submissions.findOneByOrFail({ id: submissionId });
      expect(first.report!.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });
      expect(first.report!.quiz!.questions.every((one) => one.explanation === null)).toBe(true);

      await sitPaper(failed, 0);
      await sitPaper(failed, 0);
      const epoch = await resetQuizTask();
      await sitPaper(failed, epoch);

      const held = await phaseStates.findOneByOrFail({ id: ids.requirements });
      const quizTask = content
        .getTasksForEnrollment(
          await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER }),
          'requirements',
        )
        .find((one) => one.taskKey === 'concepts')!;
      const regraded = await feedback.gradeSnapshot(
        phaseOf(teacher, 'requirements'),
        held,
        content.getTasksForEnrollment(
          await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER }),
          'requirements',
        ),
        quizTask,
        submissionId,
      );
      expect(regraded.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });
      expect(regraded.quiz!.questions.every((one) => one.explanation === null)).toBe(true);
    });
  });

  /* --------- the reveal rule at runtime ----------------------------------- */

  /**
   * `open = passed || attemptsLeft === 0 || reveal === 'always' ||
   * (reveal === undefined && formative)`. The teacher's choice exists only on
   * an optional quiz; a required quiz ignores it (the caller passes
   * `undefined`), so its papers stay sealed until a pass or the last attempt.
   */
  describe('the practice-quiz reveal (5f)', () => {
    const q = [
      {
        id: 'q1',
        stem: 'Fixture stem.',
        options: [],
        selected: [],
        outcome: 'wrong',
        explanation: 'Fixture explanation.',
        concept: 'Fixture concept.',
      },
    ] as never;
    const opens = (gate: Parameters<typeof releaseExplanations>[1]) =>
      releaseExplanations(q, gate)[0].explanation !== null;
    const shut = { passed: false, attemptsLeft: 2 };

    it.each([
      ['absent, formative: today\'s rule, open', { ...shut, attemptsLeft: null, formative: true, reveal: undefined }, true],
      ['absent, capped: today\'s rule, shut', { ...shut, formative: false, reveal: undefined }, false],
      ['on-pass, unlimited: shut until a pass', { ...shut, attemptsLeft: null, formative: true, reveal: 'on-pass' }, false],
      ['always, capped: open after every marked paper', { ...shut, formative: false, reveal: 'always' }, true],
    ] as const)('%s', (_name, gate, open) => {
      expect(opens(gate as never)).toBe(open);
    });

    it('a pass or a spent run opens whatever the rule', () => {
      expect(opens({ passed: true, attemptsLeft: 2, formative: false, reveal: 'on-pass' } as never)).toBe(true);
      expect(opens({ passed: false, attemptsLeft: 0, formative: false, reveal: 'on-pass' } as never)).toBe(true);
    });

    it('a required quiz ignores the teacher\'s choice', () => {
      expect(revealRuleFor({ required: true } as never, { revealExplanation: 'always' } as never)).toBeUndefined();
      expect(revealRuleFor({ required: false } as never, { revealExplanation: 'always' } as never)).toBe('always');
      expect(revealRuleFor({ required: false } as never, {} as never)).toBeUndefined();
    });
  });

  /* ------------------- checkers.ts: the formula, asserted ----------------- */

  describe('checkers.ts is not edited by this step', () => {
    it('relianceIndex is the formula it was, for every input', () => {
      // The reliance index's formula has no quiz case. The quiz exemption is
      // about what reaches the denominator, and it is implemented
      // where the counter is spent, not here.
      for (const hints of [0, 1, 3, 6, 12]) {
        for (const spent of [0, 1, 2, 5, 9]) {
          expect(relianceIndex(hints, spent)).toBe(
            hints === 0 ? 0 : Math.round((100 * hints) / (hints + 2 * spent + 1)),
          );
        }
      }
      // The early return that makes the zero-hint half of the exemption true
      // whatever the attempts are.
      expect(relianceIndex(0, 99)).toBe(0);
    });
  });
});
