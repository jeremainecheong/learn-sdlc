import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  adoptSchemaSyncedSqliteFile,
  buildDataSourceOptions,
  openDataSource,
  serialiseSqliteTransactions,
  sqlitePragmas,
} from './database.module';
import { ALL_ENTITIES } from './entities';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BetterSqlite3 = require('better-sqlite3');

/** better-sqlite3 ships no types; this is the slice these tests use. */
interface SqliteHandle {
  pragma(source: string, options?: { simple: boolean }): any;
}

/**
 * The local-first store: one sqlite file on an instructor's laptop holding a
 * term of coursework. Two things have to be true of it. Migrations
 * must run on sqlite, so `RUN_MIGRATIONS=true` is a configuration that boots
 * rather than the one that fails at `CREATE EXTENSION`; and a file written by
 * an earlier release's schema sync must be adopted rather than rewritten.
 */
describe('the sqlite store', () => {
  let dir = '';
  let opened: DataSource[] = [];

  const migrations = [path.join(__dirname, '..', 'migrations', '*.{ts,js}')];

  const optionsFor = (file: string, extra: Partial<DataSourceOptions> = {}): DataSourceOptions =>
    ({
      type: 'better-sqlite3',
      database: file,
      entities: ALL_ENTITIES,
      synchronize: false,
      migrationsRun: true,
      migrations,
      migrationsTableName: 'learnsdlc_migrations',
      prepareDatabase: sqlitePragmas(file),
      ...extra,
    }) as DataSourceOptions;

  /** A file in the shape the previous release left behind: synchronize, no migrations table. */
  const schemaSyncedFile = async (name: string, seed = true): Promise<string> => {
    const file = path.join(dir, name);
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: file,
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    if (seed) {
      await dataSource.query(
        `INSERT INTO users ("id","email","passwordHash","displayName") VALUES ('u1','learner@class.edu','hash','A learner')`,
      );
    }
    await dataSource.destroy();
    return file;
  };

  const open = async (options: DataSourceOptions): Promise<DataSource> => {
    const dataSource = await openDataSource(options, { log: () => undefined });
    opened.push(dataSource);
    return dataSource;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-a5-'));
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

  describe('migrations on the local-first path', () => {
    it('boots on a fresh file with migrations on, and lands exactly on the entity schema', async () => {
      const dataSource = await open(optionsFor(path.join(dir, 'fresh.sqlite')));

      // The assertion that the migrated schema and the entities agree: this is
      // the DDL synchronize would still want to run, and it has to be nothing.
      const pending = await dataSource.driver.createSchemaBuilder().log();
      expect(pending.upQueries.map((query) => query.query)).toEqual([]);

      const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations ORDER BY id`);
      expect(applied.length).toBeGreaterThanOrEqual(3);
      expect(applied[0].name).toBe('InitialSchema1787500326487');
      // Every migration, the project model's included, is inside this proof
      // rather than beside it: the assertion above is what says the migrated
      // schema and the entities agree. The newest, S8 (two nullable columns: the reason a refused
      // structured proposal keeps on its turn, and a proposal's summary), is named here, and that is
      // what stops a migration being added without this parity assertion ever
      // having been run against it (a migration with a partial unique index,
      // such as the quiz paper's table, is exactly the kind the assertion above
      // exists for).
      expect(applied[applied.length - 1].name).toBe('S8ProposalFeedback1793430000000');

      // and it is a working database, not just a shape
      await dataSource.query(
        `INSERT INTO users ("id","email","passwordHash","displayName") VALUES ('u1','a@class.edu','hash','A')`,
      );
      expect(await dataSource.query(`SELECT count(*) AS n FROM users`)).toEqual([{ n: 1 }]);
    });

    it('reverts every migration back to an empty file', async () => {
      const dataSource = await open(optionsFor(path.join(dir, 'revert.sqlite')));
      const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations`);
      for (let i = 0; i < applied.length; i++) await dataSource.undoLastMigration();

      const left = await dataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      );
      expect(left.map((row: { name: string }) => row.name)).toEqual(['learnsdlc_migrations']);
    });

    it('adopts a file written by schema sync instead of failing on a table that already exists', async () => {
      const file = await schemaSyncedFile('adopt.sqlite');
      const dataSource = await open(optionsFor(file));

      // the learner row is still there, and the file is now under migration control
      expect(await dataSource.query(`SELECT email FROM users`)).toEqual([{ email: 'learner@class.edu' }]);
      const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations ORDER BY id`);
      expect(applied.length).toBeGreaterThanOrEqual(3);
      expect((await dataSource.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
    });

    it('reports what it did with a pre-migration file, and does nothing to one it has already adopted', async () => {
      const file = await schemaSyncedFile('adopt-twice.sqlite');
      const first = await open(optionsFor(file));
      await first.destroy();

      const second = new DataSource({ ...optionsFor(file), migrationsRun: false } as DataSourceOptions);
      await second.initialize();
      opened.push(second);
      await expect(adoptSchemaSyncedSqliteFile(second, () => undefined)).resolves.toEqual({
        action: 'already-migrated',
      });
    });

    it('leaves a fresh file to the migrations rather than adopting it', async () => {
      const dataSource = new DataSource({
        ...optionsFor(path.join(dir, 'empty.sqlite')),
        migrationsRun: false,
      } as DataSourceOptions);
      await dataSource.initialize();
      opened.push(dataSource);
      await expect(adoptSchemaSyncedSqliteFile(dataSource, () => undefined)).resolves.toEqual({
        action: 'empty',
      });
    });

    it('refuses to migrate a synced file whose schema has drifted, and leaves the data untouched', async () => {
      const file = await schemaSyncedFile('drifted.sqlite');
      const raw = new BetterSqlite3(file);
      raw.exec(`ALTER TABLE "users" DROP COLUMN "tokenVersion"`);
      raw.close();

      await expect(open(optionsFor(file))).rejects.toThrow(
        /refusing to run migrations against .*drifted\.sqlite.*no longer matches the entities/s,
      );

      const check = new BetterSqlite3(file, { readonly: true });
      expect(check.prepare(`SELECT email FROM users`).all()).toEqual([{ email: 'learner@class.edu' }]);
      expect(
        check
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learnsdlc_migrations'`)
          .all(),
      ).toEqual([]);
      check.close();
    });

    it('does not touch a Postgres deployment', async () => {
      const dataSource = { options: { type: 'postgres' } } as unknown as DataSource;
      await expect(adoptSchemaSyncedSqliteFile(dataSource, () => undefined)).resolves.toEqual({
        action: 'not-sqlite',
      });
    });

    it('auto-syncs an empty file, and refuses to auto-sync one with work in it', async () => {
      const file = path.join(dir, 'sync-guard.sqlite');
      const options = optionsFor(file, {
        migrationsRun: false,
        synchronize: true,
      } as Partial<DataSourceOptions>);

      // an empty file is what synchronize is for
      const built = await open(options);
      await built.query(
        `INSERT INTO users ("id","email","passwordHash","displayName") VALUES ('u1','learner@class.edu','hash','A learner')`,
      );
      await built.destroy();

      // now there is a term's work in it and the model has moved on
      const raw = new BetterSqlite3(file);
      raw.exec(`ALTER TABLE "users" DROP COLUMN "tokenVersion"`);
      raw.close();

      await expect(open(options)).rejects.toThrow(
        /refusing to auto-sync the schema of .*sync-guard\.sqlite: it holds 1 row\(s\)/,
      );

      const check = new BetterSqlite3(file, { readonly: true });
      expect(check.prepare(`SELECT email FROM users`).all()).toEqual([{ email: 'learner@class.edu' }]);
      check.close();
    });

    it('runs no migrations when the replica is told not to', async () => {
      const dataSource = await open(
        optionsFor(path.join(dir, 'replica.sqlite'), { migrationsRun: false } as Partial<DataSourceOptions>),
      );
      const tables = await dataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      );
      expect(tables).toEqual([]);
    });
  });

  describe('the journal the autosave path writes through', () => {
    it('opens the file in WAL with synchronous NORMAL', async () => {
      const dataSource = await open(optionsFor(path.join(dir, 'pragmas.sqlite')));
      const db = (dataSource.driver as unknown as { databaseConnection: any }).databaseConnection;
      // as shipped, measured: journal_mode=delete, synchronous=2 (FULL)
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(1);
    });

    it('lets a save through while a learner is reading', async () => {
      const file = path.join(dir, 'concurrent.sqlite');
      await (await open(optionsFor(file))).destroy();

      const reader = new BetterSqlite3(file, { readonly: true });
      const writer = new BetterSqlite3(file);
      writer.pragma('busy_timeout = 100');
      try {
        // one learner's dashboard poll, mid-read
        reader.exec('BEGIN');
        expect(reader.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 0 });

        // another learner's autosave, at the same moment. In the shipped
        // rollback-journal mode the COMMIT needs an exclusive lock the reader
        // is holding and throws SQLITE_BUSY: one reader stalls every writer,
        // which is what took /health/live from 2 ms idle to 91 ms p50 with
        // thirty learners active.
        writer.exec('BEGIN IMMEDIATE');
        writer
          .prepare(`INSERT INTO users ("id","email","passwordHash","displayName") VALUES (?,?,?,?)`)
          .run('u1', 'a@class.edu', 'hash', 'A');
        writer.exec('COMMIT');

        // the reader still sees the snapshot it began with, and the next one sees the write
        expect(reader.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 0 });
        reader.exec('COMMIT');
        expect(reader.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 1 });
      } finally {
        writer.close();
        reader.close();
      }
    });

    it('saves a workspace in well under a millisecond', async () => {
      const dataSource = await open(optionsFor(path.join(dir, 'autosave.sqlite')));
      await dataSource.query(
        `INSERT INTO phase_states ("id","enrollmentId","userId","phaseKey","phaseOrder") VALUES ('p1','e1','u1','requirements',1)`,
      );
      const workspace = JSON.stringify({ 'src/app.py': 'print("hello")\n'.repeat(200) });

      const times: number[] = [];
      for (let i = 0; i < 200; i++) {
        const started = process.hrtime.bigint();
        await dataSource.query(`UPDATE phase_states SET workspace = ? WHERE id = 'p1'`, [workspace]);
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      times.sort((a, b) => a - b);
      // Measured on this path: 0.006 ms with WAL, 0.016 ms without. The
      // 0.1 ms threshold leaves room for a slower disk.
      expect(times[Math.floor(times.length / 2)]).toBeLessThan(0.1);
    });

    it('says so when the filesystem refuses WAL instead of letting the pragma pass', async () => {
      const file = path.join(dir, 'no-wal.sqlite');
      const warnings: string[] = [];
      // what a network share does: the pragma is accepted and does nothing
      const dataSource = await openDataSource(
        optionsFor(file, {
          prepareDatabase: (db: SqliteHandle) => db.pragma('journal_mode = DELETE'),
        } as Partial<DataSourceOptions>),
        { log: () => undefined, warn: (message) => warnings.push(message) },
      );
      opened.push(dataSource);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/is in "delete" journal mode rather than WAL/);
      expect(warnings[0]).toMatch(/section 3a/);
    });

    it('leaves an in-memory database alone, which has no journal to keep', () => {
      const db = new BetterSqlite3(':memory:');
      try {
        sqlitePragmas(':memory:')(db);
        expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
      } finally {
        db.close();
      }
    });

    it('is wired into the options the application boots with', () => {
      const options = buildDataSourceOptions() as { type: string; prepareDatabase?: unknown };
      expect(options.type).toBe('better-sqlite3');
      expect(typeof options.prepareDatabase).toBe('function');
    });
  });

  /**
   * better-sqlite3 hands TypeORM one connection for every query runner, so two
   * overlapping `dataSource.transaction()` calls do not queue behind each other:
   * they destroy each other. Enrolment carries its own chain for this reason
   * (workflow.service.ts); account deletion and cohort creation do not, and
   * should not have to.
   */
  describe('overlapping transactions on the one connection sqlite gives', () => {
    it('settles two that arrive together, rather than losing both', async () => {
      const dataSource = await open(optionsFor(path.join(dir, 'transactions.sqlite')));

      const enrol = (id: string) =>
        dataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO users ("id","email","passwordHash","displayName") ` +
              `VALUES ('${id}','${id}@class.edu','hash','A learner')`,
          );
          // A turn of the event loop inside the transaction, which is what a
          // second request arriving mid-write looks like.
          await new Promise((resolve) => setImmediate(resolve));
          return id;
        });

      await expect(Promise.all([enrol('t1'), enrol('t2')])).resolves.toEqual(['t1', 't2']);
      const rows: { id: string }[] = await dataSource.query(`SELECT id FROM users ORDER BY id`);
      expect(rows.map((row) => row.id)).toEqual(['t1', 't2']);
    });

    it('leaves a Postgres deployment its real concurrency', () => {
      const pg = new DataSource({
        type: 'postgres',
        url: 'postgres://nobody@127.0.0.1:1/none',
        entities: ALL_ENTITIES,
      });
      const before = pg.transaction;
      expect(serialiseSqliteTransactions(pg).transaction).toBe(before);
      expect(Object.prototype.hasOwnProperty.call(pg, 'transaction')).toBe(false);
    });
  });
});
