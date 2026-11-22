import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import * as path from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import { ALL_ENTITIES, QuizAttemptEntity } from './entities';
import { H4QuizAttempts1789700000000 } from '../migrations/1789700000000-H4-QuizAttempts';
import { describePostgres, postgresTarget } from '../../test/support/postgres';

/**
 * H4 against a real PostgreSQL server, in a schema of its own.
 *
 * The sqlite spec beside this file is the one that always runs; this is the
 * half that cannot be simulated: the **normalised form Postgres stores a
 * partial index predicate in**, which is the whole question `UQ_quiz_attempts_open`
 * raises, plus `double precision` against `float` and `SET lock_timeout` as the
 * first statement of the batch. It is `describe.skip` without
 * `POSTGRES_TEST_CONFIG`, exactly as the project-model, shared-preview and
 * task-state migration specs are; run it with the configuration set.
 *
 * The precedent is read off the same server rather than quoted from a comment.
 * Postgres rewrites `WHERE "submittedAt" IS NULL` as `WHERE ("submittedAt" IS
 * NULL)`, and the only evidence in this tree that the schema builder still
 * compares *that* equal is `UQ_notifications_unread_subject` (the D4-Notifications migration, `:71`, `:83`).
 * The three status-string partial indexes vouch for `((status)::text = ANY
 * (...))`, which is a different rewrite; citing them here would have proved the
 * wrong thing. So this spec asserts the two predicates are the same clause and
 * then asserts the builder has nothing pending.
 *
 * It refuses any target but the configured isolated server, it refuses to
 * create an extension or to touch `public`, and it drops only a schema whose
 * name it generated.
 */

