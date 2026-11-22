import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { PhaseStatus, SubmissionView } from '@learnsdlc/shared';
import { compiledQuizSnapshot } from '../../test/quiz-fixture';
import type { PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import {
  PhaseStateEntity,
  QuizAttemptEntity,
  SubmissionEntity,
  TaskStateEntity,
} from '../db/entities';
import { phaseRollup, taskRollup, type HeldTaskState } from '../feedback/checkers';
import { conceptClosedRefusal, conceptSlotStatus } from './concept/concept';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QuizService } from './quiz.service';

/**
 * The before check closes once the learner has
 * handed in work for the phase.
 *
 * The before check is a pre-measure. Once any revision of any task in the
 * phase is handed in (a `submissions` row; concept checks write none), or the
 * phase reads `submitted` or `passed`, a "before" score would be taken after
 * the learning, so the slot reads `closed` and a start is refused. A paper
 * already handed in still reads `taken`, with its score. The after check
 * stays `locked` until the phase is `passed`, which a phase with
 * a sign-off task reaches only once the teacher has countersigned.
 */
const snapshot = compiledQuizSnapshot();
const DESIGN = 'design';

const phase = (): PhaseContent => snapshot.content.phases.find((one) => one.key === DESIGN)!;
const tasks = (): CompiledTask[] => snapshot.phases.find((one) => one.key === DESIGN)!.tasks;

