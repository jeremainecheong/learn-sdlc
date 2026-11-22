import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  ALL_ENTITIES,
  SubmissionEntity,
  TaskResetEntity,
  TaskStateEntity,
} from './entities';
import { H3TaskStates1789600200000 } from '../migrations/1789600200000-H3-TaskStates';

/**
 * H3 on the local-first store (several tasks in one written phase).
 *
 * `database.module.spec.ts` already asserts the two parity properties over
 * *every* migration: zero pending schema-builder queries after the run, and a
 * full revert back to an empty file, and that assertion is the gate. This spec
 * is the narrow one, in the shape `project-model-migration.spec.ts` set for H1
 * and H2: it names H3, it proves each of the two new tables accepts a row, it
 * proves the guard H3 re-cuts is per task, and it proves the reversal on
 * a *populated* file rather than a fresh one. A failure here says which table
 * and which statement rather than "the schema has drifted".
 *
 * Three of its cases exist because the naive migration passes every other gate
 * and still ships a defect:
 *
 * - `down()` recreates a one-column partial unique index on a database that may
 *   hold two in-flight submissions per phase state, which is the state the
 *   migration exists to allow, so it writes them off first. A fresh file never
 *   sees it, and `database.module.spec.ts`'s revert opens one.
 * - `submissions.taskKey` backfills to `''` and must leave every other column of
 *   a retained term of coursework exactly as it was.
 * - `task_states.updatedAt` is spelled `${t.created}` in the DDL, which is
 *   DEFAULT-only and moves on insert alone. `@UpdateDateColumn` on the entity is
 *   what moves it on a write, and `PhaseSummary.tasksUpdatedAt` has a reader
 *   that reads nothing without it.
 *
 * Postgres is the same proof against a real server, in the `.postgres.spec.ts`
 * beside this file; it self-skips where none is configured, which is correct
 * rather than a gap.
 */
