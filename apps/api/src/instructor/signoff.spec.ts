import 'reflect-metadata';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { BulkSignoffBody } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
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
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { atomic } from '../db/atomic';
import { FeedbackService } from '../feedback/feedback.service';
import type { InstructorCaller } from './cohort-scope';
import { InstructorService } from './instructor.service';
import { SIGNOFF_BATCH_MAX, SIGNOFF_REFUSALS, SignoffService } from './signoff';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The sign-off queue and the bulk sign-off; per class, per task, one reason
 * per batch, one audit row
 * (`class.bulk-signoff`) per learner, one transaction per learner in sorted
 * enrolment order, partial results reported.
 *
 * The board every case starts from is the one a `signOff` task leaves behind
 * once its evidence is in: the sibling `story` passed, `interview` carrying
 * `awaitingSignOff`, the phase `submitted`; the door shut until a teacher
 * countersigns.
 */

const TEACHER = 'ms-sign-copy';
const V_SPLIT = 'v-sign-split';
const reason = 'Interviews heard in the Monday lab, all four.';

/** The split the queue exists for: a required task and a required countersigned one. */
function splitTasks(requirements: PhaseContent): CompiledTask[] {
  const base = soleTaskFor(requirements);
  return [
    { ...base, taskKey: 'story', order: 1, title: 'The story', gradedUnits: [{ kind: 'rule', id: 'story-format' }] },
    {
      ...base,
      taskKey: 'interview',
      order: 2,
      title: 'The customer interview',
      signOff: true,
      gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }],
    },
  ];
}

