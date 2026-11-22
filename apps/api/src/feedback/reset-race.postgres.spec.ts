import 'reflect-metadata';
import { ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  compilePack,
  editablePathsOf,
  gradedUnitsOf,
  soleTaskFor,
  type AuthoredTask,
  type CompiledTask,
} from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskResetEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { InstructorService } from '../instructor/instructor.service';
import { RetentionService } from '../retention/retention.service';
import { RESET_REFUSALS } from '../workflow/learner-reset';
import { WorkflowService } from '../workflow/workflow.service';
import { FeedbackService } from './feedback.service';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';

/**
 * The submit/reset races, on the PostgreSQL 16 cluster, two or more
 * pooled connections, interleavings forced by a barrier inside `submit`
 * between its outer read and its locked insert:
 *
 * (a) a learner reset commits in between → the stored snapshot is the
 *     post-reset workspace and `resetEpoch` is the new count;
 * (b) the teacher's `reset-phase` commits in between → never a pre-reset
 *     snapshot;
 * (c) 50 interleavings of submit against the learner reset, each finishing
 *     inside 5 s: no deadlock, and every stored revision carries an epoch;
 * (d) two submits racing a verdict that holds the enrolment lock, with
 *     non-durable jobs → one row and ONE attempt on each counter, and the
 *     loser spends nothing under the lock (the in-lock in-flight re-check);
 * (e) the lock itself: a learner reset started while a
 *     submit sits INSIDE its transaction, after the re-read and before the
 *     spend, does not commit until the submit has, then meets the queued
 *     revision and refuses, so the stored epoch is the count the insert read;
 * (f) the snapshot prune on PostgreSQL: its window SQL empties all but the newest
 *     three copies and a second sweep writes nothing.
 *
 * Self-skips without `POSTGRES_TEST_CONFIG`; refuses any database but the
 * loopback cluster's `lsdlc_numbers` / `lsdlc_pgspecs`; works in a scratch
 * schema it drops.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rb_race';
const TEACHER = 'ms-race';
const V_TEACHER = 'v-race';

describePg('the submit lock against the resets (PostgreSQL)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);
  let content: ContentService;
  let workflow: WorkflowService;
  let feedback: FeedbackService;
  let instructor: InstructorService;
  let E0 = '';
  let learner = '';
  const staff = { id: '', role: 'ADMIN' as const, cohort: '' };

  /** One barrier inside `submit`, after the outer read, before the lock. */
  let barrier: (() => Promise<void>) | null = null;
  /** One barrier INSIDE the locked transaction: after the re-read, before the spend. */
  let inner: (() => Promise<void>) | null = null;
  /** How many attempts were spent through the locked transaction. */
  let spentUnderLock = 0;

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    db = await new DataSource({
      ...postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 12 },
    } as never).initialize();
    await db.runMigrations({ transaction: 'all' });

    const loader = new ContentService();
    loader.loadAll();
    const shipped = loader.getProject('tasktrackr');
    const teacher: ProjectContent = { ...shipped, slug: TEACHER, title: 'Race', version: '1.0.0' };
    const requirements = teacher.phases.find((phase) => phase.key === 'requirements')!;
    [E0] = editablePathsOf(requirements);
    const inherited: Record<string, AuthoredTask[]> = Object.fromEntries(
      teacher.phases.map((phase) => [
        phase.key,
        [{ taskKey: 'main', order: 1, owns: editablePathsOf(phase), gradedUnits: gradedUnitsOf(phase) }],
      ]),
    );
    const split: CompiledTask[] = [
      { ...soleTaskFor(requirements), taskKey: 'story', order: 1, title: 'The story', owns: editablePathsOf(requirements) },
    ];
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      {
        versionId: V_TEACHER,
        content: teacher,
        compiler: COMPILER_IDENTITY,
        phases: compilePack(teacher, { authored: inherited }).phases.map((entry) =>
          entry.key === 'requirements' ? { key: entry.key, tasks: split } : entry,
        ),
      },
    ]);
    workflow = new WorkflowService(
      db.getRepository(EnrollmentEntity),
      db.getRepository(PhaseStateEntity),
      db.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      db,
    );
    feedback = new FeedbackService(
      db.getRepository(SubmissionEntity),
      db.getRepository(PhaseStateEntity),
      db.getRepository(EnrollmentEntity),
      { count: async () => 0, find: async () => [] } as never,
      content,
      {} as never,
      {} as never,
      {} as never,
      { enqueue: async () => undefined, register: () => undefined, durable: false } as never,
      { emitJob: () => undefined } as never,
      { onVerdict: async () => undefined } as never,
    );
    instructor = new InstructorService(db, content, {} as never);
    const users = db.getRepository(UserEntity);
    learner = (await users.save(users.create({ email: `race-${schema}@example.invalid`, passwordHash: 'x', displayName: 'Racer' }))).id;
    staff.id = (await users.save(users.create({ email: `staff-${schema}@example.invalid`, passwordHash: 'x', displayName: 'Staff', role: 'ADMIN' as never }))).id;

    const original = (FeedbackService.prototype as any).packVersionFor;
    jest.spyOn(FeedbackService.prototype as any, 'packVersionFor').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const hold = barrier;
      barrier = null;
      if (hold) await hold();
      return original.apply(this, args);
    });
    const spend = (FeedbackService.prototype as any).spendAttempt;
    jest.spyOn(FeedbackService.prototype as any, 'spendAttempt').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      if (args[3]) {
        spentUnderLock += 1;
        const hold = inner;
        inner = null;
        if (hold) await hold();
      }
      return spend.apply(this, args);
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  }, 180000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  let requirementsId = '';
  beforeEach(async () => {
    barrier = null;
    inner = null;
    spentUnderLock = 0;
    await db.query(`DELETE FROM "${schema}"."submissions"`);
    await db.query(`DELETE FROM "${schema}"."task_resets"`);
    await db.query(`DELETE FROM "${schema}"."task_states"`);
    await db.query(`DELETE FROM "${schema}"."phase_states"`);
    await db.query(`DELETE FROM "${schema}"."enrollments"`);
    const view = await workflow.enroll(learner, TEACHER);
    requirementsId = view.phases.find((phase) => phase.key === 'requirements')!.id;
  });

  const load = () => workflow.loadOwnedState(learner, requirementsId);
  const versionOf = async () => (await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: requirementsId })).workspaceUpdatedAt ?? null;
  const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
    Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

  it('(a) a learner reset between the outer read and the insert: the post-reset snapshot and epoch', async () => {
    await workflow.saveWorkspace(learner, requirementsId, { [E0]: 'written before the reset' });
    const { state, phase } = await load();
    barrier = async () => {
      await workflow.resetTask(learner, requirementsId, 'story', await versionOf());
    };
    const view = await within(5000, feedback.submit(phase, state, undefined, 'story'));
    const row = await db.getRepository(SubmissionEntity).findOneByOrFail({ id: view.id });
    expect(row.workspaceSnapshot?.[E0]).not.toBe('written before the reset');
    expect(row.resetEpoch).toBe(1);
  }, 30000);

  it('(b) the teacher\'s reset-phase between the outer read and the insert: never a pre-reset snapshot', async () => {
    await workflow.saveWorkspace(learner, requirementsId, { [E0]: 'written before the phase reset' });
    const { state, phase } = await load();
    barrier = async () => {
      await instructor.overridePhase(staff as never, learner, requirementsId, 'reset-phase', 'Starting the phase over for this learner.');
    };
    const view = await within(5000, feedback.submit(phase, state, undefined, 'story'));
    const row = await db.getRepository(SubmissionEntity).findOneByOrFail({ id: view.id });
    expect(row.workspaceSnapshot?.[E0]).not.toBe('written before the phase reset');
    // The phase lever bumped the non-quiz row, and the insert read it.
    expect(row.resetEpoch).toBe(1);
  }, 30000);

  it('(c) 50 interleavings of submit and the learner reset: no deadlock, every revision stamped', async () => {
    for (let i = 0; i < 50; i += 1) {
      await workflow.saveWorkspace(learner, requirementsId, { [E0]: `round ${i}` });
      const { state, phase } = await load();
      const version = await versionOf();
      const started = Date.now();
      const outcomes = await within(
        5000,
        Promise.allSettled([
          feedback.submit(phase, state, undefined, 'story'),
          new Promise((resolve) => setTimeout(resolve, i % 7)).then(() =>
            workflow.resetTask(learner, requirementsId, 'story', version),
          ),
        ]),
      );
      expect(Date.now() - started).toBeLessThan(5000);
      // The submit always lands (a reset refuses while it is in flight, or
      // commits first and the submit reads its result under the lock).
      expect(outcomes[0].status).toBe('fulfilled');
      // Either order leaves the stored epoch equal to the task row's count:
      // a reset that won committed before the insert read the count, and one
      // that lost met the queued revision and refused, moving nothing.
      const landed = await db.getRepository(SubmissionEntity).findOneByOrFail({
        id: (outcomes[0] as PromiseFulfilledResult<{ id: string }>).value.id,
      });
      const count = (await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: requirementsId, taskKey: 'story' })).resetCount;
      expect([i, landed.resetEpoch]).toEqual([i, count]);
      await db.getRepository(SubmissionEntity).update({ phaseStateId: requirementsId }, { status: 'completed' });
    }
    const rows = await db.getRepository(SubmissionEntity).find({ where: { phaseStateId: requirementsId } });
    expect(rows).toHaveLength(50);
    expect(rows.every((row) => typeof row.resetEpoch === 'number')).toBe(true);
  }, 120000);

  it('(d) two submits racing a verdict that holds the lock count one attempt', async () => {
    const enrollment = await db.getRepository(EnrollmentEntity).findOneByOrFail({ userId: learner, projectSlug: TEACHER });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const verdict = db.transaction(async (manager) => {
      await manager.findOneOrFail(EnrollmentEntity, { where: { id: enrollment.id }, lock: { mode: 'pessimistic_write' } });
      await held;
    });
    const [one, two] = [await load(), await load()];
    const racing = Promise.all([
      feedback.submit(one.phase, one.state, undefined, 'story'),
      feedback.submit(two.phase, two.state, undefined, 'story'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await verdict;
    const [a, b] = await within(5000, racing);
    expect(a.id).toBe(b.id);
    expect(await db.getRepository(SubmissionEntity).count({ where: { phaseStateId: requirementsId } })).toBe(1);
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: requirementsId })).attempts).toBe(1);
    expect((await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: requirementsId, taskKey: 'story' })).attempts).toBe(1);
    // The loser found the winner under the lock and spent nothing there.
    expect(spentUnderLock).toBe(1);
  }, 30000);

  it('(e) a learner reset started while submit holds the lock waits, then refuses', async () => {
    await workflow.saveWorkspace(learner, requirementsId, { [E0]: 'held under the lock' });
    const { state, phase } = await load();
    const version = await versionOf();
    let reset: Promise<unknown> | null = null;
    let countWhileHeld: number | null = null;
    inner = async () => {
      reset = workflow.resetTask(learner, requirementsId, 'story', version).then((ok) => ok, (err) => err);
      await new Promise((resolve) => setTimeout(resolve, 400));
      countWhileHeld = (await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: requirementsId, taskKey: 'story' })).resetCount;
    };
    const view = await within(5000, feedback.submit(phase, state, undefined, 'story'));
    expect(reset).not.toBeNull();
    const outcome = await within(5000, reset!);
    // Nothing of the reset committed while the submit held the lock.
    expect(countWhileHeld).toBe(0);
    expect(outcome).toBeInstanceOf(ConflictException);
    expect((outcome as ConflictException).message).toBe(RESET_REFUSALS.submissionInFlight);
    const row = await db.getRepository(SubmissionEntity).findOneByOrFail({ id: view.id });
    expect(row.workspaceSnapshot?.[E0]).toBe('held under the lock');
    expect(row.resetEpoch).toBe(0);
    expect((await db.getRepository(TaskStateEntity).findOneByOrFail({ phaseStateId: requirementsId, taskKey: 'story' })).resetCount).toBe(0);
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: requirementsId })).workspace?.[E0]).toBe('held under the lock');
  }, 30000);

  it('(f) on PostgreSQL: all but the newest three copies emptied, none deleted, a second sweep writes nothing', async () => {
    for (let i = 0; i < 5; i += 1) {
      await workflow.saveWorkspace(learner, requirementsId, { [E0]: `copy ${i}` });
      await workflow.resetTask(learner, requirementsId, 'story', await versionOf());
    }
    const copies = db.getRepository(TaskResetEntity);
    expect(await copies.count()).toBe(5);
    const retention = new RetentionService(db);
    expect(await retention.pruneResetCopies()).toBe(2);
    expect(await retention.pruneResetCopies()).toBe(0);
    const rows = await copies.find({ order: { createdAt: 'ASC', id: 'ASC' } });
    expect(rows.map((row) => row.files[E0] ?? null)).toEqual([null, null, 'copy 2', 'copy 3', 'copy 4']);
  }, 30000);
});