describe('the task state migration', () => {
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

  const indexSql = async (dataSource: DataSource, name: string): Promise<string | null> => {
    const rows: { sql: string | null }[] = await dataSource.query(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
      [name],
    );
    return rows.length ? rows[0].sql : null;
  };

  /**
   * Back to the release before H3.
   *
   * `undoLastMigration` takes the **newest**, and H3 is not the
   * newest: H4 and later are. So this walks back until H3 itself
   * has been reverted, which is what both cases below mean by *the file as the
   * previous release left it*. Nothing about what they assert moves: H4 adds a
   * table of its own, H9 only pins `enrollments`, and
   * H5 adds one nullable column to `submissions` (`resetEpoch`) with no index,
   * which reads NULL on every retained row and is set aside by name below, so
   * taking those off first changes neither the retained coursework nor the
   * index H3's `down()` restores.
   */
  const undoThroughM3 = async (dataSource: DataSource): Promise<void> => {
    const applied = async (): Promise<boolean> =>
      (
        await dataSource.query(`SELECT name FROM learnsdlc_migrations WHERE name = ?`, [
          'H3TaskStates1789600200000',
        ])
      ).length > 0;
    while (await applied()) await dataSource.undoLastMigration();
  };

  /** A queued revision as the grader writes one, by hand so the key is explicit. */
  const queue = async (
    dataSource: DataSource,
    id: string,
    phaseStateId: string,
    taskKey: string,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO "submissions" ("id","phaseStateId","userId","status","taskKey") VALUES (?,?,?,?,?)`,
      [id, phaseStateId, 'learner-1', 'queued', taskKey],
    );
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-h3-'));
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

  it('lands exactly on the entity schema and holds a row in every new table', async () => {
    const dataSource = await open(path.join(dir, 'fresh.sqlite'));

    // The assertion that the migrated schema and the entities agree: this is
    // the DDL synchronize would still want to run, and it has to be nothing.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((query) => query.query)).toEqual([]);

    const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations ORDER BY id`);
    expect(applied.map((row: { name: string }) => row.name)).toEqual(
      expect.arrayContaining(['H3TaskStates1789600200000']),
    );

    // and they are working tables, not just shapes
    const tasks = dataSource.getRepository(TaskStateEntity);
    const row = await tasks.save({
      phaseStateId: 'phase-state-1',
      userId: 'learner-1',
      taskKey: 'story',
    });
    expect(await tasks.findOneByOrFail({ id: row.id })).toMatchObject({
      taskKey: 'story',
      status: 'in_progress',
      bestScore: null,
      attempts: 0,
      ranBeforeSubmit: false,
      passedAt: null,
      solutionReadAt: null,
      awaitingSignOff: false,
      signedOffBy: null,
      signedOffAt: null,
      resetAt: null,
      resetCount: 0,
    });

    const resets = dataSource.getRepository(TaskResetEntity);
    const reset = await resets.save({
      taskStateId: row.id,
      userId: 'learner-1',
      files: { 'requirements/draft.md': '# the draft the reset took away' },
    });
    expect((await resets.findOneByOrFail({ id: reset.id })).files).toEqual({
      'requirements/draft.md': '# the draft the reset took away',
    });

    // One row per phase state and task, settled in the database: the repair
    // writes what enrolment missed, and two passes must not leave two rows.
    await expect(
      tasks.save(
        tasks.create({ phaseStateId: 'phase-state-1', userId: 'learner-1', taskKey: 'story' }),
      ),
    ).rejects.toThrow();
    // and a second task of the same phase is not a duplicate
    await tasks.save(
      tasks.create({ phaseStateId: 'phase-state-1', userId: 'learner-1', taskKey: 'scope' }),
    );
    expect(await tasks.count()).toBe(2);
  });

  it('the in-flight guard is per task', async () => {
    const dataSource = await open(path.join(dir, 'in-flight.sqlite'));

    await queue(dataSource, 'sub-story', 'phase-state-1', 'story');
    // Two tasks of one phase may be in flight at once: that is the whole of
    // what H3 re-cuts the guard for.
    await queue(dataSource, 'sub-scope', 'phase-state-1', 'scope');
    expect(await dataSource.query(`SELECT count(*) AS n FROM "submissions"`)).toEqual([{ n: 2 }]);

    // and the same task twice is still refused by the database, which is the
    // double-click the read-then-write guard cannot settle on its own
    await expect(queue(dataSource, 'sub-story-2', 'phase-state-1', 'story')).rejects.toThrow();

    // a terminal row falls outside the index, so a task keeps its back catalogue
    await dataSource.query(`UPDATE "submissions" SET "status" = 'completed' WHERE "id" = ?`, [
      'sub-story',
    ]);
    await queue(dataSource, 'sub-story-3', 'phase-state-1', 'story');
    expect(await dataSource.query(`SELECT count(*) AS n FROM "submissions"`)).toEqual([{ n: 3 }]);
  });

  it('down() writes off the in-flight rows before restoring the one-column index', async () => {
    const dataSource = await open(path.join(dir, 'revert-populated.sqlite'));
    // The state H3 exists to allow, and the one a fresh file never
    // reaches: two submissions in flight on one phase state.
    await queue(dataSource, 'sub-story', 'phase-state-1', 'story');
    await queue(dataSource, 'sub-scope', 'phase-state-1', 'scope');
    // and one terminal row, to prove the write-off is scoped to the in-flight ones
    await dataSource.query(
      `INSERT INTO "submissions" ("id","phaseStateId","userId","status","passed","score","taskKey") ` +
        `VALUES (?,?,?,?,?,?,?)`,
      ['sub-done', 'phase-state-1', 'learner-1', 'completed', 1, 88, 'story'],
    );

    // Without the write-off this raises a unique violation: two rows would
    // collide under the restored one-column partial index.
    await undoThroughM3(dataSource);

    const rows: { id: string; status: string; error: string | null; score: number | null }[] =
      await dataSource.query(`SELECT "id","status","error","score" FROM "submissions" ORDER BY "id"`);
    expect(rows.map(({ id, status, error }) => ({ id, status, error }))).toEqual([
      {
        id: 'sub-done',
        status: 'completed',
        error: null,
      },
      {
        id: 'sub-scope',
        status: 'failed',
        error: 'This submission was interrupted by a release rollback. Submit again.',
      },
      {
        id: 'sub-story',
        status: 'failed',
        error: 'This submission was interrupted by a release rollback. Submit again.',
      },
    ]);
    // the terminal row is untouched, verdict and all
    expect(rows.find((row) => row.id === 'sub-done')?.score).toBe(88);

    const restored = await indexSql(dataSource, 'UQ_submissions_in_flight');
    expect(restored).toContain('("phaseStateId")');
    expect(restored).not.toContain('taskKey');
    expect(restored).toContain(`status IN ('queued','running')`);
    // the four-column index goes with the column it names, and the three-column
    // one H3 never touched is still there
    expect(await indexSql(dataSource, 'IDX_submissions_task_created')).toBeNull();
    expect(await indexSql(dataSource, 'IDX_submissions_phase_state_created')).toContain(
      '"phaseStateId", "createdAt", "id"',
    );

    const columns: { name: string }[] = await dataSource.query(`PRAGMA table_info("submissions")`);
    expect(columns.map((column) => column.name)).not.toContain('taskKey');
    for (const gone of ['task_states', 'task_resets']) {
      const left = await dataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [gone],
      );
      expect(left).toEqual([]);
    }
  });

  it('every existing row backfills to the empty key', async () => {
    const dataSource = await open(path.join(dir, 'retained.sqlite'));
    // the file as the previous release left it: everything up to H3
    await undoThroughM3(dataSource);

    // A term of coursework, written as that release wrote it: raw, because its
    // entity had no key column and so its insert named none.
    for (const [id, status, score, passed] of [
      ['sub-a', 'completed', 88, 1],
      ['sub-b', 'failed', null, 0],
    ] as const) {
      await dataSource.query(
        `INSERT INTO "submissions" ("id","phaseStateId","userId","status","score","passed","packVersion") ` +
          `VALUES (?,?,?,?,?,?,?)`,
        [id, 'phase-state-1', 'learner-1', status, score, passed, '2.0.1'],
      );
    }
    const before = await dataSource.query(`SELECT * FROM "submissions" ORDER BY "id"`);
    expect(Object.keys(before[0])).not.toContain('taskKey');

    await dataSource.runMigrations();

    const after: Record<string, unknown>[] = await dataSource.query(
      `SELECT * FROM "submissions" ORDER BY "id"`,
    );
    // H3's default, on every retained revision, and `''` rather than a guess,
    // because which task an older revision belongs to is a question the row
    // writers answer against the board, not a question a migration may.
    expect(after.map((row) => row.taskKey)).toEqual(['', '']);
    // H5's epoch reads NULL ("the current run") on every retained revision
    expect(after.map((row) => row.resetEpoch)).toEqual([null, null]);
    // and every other column byte-identical
    expect(after.map(({ taskKey, resetEpoch, ...rest }) => rest)).toEqual(before);
    expect((await dataSource.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });

  it('a write to a task row moves updatedAt', async () => {
    const dataSource = await open(path.join(dir, 'updated-at.sqlite'));
    const tasks = dataSource.getRepository(TaskStateEntity);
    const row = await tasks.save({
      phaseStateId: 'phase-state-1',
      userId: 'learner-1',
      taskKey: 'story',
    });

    // The stamp is stored to the second on this dialect (the C6 migration's header records
    // it), so a same-second write would read equal on a working column. Rewind
    // it and watch the write move it forward: that is the property the reader
    // needs and the one the DDL alone does not give.
    await dataSource.query(`UPDATE "task_states" SET "updatedAt" = ? WHERE "id" = ?`, [
      '2020-01-01 00:00:00',
      row.id,
    ]);
    const [rewound] = await dataSource.query(
      `SELECT "updatedAt" AS at FROM "task_states" WHERE "id" = ?`,
      [row.id],
    );
    expect(rewound.at).toBe('2020-01-01 00:00:00');

    await tasks.update({ id: row.id }, { attempts: 1 });

    const [moved] = await dataSource.query(
      `SELECT "updatedAt" AS at FROM "task_states" WHERE "id" = ?`,
      [row.id],
    );
    // Without `@UpdateDateColumn` the column is a DEFAULT that fired on insert
    // and nothing writes it again: `tasksUpdatedAt` would then answer the
    // insert time for ever and `phaseMoved`'s task comparison would never fire.
    expect(moved.at).not.toBe('2020-01-01 00:00:00');
    expect((await tasks.findOneByOrFail({ id: row.id })).attempts).toBe(1);
  });

  it('refuses a dialect it has no statements for, by name', async () => {
    const migration = new H3TaskStates1789600200000();
    const runner = { connection: { options: { type: 'mysql' } } } as never;
    await expect(migration.up(runner)).rejects.toThrow(
      new RegExp(`${migration.name} has no statements for "mysql"`),
    );
    await expect(migration.down(runner)).rejects.toThrow(/has no statements for "mysql"/);
  });
});
