import 'reflect-metadata';
import type { PhaseStatus } from '@learnsdlc/shared';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  TaskStateEntity,
} from '../db/entities';
import type { CompiledTask } from '../content/pack-compiler';
import { FeedbackService } from './feedback.service';

/**
 * The lock the roll-up is serialised by (teacher-authored projects).
 *
 * Two verdicts for the last two required tasks of one phase can each write
 * their own task row and then read the task set without seeing the other's
 * commit. Both compute *not every required task has passed*, the phase is left
 * `submitted` with every required task `passed`, and **nothing later corrects
 * it**: a countersignature is a one-shot act and a learner has no second
 * verdict to spend. That is the failure this file is about.
 *
 * It cannot be staged against sqlite: `atomic` chains transactions on that
 * dialect, so two writers never overlap there whatever the code asks for, and
 * a test that passed for that reason would say nothing about the deployment.
 * So the harness below is a small model of PostgreSQL's READ COMMITTED: a
 * transaction sees committed rows plus its own writes, and nothing of a
 * neighbour's uncommitted work, with a real row lock behind
 * `findOneOrFail(EnrollmentEntity, { lock })`. The model honours the lock only
 * when the code asks for it, which is what makes the first test fail the
 * moment the request is removed.
 */

const ALPHA: CompiledTask = task('alpha', 1);
const BETA: CompiledTask = task('beta', 2);
const TASKS = [ALPHA, BETA];
/** One required quiz, which is the shape the attempt epoch is a fact about. */
const QUIZ: CompiledTask = { ...task('concepts', 1), checkKind: 'quiz' } as CompiledTask;
const QUIZ_ONLY = [QUIZ];

function task(taskKey: string, order: number): CompiledTask {
  return {
    taskKey,
    order,
    required: true,
    signOff: false,
    checkKind: 'markdown',
    artefactType: 'document',
    artefactPath: `design/${taskKey}.md`,
    title: taskKey,
    brief: '',
    objectives: [],
    owns: [`design/${taskKey}.md`],
    gradedUnits: [{ kind: 'rule', id: `${taskKey}-note` }],
    rubric: { passThreshold: 70, criteria: [] },
    checks: { kind: 'config', rules: [] },
  } as unknown as CompiledTask;
}

interface TaskRow {
  taskKey: string;
  status: PhaseStatus;
  passedAt: string | null;
  bestScore: number | null;
  attempts: number;
  awaitingSignOff: boolean;
  /** For a quiz, `task_states.resetCount` IS the attempt epoch. */
  resetCount: number;
}

/** A paper in the record, as the epoch comparison reads it. */
interface PaperRow {
  submissionId: string;
  epoch: number;
  voidedAt: string | null;
}

