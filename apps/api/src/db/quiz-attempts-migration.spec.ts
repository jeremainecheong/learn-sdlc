import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALL_ENTITIES, QuizAttemptEntity } from './entities';
import { H4QuizAttempts1789700000000 } from '../migrations/1789700000000-H4-QuizAttempts';

/**
 * H4 on the local-first store: the table a quiz paper lives in.
 *
 * `database.module.spec.ts` already asserts the two parity properties over
 * *every* migration: zero pending schema-builder queries after the run, and a
 * full revert back to an empty file, and that assertion is the gate. This spec
 * is the narrow one, in the shape `task-state-migration.spec.ts` set for H3: it
 * names H4, it proves the table accepts a row, and it proves the one device
 * this migration creates does the one job it is for.
 *
 * Three of its cases exist because a plausible migration passes every other
 * gate and still ships a defect:
 *
 * - **The predicate.** `UQ_quiz_attempts_open` is partial on `"submittedAt" IS
 *   NULL`, and the in-tree precedent for that shape is
 *   `UQ_notifications_unread_subject` (the D4-Notifications migration, `:71` and `:83`), **not** the three
 *   status-string comparisons (`UQ_submissions_in_flight`,
 *   `UQ_project_versions_draft`, `UQ_cohort_project_assignment_active`), whose
 *   own comments vouch for a normalised `((status)::text = ANY (...))` and say
 *   nothing about `IS NULL`. So the parity case reads both predicates off the
 *   same file and asserts they are the same clause. A spec written against the
 *   wrong precedent proves the wrong thing.
 * - **What the index is for.** It makes a double *start* idempotent and does
 *   nothing else: a closed row is outside the predicate, so it is neither the
 *   replay guard nor the attempt limit. Asserting only "a duplicate is refused"
 *   would leave a reader thinking the limit was in the database.
 * - **Down then up.** H4 adds one table and no column to an existing one, so
 *   the sqlite table-rebuild hazard that loses a partial index's `WHERE` is
 *   never reached, and the way to say that is to take the migration off and
 *   put it back and find the predicate still there.
 *
 * Postgres is the same proof against a real server, in the `.postgres.spec.ts`
 * beside this file; it self-skips where none is configured, which is correct
 * rather than a gap.
 */
