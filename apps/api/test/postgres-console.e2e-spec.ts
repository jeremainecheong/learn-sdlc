import { DataSource, EntityManager, In } from 'typeorm';
import { newestSubmissionsPerPhaseState } from '../src/analytics/queries';
import { ALL_ENTITIES } from '../src/db/entities';
import {
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  UserEntity,
} from '../src/db/entities';
import { InstructorService } from '../src/instructor/instructor.service';
import { auditCursor } from '../src/instructor/audit-cursor';
import { describeIfPostgres } from './support/postgres';

/**
 * The instructor console's two heaviest reads, against a real PostgreSQL.
 *
 * Both can break on Postgres in ways sqlite cannot show, because sqlite has no
 * uuid type and compares identifiers without case. The failures this guards
 * against:
 *
 *  - `m.maxAt` unquoted in the newest-per-phase join: Postgres folds an
 *    unquoted identifier to lower case and answers
 *    `column m.maxat does not exist`.
 *  - `MAX(id)` over a uuid column: `function max(uuid) does not exist`: the
 *    aggregate arrived in PostgreSQL 18 and `docker-compose.yml` pins 16.
 *  - `users.id = audit_events.subjectUserId` in the class-scope EXISTS: uuid
 *    against varchar, `operator does not exist: uuid = character varying`.
 *
 * None of them can be caught by a suite that only runs on sqlite, and the
 * production-stack CI job's two journey scripts are learner journeys that
 * never open the console. This runs wherever `DATABASE_URL` is set (that job,
 * or a developer with a local server) and skips otherwise, because a check
 * that silently passes when it could not run is worse than no check.
 *
 * It creates its own rows, all tagged with one run id, and deletes exactly
 * those in afterAll: it may run against a database that holds other things.
 */
const url = process.env.DATABASE_URL;