/** The committed rows, and a mutex standing in for the enrolment's row lock. */
function store(honourLock: boolean, list: readonly CompiledTask[] = TASKS, papers: PaperRow[] = []) {
  const phase = { id: 'ps-1', status: 'in_progress' as PhaseStatus, passedAt: null as string | null, bestScore: null as number | null };
  const tasks = new Map<string, TaskRow>(
    list.map((entry) => [
      entry.taskKey,
      { taskKey: entry.taskKey, status: 'in_progress' as PhaseStatus, passedAt: null, bestScore: null, attempts: 1, awaitingSignOff: false, resetCount: 0 },
    ]),
  );
  let held: Promise<void> = Promise.resolve();
  const order: string[] = [];

  /** One transaction: its own write buffer, flushed on commit. */
  async function transaction<T>(work: (manager: any) => Promise<T>): Promise<T> {
    const writtenTasks = new Map<string, Partial<TaskRow>>();
    let writtenPhase: Record<string, unknown> | null = null;
    let release: () => void = () => undefined;

    const manager = {
      connection: { options: { type: 'postgres' } },
      async findOneOrFail(target: unknown, options: any) {
        if (target === EnrollmentEntity) {
          order.push(options?.lock ? 'lock' : 'enrolment-read');
          if (honourLock && options?.lock) {
            const previous = held;
            held = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
          }
          return { id: 'e-1', userId: 'u-1' };
        }
        const row = tasks.get(options.where.taskKey);
        return { ...row, ...writtenTasks.get(options.where.taskKey) };
      },
      async findOne(target: unknown, options: any) {
        order.push('task-read');
        const row = tasks.get(options.where.taskKey);
        if (!row) return null;
        return { ...row, ...writtenTasks.get(options.where.taskKey) };
      },
      async findOneByOrFail(target: unknown, _where: unknown) {
        order.push('phase-read');
        if (target !== PhaseStateEntity) throw new Error(`unexpected read of ${String(target)}`);
        return { ...phase, ...(writtenPhase ?? {}) };
      },
      async find(target: unknown, _options: unknown) {
        order.push('task-set-read');
        if (target !== TaskStateEntity) throw new Error(`unexpected read of ${String(target)}`);
        return [...tasks.values()].map((row) => ({ ...row, ...writtenTasks.get(row.taskKey) }));
      },
      async update(target: unknown, criteria: any, patch: any) {
        if (target === TaskStateEntity) {
          order.push('task-write');
          writtenTasks.set(criteria.taskKey, { ...writtenTasks.get(criteria.taskKey), ...patch });
        } else {
          order.push('phase-write');
          writtenPhase = { ...(writtenPhase ?? {}), ...patch };
        }
        return { affected: 1 };
      },
      createQueryBuilder() {
        throw new Error('the row is already there; nothing here inserts one');
      },
      /**
       * The papers, through the one class that reads and writes them.
       *
       * `writeVerdict` builds a `QuizAttemptsService` over the transaction's
       * own repository (`instructor.service.ts`'s idiom for the reset) so
       * the read that decides the epoch is inside the transaction and after
       * the lock, which is what `order` below is asserted on.
       */
      getRepository(target: unknown) {
        if (target !== QuizAttemptEntity) throw new Error(`unexpected repository for ${String(target)}`);
        return {
          async findOne(options: any) {
            order.push('paper-read');
            return papers.find((row) => row.submissionId === options.where.submissionId) ?? null;
          },
        };
      },
    };

    try {
      const answer = await work(manager);
      for (const [key, patch] of writtenTasks) tasks.set(key, { ...tasks.get(key)!, ...patch } as TaskRow);
      if (writtenPhase) Object.assign(phase, writtenPhase);
      return answer;
    } finally {
      release();
    }
  }

  return { phase, tasks, transaction, order };
}

/** The service with nothing wired but the roll-up: `writeVerdict` reads no provider. */
function grader(): FeedbackService {
  return new FeedbackService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
  );
}

const state = { id: 'ps-1', userId: 'u-1', enrollmentId: 'e-1' } as PhaseStateEntity;
const NOW = '2026-09-19T10:00:00.000Z';
const PASS = { passed: true, overall: 100 };