describe('the quiz attempts migration', () => {
  const migrations = [path.join(__dirname, '..', 'migrations', '*.{ts,js}')];
  let dir = '';
  let opened: DataSource[] = [];

  const optionsFor = (file: string): DataSourceOptions =>
    ({
      type: 'better-sqlite3',
      database: file,
      entities: ALL_ENTITIES,
      synchronize: false,
      migrationsRun: true,
      migrations,
      migrationsTableName: 'learnsdlc_migrations',
    }) as DataSourceOptions;

  const open = async (file: string): Promise<DataSource> => {
    const dataSource = await new DataSource(optionsFor(file)).initialize();
    opened.push(dataSource);
    return dataSource;
  };

  /**
   * The release this one is upgrading from: every migration up to and
   * including H3, and not H4. Named by file rather than by glob so that the
   * one it leaves out is visible.
   */
  const withoutH4 = async (file: string): Promise<DataSource> => {
    const directory = path.join(__dirname, '..', 'migrations');
    const dataSource = await new DataSource({
      ...optionsFor(file),
      migrations: fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.ts') && !name.startsWith('1789700000000'))
        .map((name) => path.join(directory, name)),
    } as DataSourceOptions).initialize();
    opened.push(dataSource);
    return dataSource;
  };

  const indexSql = async (dataSource: DataSource, name: string): Promise<string | null> => {
    const rows: { sql: string | null }[] = await dataSource.query(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
      [name],
    );
    return rows.length ? rows[0].sql : null;
  };

  /** Everything from ` WHERE ` on: the clause the two dialects have to agree about. */
  const predicateOf = (sql: string): string => sql.slice(sql.indexOf(' WHERE '));

  /** A paper as the attempt service draws one, open until it is handed in. */
  const paper = [
    { questionId: 'invest', optionIds: ['c', 'a', 'b'] },
    { questionId: 'acceptance', optionIds: ['b', 'a'] },
  ];

  const start = (
    dataSource: DataSource,
    overrides: Partial<QuizAttemptEntity> = {},
  ): Promise<QuizAttemptEntity> =>
    dataSource.getRepository(QuizAttemptEntity).save({
      phaseStateId: 'phase-state-1',
      userId: 'learner-1',
      taskKey: 'concepts',
      projectVersionId: 'version-1',
      paper,
      startedAt: '2026-09-19T10:00:00.000Z',
      ...overrides,
    } as QuizAttemptEntity);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-h4-'));
  });

  afterEach(async () => {
    for (const dataSource of opened) {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
    opened = [];
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lands exactly on the entity schema and holds a paper', async () => {
    const dataSource = await open(path.join(dir, 'fresh.sqlite'));

    // The assertion that the migrated schema and the entities agree: this is
    // the DDL synchronize would still want to run, and it has to be nothing.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((query) => query.query)).toEqual([]);

    const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations ORDER BY id`);
    expect(applied.map((row: { name: string }) => row.name)).toEqual(
      expect.arrayContaining(['H4QuizAttempts1789700000000']),
    );

    // and it is a working table, not just a shape
    const attempts = dataSource.getRepository(QuizAttemptEntity);
    const row = await start(dataSource);
    expect(await attempts.findOneByOrFail({ id: row.id })).toMatchObject({
      phaseStateId: 'phase-state-1',
      taskKey: 'concepts',
      projectVersionId: 'version-1',
      packVersion: null,
      submissionId: null,
      // the draw and the permutation, back as they went in
      paper,
      // an open paper: nothing about a verdict is decided yet, and null is
      // what says so: a zero would be a score
      answers: null,
      score: null,
      passed: null,
      startedAt: '2026-09-19T10:00:00.000Z',
      submittedAt: null,
      // The recovery's two columns. `epoch` defaults to 0
      // (*nobody has reset this task*) so a paper written by a client that
      // knows nothing about the epoch still lands in the run it belongs to;
      // `voidedAt` is null on every paper but the one a reset finds open.
      epoch: 0,
      voidedAt: null,
    });

    // the two reading indexes, on the columns their readers seek
    expect(await indexSql(dataSource, 'IDX_quiz_attempts_user')).toContain('("userId")');
    expect(await indexSql(dataSource, 'IDX_quiz_attempts_task')).toContain(
      '("phaseStateId", "taskKey", "createdAt")',
    );
  });

  it('is what closes the gap: without it the schema builder wants the table and the predicate', async () => {
    // The parity assertion above is only worth having if it can fail, and this
    // is the state that fails it: the previous release's file, with the
    // entity already declared. Written down rather than trusted, because a
    // migration spec whose parity case is green on an empty question proves
    // nothing at all.
    const dataSource = await withoutH4(path.join(dir, 'previous-release.sqlite'));

    const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations ORDER BY id`);
    const names = applied.map((row: { name: string }) => row.name);
    expect(names).toEqual(expect.arrayContaining(['H3TaskStates1789600200000']));
    expect(names).not.toContain('H4QuizAttempts1789700000000');

    const wanted = (await dataSource.driver.createSchemaBuilder().log()).upQueries.map(
      (query) => query.query,
    );
    expect(wanted.some((query) => query.includes('"quiz_attempts"'))).toBe(true);
    // and the `WHERE` is part of what it compares, which is the whole reason
    // the precedent had to be the right one
    expect(
      wanted.some((query) => query.includes('"UQ_quiz_attempts_open"') && query.includes('IS NULL')),
    ).toBe(true);
  });

  it('carries the IS NULL predicate the unread-bell index already proves on both dialects', async () => {
    const dataSource = await open(path.join(dir, 'predicate.sqlite'));

    const quizIndex = await indexSql(dataSource, 'UQ_quiz_attempts_open');
    expect(quizIndex).toBe(
      `CREATE UNIQUE INDEX "UQ_quiz_attempts_open" ON "quiz_attempts" ("phaseStateId", "taskKey") WHERE "submittedAt" IS NULL`,
    );

    // The precedent, read off the same file rather than quoted from a comment.
    // `UQ_notifications_unread_subject` is the tree's one partial index on `IS
    // NULL`, written identically in the D4 migration's Postgres and sqlite arms; the three
    // status-string indexes vouch for a different shape and are not the
    // evidence for this one.
    const bell = await indexSql(dataSource, 'UQ_notifications_unread_subject');
    expect(bell).toContain(`WHERE "readAt" IS NULL`);
    expect(predicateOf(quizIndex!).replace('submittedAt', 'readAt')).toBe(predicateOf(bell!));

    // and the whole point of citing it: the schema builder compares the
    // predicate equal, so a migrated database reports no pending change.
    expect((await dataSource.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });

  it('refuses a second OPEN paper per task, and permits any number of closed ones', async () => {
    const dataSource = await open(path.join(dir, 'open-row.sqlite'));
    const attempts = dataSource.getRepository(QuizAttemptEntity);

    const first = await start(dataSource);
    // A double start is idempotent because the database will not take the
    // second row: the route hands back the open paper rather than drawing a
    // new one.
    await expect(start(dataSource)).rejects.toThrow();

    // Another task of the same phase is another paper, and so is the same task
    // for another learner's phase state.
    await start(dataSource, { taskKey: 'design-concepts' });
    await start(dataSource, { phaseStateId: 'phase-state-2' });

    // Hand the first one in. It leaves the predicate, and it constrains
    // nothing from here: a retake is a new open row, and every spent paper
    // stays. This index is NOT the attempt limit (that is a COUNT over the
    // closed rows) and it is NOT the replay guard, which is the hand-in
    // route's own `submittedAt IS NOT NULL` refusal.
    await attempts.update(
      { id: first.id },
      { answers: { invest: ['a'] }, score: 50, passed: false, submittedAt: '2026-09-19T10:09:00.000Z' },
    );

    const second = await start(dataSource);
    await attempts.update({ id: second.id }, { submittedAt: '2026-09-19T10:19:00.000Z' });
    const third = await start(dataSource);
    await attempts.update({ id: third.id }, { submittedAt: '2026-09-19T10:29:00.000Z' });
    await start(dataSource);

    const rows = await attempts.find({
      where: { phaseStateId: 'phase-state-1', taskKey: 'concepts' },
    });
    expect(rows).toHaveLength(4);
    // three spent, one open, which is exactly what the limit counts and what
    // the start route looks for
    expect(rows.filter((row) => row.submittedAt !== null)).toHaveLength(3);
    expect(rows.filter((row) => row.submittedAt === null)).toHaveLength(1);
  });

  it('takes an epoch and a void, and still holds one open paper across both', async () => {
    // The recovery's shape at the storage layer. `UQ_quiz_attempts_open` is
    // deliberately NOT epoch-scoped: *at most one open paper per learner and
    // task* is the whole of what it guarantees, and scoping it would let two
    // exist at once. So a reset closes the paper it finds (`submittedAt` and
    // `voidedAt` together) and only then can the next run's first paper be
    // inserted.
    const dataSource = await open(path.join(dir, 'epoch.sqlite'));
    const attempts = dataSource.getRepository(QuizAttemptEntity);

    const stranded = await start(dataSource);
    // Still open, so the new run cannot begin: the index says so, whatever
    // epoch the second row carries.
    await expect(start(dataSource, { epoch: 1 })).rejects.toThrow();

    const at = '2026-09-22T09:00:00.000Z';
    await attempts.update({ id: stranded.id }, { submittedAt: at, voidedAt: at });
    const fresh = await start(dataSource, { epoch: 1 });

    expect(await attempts.findOneByOrFail({ id: stranded.id })).toMatchObject({
      epoch: 0,
      voidedAt: at,
      submittedAt: at,
      answers: null,
      score: null,
      passed: null,
      submissionId: null,
    });
    expect((await attempts.findOneByOrFail({ id: fresh.id })).epoch).toBe(1);
    // Both papers are in the record: a reset returns attempts, it deletes
    // nothing.
    expect(await attempts.count()).toBe(2);
  });

  it('takes the table away and puts it back with its predicate intact', async () => {
    const dataSource = await open(path.join(dir, 'down-up.sqlite'));
    await start(dataSource);

    // `undoLastMigration` takes the newest, and H4 is not the newest
    // (H5 and H9 follow it), so walk back until H4 itself is undone.
    const h4Applied = async (): Promise<boolean> =>
      (
        await dataSource.query(`SELECT name FROM learnsdlc_migrations WHERE name = ?`, [
          'H4QuizAttempts1789700000000',
        ])
      ).length > 0;
    while (await h4Applied()) await dataSource.undoLastMigration();

    // The table and all three of its indexes go together, and nothing else
    // moves: H4 added no column to an existing table, so `down` has none to
    // take back.
    expect(
      await dataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quiz_attempts'`,
      ),
    ).toEqual([]);
    for (const name of [
      'UQ_quiz_attempts_open',
      'IDX_quiz_attempts_user',
      'IDX_quiz_attempts_task',
    ]) {
      expect(await indexSql(dataSource, name)).toBeNull();
    }
    // the neighbouring block's tables are untouched by the reversal
    expect(
      await dataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task_states','submissions','notifications') ORDER BY name`,
      ),
    ).toEqual([{ name: 'notifications' }, { name: 'submissions' }, { name: 'task_states' }]);

    await dataSource.runMigrations();

    expect(await indexSql(dataSource, 'UQ_quiz_attempts_open')).toContain(
      `WHERE "submittedAt" IS NULL`,
    );
    expect((await dataSource.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
    // and it is the predicate rather than the index name that came back
    await start(dataSource);
    await expect(start(dataSource)).rejects.toThrow();
  });

  it('refuses a dialect it has no statements for, by name', async () => {
    const migration = new H4QuizAttempts1789700000000();
    const runner = { connection: { options: { type: 'mysql' } } } as never;
    await expect(migration.up(runner)).rejects.toThrow(
      new RegExp(`${migration.name} has no statements for "mysql"`),
    );
    await expect(migration.down(runner)).rejects.toThrow(/has no statements for "mysql"/);
  });
});