describePostgres('the quiz attempts migration on an isolated actual PostgreSQL schema', () => {
  let admin: DataSource;
  let db: DataSource;
  let schema: string;
  const h4 = new H4QuizAttempts1789700000000();

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

  /** Everything from ` WHERE ` on: the clause the precedent is cited for. */
  const predicateOf = (indexdef: string): string => indexdef.slice(indexdef.indexOf(' WHERE '));

  const indexdefsFor = async (table: string): Promise<Record<string, string>> => {
    const rows: { indexname: string; indexdef: string }[] = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
      [schema, table],
    );
    return Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
  };

  const paper = [
    { questionId: 'invest', optionIds: ['c', 'a', 'b'] },
    { questionId: 'acceptance', optionIds: ['b', 'a'] },
  ];

  const start = (overrides: Partial<QuizAttemptEntity> = {}): Promise<QuizAttemptEntity> =>
    db.getRepository(QuizAttemptEntity).save({
      phaseStateId: 'phase-state-1',
      userId: 'learner-1',
      taskKey: 'concepts',
      projectVersionId: 'version-1',
      paper,
      startedAt: '2026-09-19T10:00:00.000Z',
      ...overrides,
    } as QuizAttemptEntity);

  beforeAll(async () => {
    const url = new URL(postgresTarget()!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5494') {
      throw new Error('isolated migration target refused');
    }
    schema = `quiz_attempts_migration_${randomUUID().replace(/-/g, '')}`;
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
      // Everything up to and including H3: this spec applies H4 by hand, so the
      // "before" is the release the operator is upgrading from.
      migrations: readdirSync(directory)
        .filter((name) => name.endsWith('.ts') && !name.startsWith('1789700000000'))
        .map((name) => path.join(directory, name)),
    }).initialize();
    expect((await db.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
    await db.runMigrations();
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      if (!/^quiz_attempts_migration_[0-9a-f]{32}$/.test(schema)) {
        throw new Error('migration cleanup namespace refused');
      }
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      expect(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).toEqual([]);
      await admin.destroy();
    }
  });

  it('bounds its wait, lands on the entities with the predicate the bell already proves, and reverses completely', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      // Before: the previous release's schema, with the entity already
      // declared. The builder wants the table, which is what makes the
      // assertion after the migration worth making.
      const before = (await db.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
      expect(before.some((query) => query.includes('quiz_attempts'))).toBe(true);

      const issued = recording(runner);
      await h4.up(runner);

      // `lock_timeout` bounds how long H4 WAITS behind a long-running reader.
      // Here there is nothing to wait for (one new table, no column on an
      // existing one) but it is the first statement in H3's shape and for H3's
      // reason, and it is not the safety argument.
      expect(issued[0]).toBe(`SET lock_timeout = '3s'`);
      // and no statement touches a table that was already there
      expect(issued.filter((sql) => /ALTER TABLE/i.test(sql))).toEqual([]);

      // The DDL synchronize would still want to run, and it has to be nothing.
      expect((await db.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query)).toEqual([]);

      // The partial unique index, which is the half this spec exists for: the
      // predicate is an `IS NULL` test, which Postgres stores parenthesised and
      // still compares equal (the property `UQ_notifications_unread_subject`
      // is the tree's evidence for), read here off the same server.
      const quizIndexes = await indexdefsFor('quiz_attempts');
      expect(quizIndexes['UQ_quiz_attempts_open']).toContain('UNIQUE');
      expect(quizIndexes['UQ_quiz_attempts_open']).toContain('("phaseStateId", "taskKey")');
      expect(quizIndexes['UQ_quiz_attempts_open']).toContain('IS NULL');
      const bell = (await indexdefsFor('notifications'))['UQ_notifications_unread_subject'];
      expect(predicateOf(quizIndexes['UQ_quiz_attempts_open']).replace('submittedAt', 'readAt')).toBe(
        predicateOf(bell),
      );
      expect(quizIndexes['IDX_quiz_attempts_user']).toContain('("userId")');
      expect(quizIndexes['IDX_quiz_attempts_task']).toContain(
        '("phaseStateId", "taskKey", "createdAt")',
      );

      // The table accepts a paper, and `double precision` and a nullable
      // boolean round-trip as the entity declares them.
      const attempts = db.getRepository(QuizAttemptEntity);
      const first = await start();
      expect(await attempts.findOneByOrFail({ id: first.id })).toMatchObject({
        paper,
        answers: null,
        score: null,
        passed: null,
        packVersion: null,
        submissionId: null,
        submittedAt: null,
        // The recovery's two columns, on the dialect the
        // deployment actually runs. `integer NOT NULL DEFAULT 0` round-trips
        // as a number and not as a string, which a `character varying`
        // spelling of it would have done silently.
        epoch: 0,
        voidedAt: null,
      });

      // One OPEN paper per task, and any number of closed ones: the
      // idempotent-start device, which is neither the replay guard nor the
      // limit.
      await expect(start()).rejects.toThrow();
      await attempts.update(
        { id: first.id },
        { score: 80, passed: true, submittedAt: '2026-09-19T10:09:00.000Z' },
      );
      const second = await start();
      await attempts.update({ id: second.id }, { submittedAt: '2026-09-19T10:19:00.000Z' });
      const stranded = await start();
      expect(
        await attempts.count({ where: { phaseStateId: 'phase-state-1', taskKey: 'concepts' } }),
      ).toBe(3);
      expect((await attempts.findOneByOrFail({ id: first.id })).score).toBe(80);

      // The recovery, here for the same reason the predicate is: the index is
      // NOT epoch-scoped, so a new run's first paper cannot be inserted until
      // the reset has closed the one it found open.
      await expect(start({ epoch: 1 })).rejects.toThrow();
      const at = '2026-09-22T09:00:00.000Z';
      await attempts.update({ id: stranded.id }, { submittedAt: at, voidedAt: at });
      const fresh = await start({ epoch: 1 });
      expect((await attempts.findOneByOrFail({ id: fresh.id })).epoch).toBe(1);
      expect(await attempts.findOneByOrFail({ id: stranded.id })).toMatchObject({
        epoch: 0,
        voidedAt: at,
        answers: null,
        score: null,
      });

      // Reversal, on a populated schema: the table and its three indexes go,
      // and nothing else does.
      const reverting = recording(runner);
      await h4.down(runner);
      expect(reverting[0]).toBe(`SET lock_timeout = '3s'`);
      expect(await runner.hasTable('quiz_attempts')).toBe(false);
      expect(Object.keys(await indexdefsFor('quiz_attempts'))).toEqual([]);
      // the neighbouring tables the reversal must not have touched
      for (const table of ['task_states', 'submissions', 'notifications']) {
        expect(await runner.hasTable(table)).toBe(true);
      }
      expect(
        (await indexdefsFor('notifications'))['UQ_notifications_unread_subject'],
      ).toContain('IS NULL');

      // and back up again, predicate and all
      await h4.up(runner);
      expect((await db.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query)).toEqual([]);
      expect((await indexdefsFor('quiz_attempts'))['UQ_quiz_attempts_open']).toContain('IS NULL');
      await start();
      await expect(start()).rejects.toThrow();
    } finally {
      jest.restoreAllMocks();
      await runner.release();
    }
  });
});