describe('two verdicts for the last two required tasks of one phase', () => {
  it('leave the phase passed', async () => {
    const world = store(true);
    const service = grader();

    // Both submitted together, both graded together, each the last required
    // task the other is waiting on.
    await Promise.all([
      world.transaction((manager) => service['writeVerdict'](manager, state, TASKS, ALPHA, PASS, NOW)),
      world.transaction((manager) => service['writeVerdict'](manager, state, TASKS, BETA, PASS, NOW)),
    ]);

    expect([...world.tasks.values()].map((row) => row.status)).toEqual(['passed', 'passed']);
    expect(world.phase.status).toBe('passed');
    expect(world.phase.passedAt).toEqual(expect.any(String));
    // Remove the lock from `writeVerdict` and this line reads 'submitted':
    // the model only serialises a transaction that asks for the row.
  });

  it('leave it shut with every required task passed when the lock is not taken', async () => {
    // The same two verdicts against a world that grants no lock, which is
    // what a bare read-then-write on READ COMMITTED is. Written out so the
    // cost of removing the lock is a failing test rather than a comment.
    const world = store(false);
    const service = grader();

    await Promise.all([
      world.transaction((manager) => service['writeVerdict'](manager, state, TASKS, ALPHA, PASS, NOW)),
      world.transaction((manager) => service['writeVerdict'](manager, state, TASKS, BETA, PASS, NOW)),
    ]);

    expect([...world.tasks.values()].map((row) => row.status)).toEqual(['passed', 'passed']);
    expect(world.phase.status).toBe('submitted');
    expect(world.phase.passedAt).toBeNull();
  });

  it('take the lock on the enrolment, and take it before anything the roll-up reads', async () => {
    // `advance`'s idiom locks the **enrolment**, not the phase state. That is
    // the right row:
    // it is the one every writer of a phase's status can reach from, and a
    // lock on the phase state would not serialise two writers moving two
    // phases of one enrolment against `advance`'s whole-board read.
    const world = store(true);
    await world.transaction((manager) =>
      grader()['writeVerdict'](manager, state, TASKS, ALPHA, PASS, NOW),
    );

    expect(world.order[0]).toBe('lock');
    expect(world.order.indexOf('phase-read')).toBeGreaterThan(0);
    expect(world.order.indexOf('task-set-read')).toBeGreaterThan(0);
    // And the phase state keeps its narrow, unlocked `{ id }` read.
    expect(world.order.filter((step) => step === 'lock')).toHaveLength(1);
  });

  it('read and write no task row on a sole-task phase, because it has none', async () => {
    const world = store(true);
    const sole = [{ ...ALPHA, taskKey: '' }] as unknown as CompiledTask[];

    await world.transaction((manager) =>
      grader()['writeVerdict'](manager, state, sole, sole[0], PASS, NOW),
    );

    expect(world.order).not.toContain('task-set-read');
    expect(world.order).not.toContain('task-write');
    expect(world.phase.status).toBe('passed');
  });
});

/**
 * The teacher's reset and the grading job that was already in flight.
 *
 * The same lock, the same READ COMMITTED model, and the other writer under it:
 * `task-reset` (`instructor.service.ts`) takes the enrolment's row lock, clears
 * the task row and increments `resetCount`, which, for a quiz, is the
 * **attempt epoch**. A job enqueued before that commit arrives after it holding
 * a verdict for a paper of the run that has ended, and writing it would restore
 * the `bestScore` the reset nulled and pass the task on an attempt the learner
 * has had handed back to them.
 *
 * The comparison is therefore *of* the commit it is racing, and has to be made
 * under the lock that serialises the two: the epoch on the paper against
 * `resetCount` on the row as the verdict finds it. Read either of them before
 * the lock and the answer is the world as it was before the reset, which is
 * the bug, with a comment on top.
 */