describe('SignoffService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let signoff: SignoffService;
  let instructor: InstructorService;
  let teacher: ProjectContent;
  let tasks: CompiledTask[];

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let admin: InstructorCaller;
  let tuesday = '';
  let thursday = '';
  /** Tuesday's learners, in the order their accounts were made. */
  let lee = '';
  let kai = '';
  let mei = '';
  /** Thursday's learner: never Dana's to touch. */
  let ola = '';

  const manager = () => dataSource.manager;

  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }));

  /**
   * One learner on the split copy, pinned to it, the requirements phase left
   * where a passed `story` and an awaited `interview` leave it.
   */
  async function board(
    userId: string,
    over: { interview?: Partial<TaskStateEntity>; story?: Partial<TaskStateEntity>; phase?: Partial<PhaseStateEntity> } = {},
  ): Promise<{ enrollment: EnrollmentEntity; requirements: PhaseStateEntity }> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId, projectSlug: TEACHER, projectVersionId: V_SPLIT, currentPhaseOrder: 1 }),
    );
    let requirements!: PhaseStateEntity;
    for (const phase of teacher.phases) {
      const row = await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId,
          phaseKey: phase.key,
          phaseOrder: phase.order,
          status: phase.order === 1 ? 'submitted' : 'locked',
          bestScore: phase.order === 1 ? 80 : null,
          ...(phase.order === 1 ? over.phase ?? {} : {}),
        }),
      );
      if (phase.key === 'requirements') requirements = row;
    }
    await manager().save(
      manager().create(TaskStateEntity, {
        phaseStateId: requirements.id,
        userId,
        taskKey: 'story',
        status: 'passed',
        passedAt: '2026-09-02T09:00:00.000Z',
        bestScore: 80,
        ...over.story,
      }),
    );
    await manager().save(
      manager().create(TaskStateEntity, {
        phaseStateId: requirements.id,
        userId,
        taskKey: 'interview',
        // What the grader writes for a passing verdict on a countersigned task.
        status: 'submitted',
        bestScore: 75,
        awaitingSignOff: true,
        ...over.interview,
      }),
    );
    return { enrollment, requirements };
  }

  const rowOf = (phaseStateId: string, taskKey: string) =>
    manager().findOneByOrFail(TaskStateEntity, { phaseStateId, taskKey });
  const phaseOf = (id: string) => manager().findOneByOrFail(PhaseStateEntity, { id });
  const bulkRows = () => manager().find(AuditEventEntity, { where: { event: 'class.bulk-signoff' as never } });

  const body = (userIds: string[], over: Partial<BulkSignoffBody> = {}): BulkSignoffBody => ({
    phaseKey: 'requirements',
    taskKey: 'interview',
    userIds,
    reason,
    ...over,
  });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const loader = new ContentService();
    loader.loadAll();
    const shipped = loader.getProject('tasktrackr');
    teacher = { ...shipped, slug: TEACHER, title: 'Sign-off copy' };
    const requirements = teacher.phases.find((phase) => phase.key === 'requirements')!;
    tasks = splitTasks(requirements);
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      {
        versionId: V_SPLIT,
        content: teacher,
        compiler: COMPILER_IDENTITY,
        phases: teacher.phases.map((phase) =>
          phase.key === 'requirements' ? { key: phase.key, tasks } : { key: phase.key, tasks: [soleTaskFor(phase)] },
        ),
      },
    ]);
    signoff = new SignoffService(dataSource, content);
    instructor = new InstructorService(dataSource, content, { tokensToday: async () => 0 } as never);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const danaRow = await saveUser({ email: 'dana@sign.test', role: 'INSTRUCTOR', displayName: 'Dana' });
    const samRow = await saveUser({ email: 'sam@sign.test', role: 'INSTRUCTOR', displayName: 'Sam' });
    const adminRow = await saveUser({ email: 'ops@sign.test', role: 'ADMIN', displayName: 'Ops' });
    tuesday = (await manager().save(manager().create(CohortEntity, { name: 'Tuesday', joinCode: 'SIGNTUES', ownerUserId: danaRow.id }))).id;
    thursday = (await manager().save(manager().create(CohortEntity, { name: 'Thursday', joinCode: 'SIGNTHUR', ownerUserId: samRow.id }))).id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday };
    admin = { id: adminRow.id, role: 'ADMIN', cohort: 'default' };
    lee = (await saveUser({ email: 'lee@sign.test', displayName: 'Lee', cohort: tuesday })).id;
    kai = (await saveUser({ email: 'kai@sign.test', displayName: 'Kai', cohort: tuesday })).id;
    mei = (await saveUser({ email: 'mei@sign.test', displayName: 'Mei', cohort: tuesday })).id;
    ola = (await saveUser({ email: 'ola@sign.test', displayName: 'Ola', cohort: thursday })).id;
  });

  /* ------------------------------- red first ------------------------------ */

  it('bulk sign-off writes one audited row per learner and opens each phase exactly once', async () => {
    const leeBoard = await board(lee);
    const kaiBoard = await board(kai);

    const result = await signoff.bulk(dana, tuesday, body([lee, kai]));

    expect(new Set(result.signedOff)).toEqual(new Set([lee, kai]));
    expect(result.refused).toEqual([]);
    for (const { requirements } of [leeBoard, kaiBoard]) {
      const interview = await rowOf(requirements.id, 'interview');
      // The countersignature is the second half: once it lands nothing is awaited.
      expect([interview.status, interview.awaitingSignOff, interview.signedOffBy]).toEqual(['passed', false, dana.id]);
      expect(interview.signedOffAt).toEqual(expect.any(String));
      const phase = await phaseOf(requirements.id);
      expect(phase.status).toBe('passed');
      expect(phase.passedAt).toEqual(expect.any(String));
    }
    const rows = await bulkRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.subjectUserId))).toEqual(new Set([lee, kai]));
    for (const row of rows) {
      // One reason for the batch, on every learner's row.
      expect(row.reason).toBe(reason);
      expect(row.actorUserId).toBe(dana.id);
      expect(row.detail).toMatchObject({
        cohortId: tuesday,
        projectSlug: TEACHER,
        phaseKey: 'requirements',
        taskKey: 'interview',
        taskTitle: 'The customer interview',
      });
    }
    // No per-learner `task.signoff` beside it: one row per learner, not two.
    expect(await manager().count(AuditEventEntity)).toBe(2);

    // A second batch opens nothing a second time and writes nothing.
    const opened = await phaseOf(leeBoard.requirements.id);
    const again = await signoff.bulk(dana, tuesday, body([lee, kai]));
    expect(again.signedOff).toEqual([]);
    expect(again.refused.map((one) => one.userId).sort()).toEqual([lee, kai].sort());
    for (const one of again.refused) expect(one.sentence).toBe(SIGNOFF_REFUSALS.alreadyPassed('The customer interview'));
    expect((await phaseOf(leeBoard.requirements.id)).passedAt).toBe(opened.passedAt);
    expect(await bulkRows()).toHaveLength(2);
  });

  it('an empty reason is refused, and nothing is written', async () => {
    const { requirements } = await board(lee);
    for (const empty of ['', '   ', 'too short']) {
      await expect(signoff.bulk(dana, tuesday, body([lee], { reason: empty }))).rejects.toBeInstanceOf(BadRequestException);
    }
    expect((await rowOf(requirements.id, 'interview')).status).toBe('submitted');
    expect((await rowOf(requirements.id, 'interview')).awaitingSignOff).toBe(true);
    expect((await phaseOf(requirements.id)).status).toBe('submitted');
    expect(await manager().count(AuditEventEntity)).toBe(0);
  });

  it('a learner outside the caller’s class is untouched (404 for a foreign class, no row)', async () => {
    await board(lee);
    const olaBoard = await board(ola);

    // Sam's class, asked by Dana: a 404, never a 403, and nothing read or written.
    await expect(signoff.bulk(dana, thursday, body([ola]))).rejects.toBeInstanceOf(NotFoundException);
    await expect(signoff.queue(dana, thursday)).rejects.toBeInstanceOf(NotFoundException);
    // A class that does not exist at all answers the same.
    await expect(signoff.bulk(dana, '00000000-0000-4000-8000-000000000000', body([lee]))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(signoff.bulk(dana, 'not-a-uuid', body([lee]))).rejects.toBeInstanceOf(NotFoundException);

    // Dana's class, naming Sam's learner among her own: Ola is refused by one
    // sentence and untouched; Lee is signed off.
    const mixed = await signoff.bulk(dana, tuesday, body([lee, ola]));
    expect(mixed.signedOff).toEqual([lee]);
    expect(mixed.refused).toEqual([{ userId: ola, sentence: SIGNOFF_REFUSALS.notInClass }]);
    const olaInterview = await rowOf(olaBoard.requirements.id, 'interview');
    expect([olaInterview.status, olaInterview.awaitingSignOff, olaInterview.signedOffBy]).toEqual(['submitted', true, null]);
    expect((await phaseOf(olaBoard.requirements.id)).status).toBe('submitted');
    expect((await bulkRows()).map((row) => row.subjectUserId)).toEqual([lee]);
  });

  /* -------------------------------- guards -------------------------------- */

  it('GUARD › per-learner sign-off behaves exactly as today', async () => {
    const leeBoard = await board(lee);
    const kaiBoard = await board(kai);

    await instructor.overridePhase(dana, lee, leeBoard.requirements.id, 'task-signoff', reason, 'interview');
    await signoff.bulk(dana, tuesday, body([kai]));

    // The same board, by the two doors, ends in the same columns.
    const columns = async (phaseStateId: string) => {
      const interview = await rowOf(phaseStateId, 'interview');
      const story = await rowOf(phaseStateId, 'story');
      const phase = await phaseOf(phaseStateId);
      return {
        interview: [interview.status, interview.bestScore, interview.awaitingSignOff, interview.signedOffBy, interview.passedAt !== null],
        story: [story.status, story.bestScore, story.passedAt],
        phase: [phase.status, phase.bestScore, phase.passedAt !== null],
      };
    };
    expect(await columns(kaiBoard.requirements.id)).toEqual(await columns(leeBoard.requirements.id));
    // The per-learner door still leaves its own event, and only its own.
    const events = (await manager().find(AuditEventEntity)).map((row) => [row.event, row.subjectUserId]);
    expect(events).toEqual(expect.arrayContaining([['task.signoff', lee], ['class.bulk-signoff', kai]]));
    expect(events).toHaveLength(2);
  });

  it('GUARD › a batch sign-off after a learner retry writes the new pass date, as the per-learner door does', async () => {
    // A retry keeps the earlier `passedAt` and moves `resetAt` past it.
    const earlier = '2026-09-02T09:00:00.000Z';
    const { requirements } = await board(lee, {
      interview: { passedAt: earlier, resetAt: '2026-09-05T09:00:00.000Z', resetCount: 1 },
    });
    const before = new Date().toISOString();
    expect((await signoff.bulk(dana, tuesday, body([lee]))).signedOff).toEqual([lee]);
    const interview = await rowOf(requirements.id, 'interview');
    expect(interview.status).toBe('passed');
    expect(interview.passedAt! >= before).toBe(true);
  });

  it('GUARD › a teacher’s pass never writes passed on a signOff task, so the door stays shut until the countersignature', async () => {
    const { requirements } = await board(lee, { story: { status: 'in_progress', passedAt: null }, phase: { status: 'in_progress' } });
    const view = await instructor.overridePhase(dana, lee, requirements.id, 'pass', reason);
    expect((await rowOf(requirements.id, 'story')).status).toBe('passed');
    const interview = await rowOf(requirements.id, 'interview');
    expect(interview.status).not.toBe('passed');
    expect(interview.awaitingSignOff).toBe(true);
    expect(view.note).toContain('countersignature');
  });

  it('the door stays shut until the countersignature, and a sign-off alone opens no phase another task still holds', async () => {
    // The sibling has not passed: the countersignature lands, the phase stays shut.
    const shut = await board(lee, { story: { status: 'in_progress', passedAt: null, bestScore: 40 } });
    const before = await phaseOf(shut.requirements.id);
    expect(before.status).toBe('submitted');
    const result = await signoff.bulk(dana, tuesday, body([lee]));
    expect(result.signedOff).toEqual([lee]);
    expect((await rowOf(shut.requirements.id, 'interview')).status).toBe('passed');
    const after = await phaseOf(shut.requirements.id);
    expect(after.status).toBe('submitted');
    expect(after.passedAt).toBeNull();
  });

  /* ------------------------- refusals, one learner each ------------------------ */

  it('refuses, by one sentence each, what is not awaiting a countersignature, and touches nothing', async () => {
    const leeBoard = await board(lee, { interview: { awaitingSignOff: false } }); // no evidence in yet
    const kaiBoard = await board(kai);
    // Mei has no enrolment at all.
    const result = await signoff.bulk(dana, tuesday, body([lee, kai, mei]));
    expect(result.signedOff).toEqual([kai]);
    expect(result.refused).toEqual(
      expect.arrayContaining([
        { userId: lee, sentence: SIGNOFF_REFUSALS.notAwaiting('The customer interview') },
        { userId: mei, sentence: SIGNOFF_REFUSALS.notAwaiting('interview') },
      ]),
    );
    expect(result.refused).toHaveLength(2);
    expect((await rowOf(leeBoard.requirements.id, 'interview')).status).toBe('submitted');
    expect((await phaseOf(kaiBoard.requirements.id)).status).toBe('passed');

    // A task that is not a countersigned one, and a key the version does not declare.
    const story = await signoff.bulk(dana, tuesday, body([lee], { taskKey: 'story' }));
    expect(story.refused).toEqual([{ userId: lee, sentence: SIGNOFF_REFUSALS.notSignOff('The story') }]);
    const unknown = await signoff.bulk(dana, tuesday, body([lee], { taskKey: 'epic' }));
    expect(unknown.refused).toEqual([{ userId: lee, sentence: SIGNOFF_REFUSALS.notAwaiting('epic') }]);
    expect(await bulkRows()).toHaveLength(1);
  });

  it('refuses a malformed batch before anything is read', async () => {
    await board(lee);
    const bad: BulkSignoffBody[] = [
      body([]),
      body([lee, lee]),
      body(['not-a-uuid']),
      body(Array.from({ length: SIGNOFF_BATCH_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)),
      body([lee], { phaseKey: 'nowhere' as never }),
      body([lee], { taskKey: '' }),
      body([lee], { taskKey: 'x'.repeat(33) }),
    ];
    for (const one of bad) await expect(signoff.bulk(dana, tuesday, one)).rejects.toBeInstanceOf(BadRequestException);
    expect(await manager().count(AuditEventEntity)).toBe(0);
  });

  it('one transaction per learner, in sorted enrolment order, with partial results reported', async () => {
    const boards = new Map<string, EnrollmentEntity>();
    for (const id of [lee, kai, mei]) boards.set(id, (await board(id)).enrollment);
    const sorted = [lee, kai, mei].sort((a, b) => (boards.get(a)!.id < boards.get(b)!.id ? -1 : 1));
    const middle = sorted[1];

    // The middle learner's write fails inside its own transaction: the
    // learners either side of it commit, and the middle one is reported.
    const original = content.getTasksForEnrollment.bind(content);
    jest.spyOn(content, 'getTasksForEnrollment').mockImplementation((enrollment, phaseKey) => {
      if ((enrollment as EnrollmentEntity).userId === middle) throw new Error('the pinned version could not be read');
      return original(enrollment, phaseKey);
    });
    const transactions = jest.spyOn(dataSource, 'transaction');

    const result = await signoff.bulk(dana, tuesday, body([mei, lee, kai]));

    expect(result.signedOff).toEqual(sorted.filter((id) => id !== middle));
    expect(result.refused).toEqual([{ userId: middle, sentence: SIGNOFF_REFUSALS.unreadable }]);
    expect(transactions).toHaveBeenCalledTimes(3);
    // (`signedOff` above is the processing order; SQLite stamps both rows in one second.)
    const rows = await manager().find(AuditEventEntity);
    expect(rows.map((row) => row.subjectUserId).sort()).toEqual(sorted.filter((id) => id !== middle).sort());
    expect((await rowOf((await manager().findOneByOrFail(PhaseStateEntity, { enrollmentId: boards.get(middle)!.id, phaseKey: 'requirements' })).id, 'interview')).status).toBe('submitted');
  });

  /* -------------------------- edge cases -------------------------------------- */

  it('refuses a learner whose newer revision of the task is still being marked, and touches nothing', async () => {
    const { requirements } = await board(lee);
    await board(kai);
    await manager().save(
      manager().create(SubmissionEntity, { phaseStateId: requirements.id, userId: lee, taskKey: 'interview', status: 'queued' }),
    );
    const result = await signoff.bulk(dana, tuesday, body([lee, kai]));
    expect(result.signedOff).toEqual([kai]);
    expect(result.refused).toEqual([{ userId: lee, sentence: SIGNOFF_REFUSALS.marking('The customer interview') }]);
    const interview = await rowOf(requirements.id, 'interview');
    expect([interview.status, interview.awaitingSignOff, interview.signedOffBy]).toEqual(['submitted', true, null]);
    expect((await phaseOf(requirements.id)).status).toBe('submitted');
  });

  it('takes a learner id in either case, reports refusals in the order named, and records the batch as asked', async () => {
    await board(lee);
    await board(kai);
    const result = await signoff.bulk(dana, tuesday, body([ola, lee.toUpperCase(), mei, kai]));
    expect(result.signedOff.sort()).toEqual([lee, kai].sort());
    expect(result.refused.map((one) => one.userId)).toEqual([ola, mei]);
    const rows = await bulkRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.detail).toMatchObject({ batchSize: 4 });
    // The same learner twice, in two cases, is one learner named twice.
    await expect(signoff.bulk(dana, tuesday, body([kai, kai.toUpperCase()]))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('awaitingSince is when the task began waiting, not the row’s last write', async () => {
    const { requirements } = await board(lee);
    const first = new Date('2026-09-02T09:30:00.000Z');
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: requirements.id,
        userId: lee,
        taskKey: 'interview',
        status: 'completed',
        passed: true,
        score: 75,
        createdAt: first,
      }),
    );
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: requirements.id,
        userId: lee,
        taskKey: 'interview',
        status: 'completed',
        passed: true,
        score: 80,
        createdAt: new Date('2026-09-04T09:30:00.000Z'),
      }),
    );
    await manager().update(TaskStateEntity, { phaseStateId: requirements.id, taskKey: 'interview' }, { bestScore: 80 });
    const view = await signoff.queue(dana, tuesday);
    expect(view.rows.map((row) => row.awaitingSince)).toEqual([first.toISOString()]);
  });

  /* --------------------------------- queue -------------------------------- */

  it('the queue lists the class’s awaited tasks, by learner and task, and nothing else', async () => {
    await board(lee);
    await board(kai, { interview: { awaitingSignOff: false } });
    await board(mei, { interview: { status: 'passed', awaitingSignOff: false, passedAt: '2026-09-03T09:00:00.000Z' } });
    await board(ola);

    const view = await signoff.queue(dana, tuesday);
    expect(view.cohortId).toBe(tuesday);
    expect(view.rows).toEqual([
      {
        userId: lee,
        learnerName: 'Lee',
        phaseKey: 'requirements',
        taskKey: 'interview',
        taskTitle: 'The customer interview',
        awaitingSince: expect.any(String),
      },
    ]);
    expect(Number.isNaN(Date.parse(view.rows[0].awaitingSince))).toBe(false);
    // Sam reads his own class and only his own.
    expect((await signoff.queue(sam, thursday)).rows.map((row) => row.userId)).toEqual([ola]);
    // An admin reads any class.
    expect((await signoff.queue(admin, tuesday)).rows.map((row) => row.userId)).toEqual([lee]);
    // The read writes nothing.
    expect(await manager().count(AuditEventEntity)).toBe(0);

    // After the bulk sign-off the queue is empty.
    await signoff.bulk(dana, tuesday, body([lee]));
    expect((await signoff.queue(dana, tuesday)).rows).toEqual([]);
  });
});

