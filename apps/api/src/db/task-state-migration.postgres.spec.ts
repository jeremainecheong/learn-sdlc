import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import * as path from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import {
  ALL_ENTITIES,
  PhaseStateEntity,
  SubmissionEntity,
  TaskResetEntity,
  TaskStateEntity,
  UserEntity,
} from './entities';
import { H3TaskStates1789600200000 } from '../migrations/1789600200000-H3-TaskStates';
import { describePostgres, postgresTarget } from '../../test/support/postgres';

/**
 * H3 against a real PostgreSQL server, in a schema of its own.
 *
 * The sqlite spec beside this file is the one that always runs; this is the
 * half that cannot be simulated: the normalised form Postgres stores a partial
 * index predicate in, `double precision` against `float`, a `NOT NULL DEFAULT
 * ''` added to a populated table, and `SET lock_timeout` as the first statement
 * of the batch. It is `describe.skip` without `POSTGRES_TEST_CONFIG`, exactly as
 * the project-model and shared-preview migration specs are; run it with the
 * configuration set.
 *
 * It refuses any target but the configured isolated server, it refuses to
 * create an extension or to touch `public`, and it drops only a schema whose
 * name it generated.
 */

describePostgres('the task state migration on an isolated actual PostgreSQL schema', () => {
  let admin: DataSource;
  let db: DataSource;
  let schema: string;
  let retained: Record<string, unknown[]>;
  let userId = '';
  let phaseStateId = '';
  const h3 = new H3TaskStates1789600200000();

  /** A learner's term of work, as text, so a comparison is byte-for-byte. */
  const snapshot = async (): Promise<Record<string, unknown[]>> => {
    const out: Record<string, unknown[]> = {};
    for (const table of ['users', 'phase_states']) {
      out[table] = await db.query(
        `SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t ORDER BY id`,
      );
    }
    // Named columns rather than the whole row: H3 adds one, and the assertion
    // is that it left every column that was already there alone.
    out.submissions = await db.query(
      `SELECT "id","phaseStateId","userId","status","score","passed","packVersion","error","createdAt" ` +
        `FROM "${schema}"."submissions" ORDER BY id`,
    );
    return out;
  };

  /** Every statement a migration issues, in order, so the first one can be named. */
  const recording = (runner: QueryRunner): string[] => {
    const issued: string[] = [];
    // Take off a recording already on this runner before starting another.
    // `jest.spyOn` hands back the spy that is installed rather than wrapping
    // it, so a second call would bind the mock to its own replacement
    // implementation and recurse until the stack is gone, which is what the
    // reversal half of this case does, on the same runner as the up half.
    if (jest.isMockFunction(runner.query)) {
      (runner.query as unknown as jest.SpyInstance).mockRestore();
    }
    const query = runner.query.bind(runner);
    jest
      .spyOn(runner, 'query')
      .mockImplementation(((sql: string, parameters?: unknown[]) => {
        issued.push(sql);
        return query(sql, parameters);
      }) as never);
    return issued;
  };

  beforeAll(async () => {
    const url = new URL(postgresTarget()!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5494') {
      throw new Error('isolated migration target refused');
    }
    schema = `task_state_migration_${randomUUID().replace(/-/g, '')}`;
    admin = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
    // Historical migrations use the already-installed UUID extension. This
    // fixture refuses to introduce a shared extension or modify public tables.
    expect(await admin.query("SELECT 1 FROM pg_extension WHERE extname='uuid-ossp'")).toHaveLength(1);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const directory = path.join(__dirname, '..', 'migrations');
    db = await new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema,
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 15000 },
      entities: ALL_ENTITIES,
      synchronize: false,
      // Everything up to and including H2: this spec applies H3 by hand, so the
      // "before" is the release the operator is upgrading from.
      migrations: readdirSync(directory)
        .filter((name) => name.endsWith('.ts') && !name.startsWith('1789600200000'))
        .map((name) => path.join(directory, name)),
    }).initialize();
    expect((await db.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
    await db.runMigrations();

    const user = await db.getRepository(UserEntity).save({
      email: 'task-state-migration@example.invalid',
      displayName: 'Owned migration fixture',
      passwordHash: 'unusable',
    });
    userId = user.id;
    const [enrollment] = await db.query(
      `INSERT INTO "${schema}"."enrollments" ("userId","projectSlug","currentPhaseOrder","packVersion") ` +
        `VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, 'tasktrackr', 2, '2.0.1'],
    );
    const phase = await db.getRepository(PhaseStateEntity).save({
      userId,
      enrollmentId: enrollment.id,
      phaseKey: 'requirements',
      phaseOrder: 1,
      status: 'passed',
      bestScore: 90,
      attempts: 2,
      workspace: { 'requirements/story.md': 'Retained actual migration fixture' },
    });
    phaseStateId = phase.id;
    // The revision as the previous release wrote it, by hand rather than
    // through the repository: `SubmissionEntity` already declares `taskKey`,
    // and naming it is the one thing the pre-H3 table cannot accept. Every
    // other column of this insert is nullable or defaulted.
    await db.query(
      `INSERT INTO "${schema}"."submissions" ("phaseStateId","userId","status","score","passed") ` +
        `VALUES ($1,$2,$3,$4,$5)`,
      [phaseStateId, userId, 'completed', 90, true],
    );
    retained = await snapshot();
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      if (!/^task_state_migration_[0-9a-f]{32}$/.test(schema)) {
        throw new Error('migration cleanup namespace refused');
      }
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      expect(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).toEqual([]);
      await admin.destroy();
    }
  });

  it('bounds its wait, lands on the entities, keeps retained coursework, and reverses completely', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      const issued = recording(runner);
      await h3.up(runner);

      // `lock_timeout` bounds how long H3 WAITS behind a long-running reader.
      // It does not bound how long it HOLDS the ACCESS EXCLUSIVE the ALTER
      // takes (that is held to the batch's commit) which is why it is the
      // first statement and not the safety argument.
      expect(issued[0]).toBe(`SET lock_timeout = '3s'`);

      // The DDL synchronize would still want to run, and it has to be nothing.
      expect((await db.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query)).toEqual([]);
      // Every column that was there before, untouched…
      expect(await snapshot()).toEqual(retained);
      // …and the new one on the retained revision, at H3's default.
      expect(await db.query(`SELECT "taskKey" FROM "${schema}"."submissions"`)).toEqual([
        { taskKey: '' },
      ]);

      // Both new tables accept a row.
      const tasks = db.getRepository(TaskStateEntity);
      const row = await tasks.save({ phaseStateId, userId, taskKey: 'story' });
      expect(await tasks.findOneByOrFail({ id: row.id })).toMatchObject({
        status: 'in_progress',
        attempts: 0,
        bestScore: null,
        ranBeforeSubmit: false,
        awaitingSignOff: false,
        resetCount: 0,
      });
      await db.getRepository(TaskResetEntity).save({
        taskStateId: row.id,
        userId,
        files: { 'requirements/draft.md': '# the draft the reset took away' },
      });
      await expect(
        tasks.save(tasks.create({ phaseStateId, userId, taskKey: 'story' })),
      ).rejects.toThrow();

      // The partial unique index, which is the half this spec exists for: the
      // predicate is a status comparison, which is the shape Postgres
      // normalises and still compares equal.
      const submissions = db.getRepository(SubmissionEntity);
      await submissions.save({ userId, phaseStateId, status: 'queued', taskKey: 'story' });
      await submissions.save({ userId, phaseStateId, status: 'queued', taskKey: 'scope' });
      await expect(
        submissions.save(
          submissions.create({ userId, phaseStateId, status: 'queued', taskKey: 'story' }),
        ),
      ).rejects.toThrow();

      // Reversal, on a POPULATED schema holding two in-flight rows on one phase
      // state: without the write-off the restored one-column index raises a
      // unique violation here.
      const reverting = recording(runner);
      await h3.down(runner);
      expect(reverting[0]).toBe(`SET lock_timeout = '3s'`);

      const written: { status: string; error: string | null }[] = await db.query(
        `SELECT "status","error" FROM "${schema}"."submissions" WHERE "status" = 'failed'`,
      );
      expect(written).toHaveLength(2);
      for (const wrote of written) {
        expect(wrote.error).toBe(
          'This submission was interrupted by a release rollback. Submit again.',
        );
      }

      for (const table of ['task_states', 'task_resets']) {
        expect(await runner.hasTable(table)).toBe(false);
      }
      const columns = await db.query(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_schema = $1 AND table_name = 'submissions'`,
        [schema],
      );
      expect(columns.map((c: { column_name: string }) => c.column_name)).not.toContain('taskKey');

      const indexes = await db.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'submissions'`,
        [schema],
      );
      const restored = indexes.find(
        (index: { indexname: string }) => index.indexname === 'UQ_submissions_in_flight',
      );
      expect(restored.indexdef).toContain('("phaseStateId")');
      expect(
        indexes.some(
          (index: { indexname: string }) => index.indexname === 'IDX_submissions_task_created',
        ),
      ).toBe(false);
      // the three-column index H3 never touched, in either direction
      expect(
        indexes.find(
          (index: { indexname: string }) =>
            index.indexname === 'IDX_submissions_phase_state_created',
        ).indexdef,
      ).toContain('("phaseStateId", "createdAt", id)');
    } finally {
      jest.restoreAllMocks();
      await runner.release();
    }
  });
});