describe('a verdict for a paper of a run the teacher has ended', () => {
  /** What `task-reset` writes, under the same lock and in the same order. */
  const resetQuizTask = (world: ReturnType<typeof store>): Promise<void> =>
    world.transaction(async (manager) => {
      await manager.findOneOrFail(EnrollmentEntity, {
        where: { id: 'e-1', userId: 'u-1' },
        lock: { mode: 'pessimistic_write' },
      });
      await manager.update(
        TaskStateEntity,
        { taskKey: QUIZ.taskKey },
        { status: 'in_progress', passedAt: null, bestScore: null, resetCount: 1 },
      );
    });

  const paperOf = (over: Partial<PaperRow> = {}): PaperRow => ({
    submissionId: 'sub-1',
    epoch: 0,
    voidedAt: null,
    ...over,
  });

  it('moves the task row, the score and the phase not at all', async () => {
    const world = store(true, QUIZ_ONLY, [paperOf()]);
    const service = grader();

    // The reset is first to the lock and commits; the verdict for the paper
    // drawn before it is behind the lock and lands after.
    await Promise.all([
      resetQuizTask(world),
      world.transaction((manager) =>
        service['writeVerdict'](manager, state, QUIZ_ONLY, QUIZ, PASS, NOW, 'sub-1'),
      ),
    ]);

    const row = world.tasks.get(QUIZ.taskKey)!;
    expect(row.status).toBe('in_progress');
    expect(row.passedAt).toBeNull();
    // `taskRollup`'s `Math.max` against a 100 from the old run is exactly what
    // must not happen to a column a teacher has just nulled.
    expect(row.bestScore).toBeNull();
    expect(world.phase.status).toBe('in_progress');
    expect(world.phase.passedAt).toBeNull();
    expect(world.phase.bestScore).toBeNull();

    // And the order is the point. Two transactions took the lock; the second
    // of them is this verdict's, and **both** rows its comparison reads are
    // read after it, and therefore after the reset's write had committed.
    // Take either read before the lock and it answers with the world as it was
    // before the reset, which is the bug with a comment on top.
    const mine = world.order.lastIndexOf('lock');
    expect(world.order.filter((step) => step === 'lock')).toHaveLength(2);
    expect(world.order.indexOf('task-read')).toBeGreaterThan(mine);
    expect(world.order.indexOf('paper-read')).toBeGreaterThan(mine);
    expect(world.order.indexOf('task-write')).toBeLessThan(world.order.indexOf('task-read'));
    // The only write in this world is the reset's own.
    expect(world.order.filter((step) => step === 'task-write')).toHaveLength(1);
    expect(world.order).not.toContain('phase-write');
  });

  it('moves them exactly as it always has when the paper is of the run the row is on', async () => {
    // The converse, and the reason this is a comparison rather than a refusal to
    // write a quiz verdict at all: nothing has reset this task, so the paper's
    // epoch and the row's `resetCount` are the same number and the verdict is
    // the one the gate is waiting for.
    const world = store(true, QUIZ_ONLY, [paperOf()]);

    await world.transaction((manager) =>
      grader()['writeVerdict'](manager, state, QUIZ_ONLY, QUIZ, PASS, NOW, 'sub-1'),
    );

    const row = world.tasks.get(QUIZ.taskKey)!;
    expect(row.status).toBe('passed');
    expect(row.bestScore).toBe(100);
    expect(world.phase.status).toBe('passed');
    expect(world.phase.passedAt).toEqual(expect.any(String));
  });

  it('moves nothing for a paper a reset voided, whatever epoch it carries', async () => {
    // A paper closed by a reset without ever being sat is never scored, never
    // counted and never linked, so a verdict naming one is a verdict about a
    // sheet that is not in the record, and the epoch alone would not always
    // say so.
    const world = store(true, QUIZ_ONLY, [paperOf({ voidedAt: '2026-09-19T09:00:00.000Z' })]);

    await world.transaction((manager) =>
      grader()['writeVerdict'](manager, state, QUIZ_ONLY, QUIZ, PASS, NOW, 'sub-1'),
    );

    expect(world.tasks.get(QUIZ.taskKey)!.status).toBe('in_progress');
    expect(world.tasks.get(QUIZ.taskKey)!.bestScore).toBeNull();
    expect(world.phase.status).toBe('in_progress');
  });

  it('is not a gate of its own: a revision naming no paper at all still lands', async () => {
    // The absence of a record is not evidence that the paper belongs to
    // another run (the same rule `markingLost` keeps) and a guard that read
    // it that way would silently withhold a pass a learner had earned, which
    // is the worse of the two failures because nothing announces it.
    const world = store(true, QUIZ_ONLY, []);

    await world.transaction((manager) =>
      grader()['writeVerdict'](manager, state, QUIZ_ONLY, QUIZ, PASS, NOW, 'sub-1'),
    );

    expect(world.tasks.get(QUIZ.taskKey)!.status).toBe('passed');
    expect(world.phase.status).toBe('passed');
  });
});