describe('the before check closes once work is handed in', () => {
  let dataSource: DataSource;
  let rows: Repository<QuizAttemptEntity>;
  let submissions: Repository<SubmissionEntity>;
  let service: QuizService;
  let state: PhaseStateEntity;
  let compiledTasks: CompiledTask[];

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    rows = dataSource.getRepository(QuizAttemptEntity);
    submissions = dataSource.getRepository(SubmissionEntity);
    compiledTasks = tasks();
    state = { id: 'ps-1', userId: 'u-1', enrollmentId: 'e-1', phaseKey: DESIGN, status: 'in_progress' } as unknown as PhaseStateEntity;
    service = new QuizService(
      { loadOwnedState: jest.fn(async () => ({ state, phase: phase(), enrollment: { id: 'e-1' } })) } as never,
      {
        getTasksForEnrollment: jest.fn(() => compiledTasks),
        resolveForEnrollment: jest.fn(() => ({ content: snapshot.content, versionId: 'pv-1' })),
      } as never,
      { submit: jest.fn(async () => ({ id: 'sub-x' }) as SubmissionView) } as never,
      new QuizAttemptsService(rows),
      dataSource.getRepository(TaskStateEntity),
      submissions,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** One handed-in revision of `taskKey` on `phaseStateId`, in whatever state the grader left it. */
  async function handedIn(taskKey: string, status: SubmissionEntity['status'] = 'queued', phaseStateId = 'ps-1') {
    await submissions.save(submissions.create({ phaseStateId, userId: 'u-1', taskKey, status }));
  }

  async function takeCheck(taskKey: string) {
    const paper = await service.start('u-1', 'ps-1', taskKey);
    return service.handIn('u-1', 'ps-1', taskKey, paper.attemptId, {});
  }

  it('keeps the before check open while nothing is handed in', async () => {
    const slots = await service.conceptQuizzes('u-1', 'ps-1');
    expect(slots.before.status).toBe('open');
    expect(slots.after.status).toBe('locked');
    // Another phase's revision does not close this phase's check.
    await handedIn('design-doc', 'completed', 'ps-other');
    expect((await service.conceptQuizzes('u-1', 'ps-1')).before.status).toBe('open');
  });

  it.each(['queued', 'running', 'completed', 'failed'] as const)(
    'closes the before check after one %s revision of any task',
    async (status) => {
      const task = compiledTasks.find((one) => one.checkKind !== 'quiz')!;
      await handedIn(task.taskKey, status);
      const slots = await service.conceptQuizzes('u-1', 'ps-1');
      expect(slots.before).toEqual({ taskKey: 'concept-before', status: 'closed', scorePct: null, questionCount: 6 });
      expect(slots.after.status).toBe('locked');
    },
  );

  it('closes the before check on a pack quiz revision too (any task)', async () => {
    const quiz = compiledTasks.find((one) => one.checkKind === 'quiz')!;
    await handedIn(quiz.taskKey, 'completed');
    expect((await service.conceptQuizzes('u-1', 'ps-1')).before.status).toBe('closed');
  });

  it.each(['submitted', 'passed'] as const)('closes the before check when the phase is %s, with no submission rows', async (status) => {
    state.status = status;
    expect(await submissions.count()).toBe(0);
    expect((await service.conceptQuizzes('u-1', 'ps-1')).before.status).toBe('closed');
  });

  it('a taken before check stays taken, with its score, after work is handed in', async () => {
    await takeCheck('concept-before');
    await handedIn('design-doc', 'completed');
    state.status = 'passed';
    const slots = await service.conceptQuizzes('u-1', 'ps-1');
    expect(slots.before).toEqual({ taskKey: 'concept-before', status: 'taken', scorePct: 0, questionCount: 6 });
    const room = await service.room('u-1', 'ps-1', 'concept-before');
    expect(room.status).toBe('passed');
    expect(room.bestScore).toBe(0);
  });

  it('refuses a closed start with 409 concept_quiz_closed and draws no paper', async () => {
    await handedIn('design-doc');
    const refusal = await service.start('u-1', 'ps-1', 'concept-before').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getStatus()).toBe(409);
    expect((refusal as ConflictException).getResponse()).toEqual({
      error: 'concept_quiz_closed',
      message: 'The before check closes once you have handed in work for this phase.',
    });
    expect(conceptClosedRefusal().getResponse()).toEqual((refusal as ConflictException).getResponse());
    expect(await rows.count()).toBe(0);
  });

  it('the room reads a closed before check as locked, with no paper', async () => {
    state.status = 'submitted';
    const room = await service.room('u-1', 'ps-1', 'concept-before');
    expect(room.status).toBe('locked');
    expect(room.paper).toBeNull();
    expect(room.attemptsUsed).toBe(0);
  });

  it('a before paper started while open may still be handed in after the slot closes', async () => {
    const paper = await service.start('u-1', 'ps-1', 'concept-before');
    await handedIn('design-doc');
    // The room still hands the open paper back, so it can be finished.
    const room = await service.room('u-1', 'ps-1', 'concept-before');
    expect(room.paper?.attemptId).toBe(paper.attemptId);
    const result = await service.handIn('u-1', 'ps-1', 'concept-before', paper.attemptId, {});
    expect(result.status).toBe('completed');
    expect((await service.conceptQuizzes('u-1', 'ps-1')).before.status).toBe('taken');
  });

  it('the after check stays locked while a sign-off task awaits its countersignature, and opens once the phase is passed', async () => {
    // A phase whose every required task passed review, one of them a sign-off task.
    const required = compiledTasks.filter((one) => one.required);
    const signOffKey = required[0].taskKey;
    compiledTasks = compiledTasks.map((one) => (one.taskKey === signOffKey ? { ...one, signOff: true } : one));
    const now = '2026-10-07T08:00:00.000Z';
    const held = { status: 'in_progress' as PhaseStatus, passedAt: null, bestScore: null };
    const rowsAfterReview: HeldTaskState[] = compiledTasks
      .filter((one) => one.required)
      .map((one) => ({ taskKey: one.taskKey, ...taskRollup(held, one, { passed: true, overall: 90 }, now) }));
    const signOffRow = rowsAfterReview.find((one) => one.taskKey === signOffKey)! as HeldTaskState & { awaitingSignOff: boolean };
    expect(signOffRow.status).toBe('submitted');
    expect(signOffRow.awaitingSignOff).toBe(true);
    state.status = phaseRollup(held, compiledTasks, rowsAfterReview, { passed: true, overall: 90 }, now).status;
    expect(state.status).toBe('submitted');
    await handedIn(signOffKey, 'completed');

    let slots = await service.conceptQuizzes('u-1', 'ps-1');
    expect(slots.after.status).toBe('locked');
    expect(slots.before.status).toBe('closed');
    const refusal = await service.start('u-1', 'ps-1', 'concept-after').catch((err: unknown) => err);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ error: 'concept_quiz_locked' });

    // The teacher countersigns: the task reads passed, and so does the phase.
    const countersigned = rowsAfterReview.map((one) => (one.taskKey === signOffKey ? { ...one, status: 'passed' as PhaseStatus } : one));
    state.status = phaseRollup({ ...held, status: state.status }, compiledTasks, countersigned, { passed: true, overall: 90 }, now).status;
    expect(state.status).toBe('passed');
    slots = await service.conceptQuizzes('u-1', 'ps-1');
    expect(slots.after.status).toBe('open');
    expect(slots.before.status).toBe('closed');
  });

  it('the pure slot rule: taken beats closed, closed only for the before check', () => {
    expect(conceptSlotStatus('concept-before', 'in_progress', false, false)).toBe('open');
    expect(conceptSlotStatus('concept-before', 'in_progress', false, true)).toBe('closed');
    expect(conceptSlotStatus('concept-before', 'submitted', false, false)).toBe('closed');
    expect(conceptSlotStatus('concept-before', 'passed', false, false)).toBe('closed');
    expect(conceptSlotStatus('concept-before', 'passed', true, true)).toBe('taken');
    expect(conceptSlotStatus('concept-after', 'submitted', false, true)).toBe('locked');
    expect(conceptSlotStatus('concept-after', 'passed', false, true)).toBe('open');
    expect(conceptSlotStatus('concept-after', 'passed', true, true)).toBe('taken');
  });
});