/* ======================= PostgreSQL 16, two connections ======================= */

/**
 * `bulk sign-off beside a learner's submit neither deadlocks nor opens a phase
 * twice`, on the loopback cluster (configured through `POSTGRES_TEST_CONFIG`).
 * The learner's half is `FeedbackService.writeVerdict` itself (the writer a
 * graded submit lands through) for the sibling `story`, racing the teacher's
 * countersignature of `interview`. A trigger on `phase_states` records every
 * transition into `passed` and every rewrite of a passed phase's `passedAt`,
 * so "opened exactly once" is read from the database rather than inferred.
 *
 * Self-skips without `POSTGRES_TEST_CONFIG`; refuses any database but
 * `lsdlc_numbers` / `lsdlc_pgspecs` on 127.0.0.1:5494; works in a scratch
 * schema it drops.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rx_sign';
const PG_SLUG = 'ms-sign-race';
const PG_VERSION = 'v-sign-race';

describePg('bulk sign-off beside a learner’s submit (PostgreSQL 16, two connections)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);
  let content: ContentService;
  let signoff: SignoffService;
  let feedback: FeedbackService;
  let tasks: CompiledTask[];
  let teacher: ProjectContent;
  let staff: InstructorCaller;
  let cohortId = '';
  let learners: string[] = [];

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
    Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    db = await new DataSource({
      ...postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 12 },
    } as never).initialize();
    await db.runMigrations({ transaction: 'all' });
    await db.query(`CREATE TABLE "${schema}"."rx_sign_opened" ("phaseStateId" varchar NOT NULL, "kind" varchar NOT NULL)`);
    await db.query(`
      CREATE FUNCTION "${schema}".rx_sign_watch() RETURNS trigger AS $$
      BEGIN
        IF NEW."status" = 'passed' AND OLD."status" IS DISTINCT FROM 'passed' THEN
          INSERT INTO "${schema}"."rx_sign_opened" VALUES (NEW."id", 'opened');
        END IF;
        IF OLD."status" = 'passed' AND OLD."passedAt" IS DISTINCT FROM NEW."passedAt" THEN
          INSERT INTO "${schema}"."rx_sign_opened" VALUES (NEW."id", 'rewritten');
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.query(
      `CREATE TRIGGER rx_sign_watch AFTER UPDATE ON "${schema}"."phase_states" FOR EACH ROW EXECUTE FUNCTION "${schema}".rx_sign_watch()`,
    );

    const loader = new ContentService();
    loader.loadAll();
    const shipped = loader.getProject('tasktrackr');
    teacher = { ...shipped, slug: PG_SLUG, title: 'Race copy', version: '1.0.0' };
    const requirements = teacher.phases.find((phase) => phase.key === 'requirements')!;
    tasks = splitTasks(requirements);
    const inherited: Record<string, AuthoredTask[]> = Object.fromEntries(
      teacher.phases.map((phase) => [
        phase.key,
        [{ taskKey: 'main', order: 1, owns: editablePathsOf(phase), gradedUnits: gradedUnitsOf(phase) }],
      ]),
    );
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      {
        versionId: PG_VERSION,
        content: teacher,
        compiler: COMPILER_IDENTITY,
        phases: compilePack(teacher, { authored: inherited }).phases.map((entry) =>
          entry.key === 'requirements' ? { key: entry.key, tasks } : entry,
        ),
      },
    ]);
    signoff = new SignoffService(db, content);
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
    const users = db.getRepository(UserEntity);
    const teacherRow = await users.save(
      users.create({ email: `t-${schema}@example.invalid`, passwordHash: 'x', displayName: 'Teacher', role: 'INSTRUCTOR' as never }),
    );
    cohortId = (
      await db.getRepository(CohortEntity).save(
        db.getRepository(CohortEntity).create({ name: 'Race class', joinCode: schema.slice(-8).toUpperCase(), ownerUserId: teacherRow.id }),
      )
    ).id;
    staff = { id: teacherRow.id, role: 'INSTRUCTOR', cohort: cohortId };
    learners = [];
    for (const name of ['ann', 'ben']) {
      learners.push(
        (await users.save(users.create({ email: `${name}-${schema}@example.invalid`, passwordHash: 'x', displayName: name, cohort: cohortId }))).id,
      );
    }
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  }, 180000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  /** Both learners' boards: `story` not yet graded, `interview` awaiting the countersignature. */
  async function fresh(): Promise<PhaseStateEntity[]> {
    for (const table of ['rx_sign_opened', 'audit_events', 'task_states', 'phase_states', 'releases', 'enrollments']) {
      await db.query(`DELETE FROM "${schema}"."${table}"`).catch(() => undefined);
    }
    const out: PhaseStateEntity[] = [];
    for (const userId of learners) {
      const enrollment = await db.getRepository(EnrollmentEntity).save(
        db.getRepository(EnrollmentEntity).create({ userId, projectSlug: PG_SLUG, projectVersionId: PG_VERSION, currentPhaseOrder: 1 }),
      );
      for (const phase of teacher.phases) {
        const row = await db.getRepository(PhaseStateEntity).save(
          db.getRepository(PhaseStateEntity).create({
            enrollmentId: enrollment.id,
            userId,
            phaseKey: phase.key,
            phaseOrder: phase.order,
            status: phase.order === 1 ? 'submitted' : 'locked',
          }),
        );
        if (phase.key === 'requirements') out.push(row);
      }
      const requirements = out[out.length - 1];
      await db.getRepository(TaskStateEntity).save([
        db.getRepository(TaskStateEntity).create({ phaseStateId: requirements.id, userId, taskKey: 'story', status: 'in_progress', bestScore: 40 }),
        db.getRepository(TaskStateEntity).create({
          phaseStateId: requirements.id,
          userId,
          taskKey: 'interview',
          status: 'submitted',
          bestScore: 75,
          awaitingSignOff: true,
        }),
      ]);
    }
    return out;
  }

  /** The learner's graded submit of `story` landing, through the grader's own writer; `hold` keeps its lock. */
  const verdict = (state: PhaseStateEntity, hold?: () => Promise<void>) =>
    atomic(db, async (tx) => {
      await (feedback as any).writeVerdict(
        tx,
        state,
        tasks,
        tasks.find((task) => task.taskKey === 'story')!,
        { passed: true, overall: 90 },
        new Date().toISOString(),
      );
      if (hold) await hold();
    });

  async function settled(states: PhaseStateEntity[]): Promise<void> {
    const marks: { phaseStateId: string; kind: string }[] = await db.query(`SELECT * FROM "${schema}"."rx_sign_opened"`);
    for (const state of states) {
      const phase = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: state.id });
      expect([state.id, phase.status]).toEqual([state.id, 'passed']);
      expect(marks.filter((mark) => mark.phaseStateId === state.id).map((mark) => mark.kind)).toEqual(['opened']);
      const rows = await db.getRepository(TaskStateEntity).find({ where: { phaseStateId: state.id } });
      expect(rows.every((row) => row.status === 'passed' && !row.awaitingSignOff)).toBe(true);
    }
    const audit = await db.getRepository(AuditEventEntity).find();
    expect(audit.map((row) => row.event)).toEqual(states.map(() => 'class.bulk-signoff'));
  }

  const bulk = () =>
    signoff.bulk(staff, cohortId, { phaseKey: 'requirements', taskKey: 'interview', userIds: [...learners], reason });

  it('the learner’s verdict holds the lock first: the sign-off waits, then opens each phase once', async () => {
    const states = await fresh();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const learnerSide = verdict(states[0], async () => {
      entered();
      await sleep(400);
    });
    await inside;
    const teacherSide = bulk();
    const [, result] = await within(5000, Promise.all([learnerSide, teacherSide]));
    await verdict(states[1]);
    expect(result.signedOff.sort()).toEqual([...learners].sort());
    await settled(states);
  });

  it('the sign-off holds the lock first: the verdict waits, then opens the phase once', async () => {
    const states = await fresh();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const lockFor = (SignoffService.prototype as any).lockEnrolment;
    jest.spyOn(SignoffService.prototype as any, 'lockEnrolment').mockImplementationOnce(async function (this: unknown, ...args: unknown[]) {
      const out = await lockFor.apply(this, args);
      entered();
      await sleep(400);
      return out;
    });
    const teacherSide = bulk();
    await inside;
    const learnerSide = Promise.all(states.map((state) => verdict(state)));
    const [result] = await within(5000, Promise.all([teacherSide, learnerSide]));
    expect(result.signedOff.sort()).toEqual([...learners].sort());
    await settled(states);
  });

  it('twenty unforced interleavings: no deadlock, no phase opened twice', async () => {
    for (let round = 0; round < 20; round += 1) {
      const states = await fresh();
      const jitter = () => sleep(Math.floor(Math.random() * 15));
      const [result] = await within(
        5000,
        Promise.all([
          jitter().then(bulk),
          ...states.map((state) => jitter().then(() => verdict(state))),
        ]),
      );
      expect(result.signedOff.sort()).toEqual([...learners].sort());
      await settled(states);
    }
  }, 120000);
});