describeIfPostgres('the instructor console reads on PostgreSQL', () => {
  const run = Math.random().toString(36).slice(2, 8);
  const tag = (name: string) => `${name}-${run}@postgres-console.test`;

  let ds: DataSource;
  let m: EntityManager;
  let service: InstructorService;
  let caller: { id: string; role: 'INSTRUCTOR'; cohort: string };
  let cohortId = '';
  let staffId = '';
  const learnerIds: string[] = [];
  const phaseStateIds: string[] = [];
  const auditIds: string[] = [];
  /** phaseStateId → the id `ORDER BY createdAt DESC, id DESC LIMIT 1` picks. */
  const newestOf = new Map<string, string>();

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url, entities: ALL_ENTITIES, synchronize: false });
    await ds.initialize();
    m = ds.manager;

    const staff = await m.save(
      m.create(UserEntity, {
        email: tag('instructor'),
        displayName: 'Console instructor',
        passwordHash: 'x',
        role: 'INSTRUCTOR',
        cohort: 'default',
      }),
    );
    staffId = staff.id;
    const cohort = await m.save(
      m.create(CohortEntity, {
        name: `Console ${run}`,
        joinCode: `PG${run.toUpperCase()}`,
        ownerUserId: staff.id,
      }),
    );
    cohortId = cohort.id;
    await m.update(UserEntity, { id: staff.id }, { cohort: cohort.id });
    caller = { id: staff.id, role: 'INSTRUCTOR', cohort: cohort.id };

    // Two learners, one phase each, three attempts each: the newest two
    // sharing a timestamp, which is the tie the id has to break.
    const tie = new Date('2026-09-04T10:00:00.000Z');
    for (const n of [1, 2]) {
      const learner = await m.save(
        m.create(UserEntity, {
          email: tag(`learner${n}`),
          displayName: `Learner ${n}`,
          passwordHash: 'x',
          role: 'LEARNER',
          cohort: cohort.id,
        }),
      );
      learnerIds.push(learner.id);
      const enrollment = await m.save(
        m.create(EnrollmentEntity, {
          userId: learner.id,
          projectSlug: 'tasktrackr',
          currentPhaseOrder: 1,
        }),
      );
      const state = await m.save(
        m.create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId: learner.id,
          phaseKey: 'requirements',
          phaseOrder: 1,
          status: 'in_progress',
          attempts: 0,
        }),
      );
      phaseStateIds.push(state.id);

      await m.save(
        m.create(SubmissionEntity, {
          phaseStateId: state.id,
          userId: learner.id,
          status: 'completed',
          score: 40,
          passed: false,
          createdAt: new Date('2026-09-03T10:00:00.000Z'),
        }),
      );
      const first = await m.save(
        m.create(SubmissionEntity, {
          phaseStateId: state.id,
          userId: learner.id,
          status: 'completed',
          score: 71,
          passed: true,
        }),
      );
      const second = await m.save(
        m.create(SubmissionEntity, {
          phaseStateId: state.id,
          userId: learner.id,
          status: 'completed',
          score: 88,
          passed: true,
        }),
      );
      await m.query('UPDATE submissions SET "createdAt" = $1 WHERE id = ANY($2)', [
        tie,
        [first.id, second.id],
      ]);
      const [top] = await m.query(
        'SELECT id FROM submissions WHERE "phaseStateId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 1',
        [state.id],
      );
      newestOf.set(state.id, top.id);
    }

    // Nine audit rows, in pairs sharing a timestamp, so paging has to use both
    // halves of the cursor.
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      const row = await m.save(
        m.create(AuditEventEntity, {
          actorUserId: staff.id,
          subjectUserId: learnerIds[i % 2],
          event: 'phase.override',
          detail: { i },
          reason: `console row ${i}`,
          createdAt: new Date(now - Math.floor(i / 2) * 60_000),
        }),
      );
      auditIds.push(row.id);
    }

    service = new InstructorService(
      ds,
      // `getForEnrollment` beside `getProject`: the console's learner card,
      // override and dossier resolve through the enrolment,
      // and these rows carry no pin, so both answer the same project.
      {
        getProject: () => ({ slug: 'tasktrackr', title: 'TaskTrackr', version: '1.0.0' }),
        getForEnrollment: () => ({ slug: 'tasktrackr', title: 'TaskTrackr', version: '1.0.0' }),
      } as never,
      {} as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    if (auditIds.length) await m.delete(AuditEventEntity, { id: In(auditIds) });
    if (phaseStateIds.length) {
      await m.delete(SubmissionEntity, { phaseStateId: In(phaseStateIds) });
      await m.delete(PhaseStateEntity, { id: In(phaseStateIds) });
    }
    if (learnerIds.length) {
      await m.delete(EnrollmentEntity, { userId: In(learnerIds) });
      await m.delete(UserEntity, { id: In(learnerIds) });
    }
    if (staffId) await m.delete(UserEntity, { id: staffId });
    if (cohortId) await m.delete(CohortEntity, { id: cohortId });
    await ds.destroy();
  }, 60_000);

  it('reads one submission per phase, and the same one the learner is looking at', async () => {
    const newest = await newestSubmissionsPerPhaseState(m, phaseStateIds);

    expect(newest).toHaveLength(phaseStateIds.length);
    for (const row of newest) {
      // The tie-break has to agree with `ORDER BY createdAt DESC, id DESC
      // LIMIT 1`, which is the ordering every other reader of this table uses.
      expect(row.id).toBe(newestOf.get(row.phaseStateId));
      expect(new Date(row.createdAt as string | Date).toISOString()).toBe(
        '2026-09-04T10:00:00.000Z',
      );
    }
  });

  it('pages the whole trail from a cursor, with no row seen twice and none missed', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const rows = await service.auditLog(caller, undefined, 2, cursor);
      if (!rows.length) break;
      seen.push(...rows.map((row) => row.id));
      cursor = auditCursor(rows[rows.length - 1]);
    }

    const mine = seen.filter((id) => auditIds.includes(id));
    expect(mine).toHaveLength(auditIds.length);
    expect(new Set(mine).size).toBe(auditIds.length);
  });

  it('scopes the trail to the caller class, which is a join across the two id columns', async () => {
    const rows = await service.auditLog(caller, undefined, 200);

    const mine = rows.filter((row) => auditIds.includes(row.id));
    expect(mine).toHaveLength(auditIds.length);
    for (const row of mine) expect(learnerIds).toContain(row.subjectUserId);
  });
});
