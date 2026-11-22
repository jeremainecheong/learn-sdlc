import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { SubmissionView } from '@learnsdlc/shared';
import { compiledQuizSnapshot } from '../../test/quiz-fixture';
import type { PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import {
  PhaseStateEntity,
  QuizAttemptEntity,
  SubmissionEntity,
  TaskStateEntity,
} from '../db/entities';
import { requiredTasksWithoutEvidence } from '../workflow/strict-gate';
import { CONCEPT_BANK } from './concept/bank';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';

/**
 * The before/after concept checks on the three quiz routes and the
 * concept-quizzes status route.
 */
const snapshot = compiledQuizSnapshot();
const DESIGN = 'design';

const phase = (): PhaseContent => snapshot.content.phases.find((one) => one.key === DESIGN)!;
const tasks = (): CompiledTask[] => snapshot.phases.find((one) => one.key === DESIGN)!.tasks;

const keyOf = (questionId: string) =>
  CONCEPT_BANK.design.questions.find((one) => one.id === questionId)!.correct[0];

describe('the concept checks on the quiz routes', () => {
  let dataSource: DataSource;
  let rows: Repository<QuizAttemptEntity>;
  let service: QuizService;
  let submit: jest.Mock;
  let state: PhaseStateEntity;
  let compiledTasks: CompiledTask[];
  let loadOwnedState: jest.Mock;

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    rows = dataSource.getRepository(QuizAttemptEntity);
    compiledTasks = tasks();
    state = { id: 'ps-1', userId: 'u-1', enrollmentId: 'e-1', phaseKey: DESIGN, status: 'in_progress' } as unknown as PhaseStateEntity;
    submit = jest.fn(async () => ({ id: 'sub-x' }) as SubmissionView);
    loadOwnedState = jest.fn(async () => ({ state, phase: phase(), enrollment: { id: 'e-1' } }));
    service = new QuizService(
      { loadOwnedState } as never,
      {
        getTasksForEnrollment: jest.fn(() => compiledTasks),
        resolveForEnrollment: jest.fn(() => ({ content: snapshot.content, versionId: 'pv-1' })),
      } as never,
      { submit } as never,
      new QuizAttemptsService(rows),
      dataSource.getRepository(TaskStateEntity),
      dataSource.getRepository(SubmissionEntity),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Answer every question right except the first `wrong` of them. */
  async function takeCheck(taskKey: string, wrong = 0): Promise<SubmissionView> {
    const paper = await service.start('u-1', 'ps-1', taskKey);
    const row = await rows.findOneByOrFail({ id: paper.attemptId });
    const answers: Record<string, string[]> = {};
    paper.questions.forEach((question, index) => {
      const drawn = row.paper.find((one) => one.questionId === question.id)!;
      const key = keyOf(question.id);
      const pickAuthored = index < wrong ? drawn.optionIds.find((id) => id !== key)! : key;
      const at = drawn.optionIds.indexOf(pickAuthored);
      answers[question.id] = [question.options[at].id];
    });
    return service.handIn('u-1', 'ps-1', taskKey, paper.attemptId, answers);
  }

  it('reports before open and after locked on a fresh phase', async () => {
    await expect(service.conceptQuizzes('u-1', 'ps-1')).resolves.toEqual({
      phaseKey: DESIGN,
      before: { taskKey: 'concept-before', status: 'open', scorePct: null, questionCount: 6 },
      after: { taskKey: 'concept-after', status: 'locked', scorePct: null, questionCount: 6 },
    });
  });

  it('draws all six questions, shuffled, without the key or explanations', async () => {
    const paper = await service.start('u-1', 'ps-1', 'concept-before');
    expect(paper.questions).toHaveLength(6);
    expect(new Set(paper.questions.map((one) => one.id))).toEqual(new Set(CONCEPT_BANK.design.questions.map((one) => one.id)));
    const wire = JSON.stringify(paper);
    expect(wire).not.toMatch(/correct|explanation/);
    for (const question of paper.questions) expect(question.multiple).toBe(false);
    // Idempotent while open: the same paper back.
    expect((await service.start('u-1', 'ps-1', 'concept-before')).attemptId).toBe(paper.attemptId);
    const room = await service.room('u-1', 'ps-1', 'concept-before');
    expect(room.taskKey).toBe('concept-before');
    expect(room.required).toBe(false);
    expect(room.drawn).toBe(6);
    expect(room.paper?.attemptId).toBe(paper.attemptId);
    expect(JSON.stringify(room)).not.toMatch(/correct|explanation/);
  });

  it('scores the sheet in the request and writes only quiz_attempts', async () => {
    const before = await requiredTasksWithoutEvidence(dataSource.manager, state, compiledTasks, 'u-1');
    const result = await takeCheck('concept-before', 2);
    expect(result.status).toBe('completed');
    expect(result.score).toBe(67);
    expect(result.report?.quiz?.correctCount).toBe(4);
    expect(result.report?.quiz?.drawn).toBe(6);
    // The before result withholds per-question rows and explanations, so the
    // after check measures the phase, not recall of the before feedback.
    expect(result.report?.quiz?.questions).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/"correct"|explanation/);
    expect(JSON.stringify(await service.handIn('u-1', 'ps-1', 'concept-before', result.id, {}))).not.toMatch(/explanation/);

    expect(submit).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(TaskStateEntity).count()).toBe(0);
    expect(await dataSource.getRepository(SubmissionEntity).count()).toBe(0);
    const stored = await rows.find();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ taskKey: 'concept-before', epoch: 0, score: 67, voidedAt: null, submissionId: null });
    expect(stored[0].packVersion).toMatch(/^concept-bank@/);
    expect(state.status).toBe('in_progress');
    const after = await requiredTasksWithoutEvidence(dataSource.manager, state, compiledTasks, 'u-1');
    expect(after.map((one) => one.taskKey)).toEqual(before.map((one) => one.taskKey));

    const status = await service.conceptQuizzes('u-1', 'ps-1');
    expect(status.before).toEqual({ taskKey: 'concept-before', status: 'taken', scorePct: 67, questionCount: 6 });
    expect(status.after.status).toBe('locked');
  });

  it('refuses a second start of a taken check with concept_quiz_taken', async () => {
    await takeCheck('concept-before');
    const refusal = await service.start('u-1', 'ps-1', 'concept-before').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ error: 'concept_quiz_taken' });
    const room = await service.room('u-1', 'ps-1', 'concept-before');
    expect(room.attemptsLeft).toBe(0);
    expect(room.bestScore).toBe(100);
    expect(room.paper).toBeNull();
  });

  it('refuses a locked after, then opens it once the phase is passed', async () => {
    const refusal = await service.start('u-1', 'ps-1', 'concept-after').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ error: 'concept_quiz_locked' });
    expect(await rows.count()).toBe(0);

    state.status = 'passed';
    expect((await service.conceptQuizzes('u-1', 'ps-1')).after.status).toBe('open');
    const result = await takeCheck('concept-after', 1);
    expect(result.score).toBe(83);
    // The after result releases every question's explanation.
    expect(result.report?.quiz?.questions).toHaveLength(6);
    expect(result.report?.quiz?.questions.every((one) => one.explanation)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/"correct"/);
    const status = await service.conceptQuizzes('u-1', 'ps-1');
    expect(status.after).toEqual({ taskKey: 'concept-after', status: 'taken', scorePct: 83, questionCount: 6 });
    // A passed phase closes the before check it never took.
    expect(status.before.status).toBe('closed');
  });

  it('answers a replayed hand-in with the same result and refuses a stranger’s attempt id', async () => {
    const paper = await service.start('u-1', 'ps-1', 'concept-before');
    const first = await service.handIn('u-1', 'ps-1', 'concept-before', paper.attemptId, {});
    expect(first.score).toBe(0);
    const again = await service.handIn('u-1', 'ps-1', 'concept-before', paper.attemptId, {});
    expect(again.score).toBe(0);
    await expect(service.handIn('u-1', 'ps-1', 'concept-before', 'not-an-attempt', {})).rejects.toThrow();
  });

  it('lets the pack win when it declares a task with a concept key', async () => {
    const plain = compiledTasks.find((one) => one.checkKind !== 'quiz')!;
    compiledTasks = [...compiledTasks, { ...plain, taskKey: 'concept-before' }];
    await expect(service.room('u-1', 'ps-1', 'concept-before')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('mounts the status route on the quiz controller', async () => {
    const quiz = { conceptQuizzes: jest.fn(async () => ({ ok: true })) };
    const controller = new QuizController(quiz as never);
    await expect(controller.conceptQuizzes({ id: 'u-1' } as never, 'ps-1')).resolves.toEqual({ ok: true });
    expect(quiz.conceptQuizzes).toHaveBeenCalledWith('u-1', 'ps-1');
    const path = Reflect.getMetadata('path', QuizController.prototype.conceptQuizzes);
    expect(path).toBe(':id/concept-quizzes');
  });
});
