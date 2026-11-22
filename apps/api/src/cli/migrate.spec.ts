import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { sqlitePragmas } from '../db/database.module';
import { ALL_ENTITIES } from '../db/entities';
import { describeStore, migrate, storeExisted, summarise } from './migrate';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BetterSqlite3 = require('better-sqlite3');

/**
 * The step scripts/demo.sh runs before anything binds a port. Everything it
 * decides is decided in database.module.ts (adopt, refuse, warn); what this
 * spec holds is the part a person reads: one line that says what happened to
 * their file, and an exit code a shell script can act on.
 */
describe('npm run db:migrate', () => {
  let dir = '';
  const opened: DataSource[] = [];

  const optionsFor = (file: string): DataSourceOptions =>
    ({
      type: 'better-sqlite3',
      database: file,
      entities: ALL_ENTITIES,
      synchronize: false,
      migrationsRun: true,
      migrations: [path.join(__dirname, '..', 'migrations', '*.{ts,js}')],
      migrationsTableName: 'learnsdlc_migrations',
      prepareDatabase: sqlitePragmas(file),
    }) as DataSourceOptions;

  /** A file written by schema sync, the way a store was built before it had migrations. */
  const schemaSyncedFile = async (name: string): Promise<string> => {
    const file = path.join(dir, name);
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: file,
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    await dataSource.query(
      `INSERT INTO users ("id","email","passwordHash","displayName") VALUES ('u1','learner@class.edu','hash','A learner')`,
    );
    await dataSource.destroy();
    return file;
  };

  const run = async (file: string): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await migrate(optionsFor(file), {
      log: (message) => out.push(message),
      error: (message) => err.push(message),
    });
    return { code, out, err };
  };

  /** Reopened after the command closed the file, to ask what it left behind. */
  const reopen = async (file: string): Promise<DataSource> => {
    const dataSource = new DataSource({
      ...optionsFor(file),
      migrationsRun: false,
    } as DataSourceOptions);
    await dataSource.initialize();
    opened.push(dataSource);
    return dataSource;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-d1-'));
  });

  afterAll(async () => {
    for (const dataSource of opened) {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a file, applies every migration, and says how many', async () => {
    const file = path.join(dir, 'fresh.sqlite');
    const { code, out, err } = await run(file);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/ created, \d+ migrations applied$/);

    const dataSource = await reopen(file);
    const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations ORDER BY id`);
    expect(out[0]).toBe(`${file} created, ${applied.length} migrations applied`);
    // The schema the migrations built is the schema the entities describe.
    expect((await dataSource.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });

  it('says nothing was left to do the second time, and does nothing', async () => {
    const file = path.join(dir, 'twice.sqlite');
    await run(file);
    const before = fs.statSync(file).size;

    const { code, out } = await run(file);

    expect(code).toBe(0);
    expect(out).toEqual([`${file} is already at the latest migration`]);
    expect(fs.statSync(file).size).toBe(before);
  });

  it('adopts a file written before migrations existed, and leaves the schema alone', async () => {
    const file = await schemaSyncedFile('adopt.sqlite');

    const { code, out } = await run(file);

    expect(code).toBe(0);
    expect(out[0]).toMatch(
      new RegExp(
        `^${file.replace(/[.]/g, '\\.')} was written before migrations existed and matches the ` +
          `entities exactly, so its \\d+ migrations were recorded as applied without being run$`,
      ),
    );

    const dataSource = await reopen(file);
    expect((await dataSource.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
    // and the learners' rows in it are untouched
    expect(await dataSource.query(`SELECT email FROM users`)).toEqual([{ email: 'learner@class.edu' }]);
  });

  it('refuses a file whose schema has drifted, names the first differing statement, and exits 3', async () => {
    const file = await schemaSyncedFile('drifted.sqlite');
    const raw = new BetterSqlite3(file);
    raw.exec(`ALTER TABLE "users" DROP COLUMN "tokenVersion"`);
    raw.close();

    const { code, out, err } = await run(file);

    expect(code).toBe(3);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/refusing to run migrations against .*drifted\.sqlite/);
    expect(err[0]).toMatch(/statement\(s\) differ, the first being: /);
    expect(err[0]).toMatch(/docs\/production-runbook\.md, section 3a/);

    // nothing was written: the file is still one a person can back up
    const check = new BetterSqlite3(file, { readonly: true });
    expect(
      check
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learnsdlc_migrations'`)
        .all(),
    ).toEqual([]);
    check.close();
  });

  describe('the line it prints', () => {
    it('counts one migration in the singular', () => {
      expect(summarise('data/learnsdlc.sqlite', true, { adopted: null, applied: ['B9Audit'] })).toBe(
        'data/learnsdlc.sqlite brought up to date, 1 migration applied',
      );
    });

    it('names a postgres deployment by its database and host, without the password', () => {
      const store = describeStore({
        type: 'postgres',
        url: 'postgres://learnsdlc:hunter2@db.example.edu:5432/learnsdlc',
      } as DataSourceOptions);
      expect(store).toBe('the postgres database learnsdlc on db.example.edu:5432');
      expect(store).not.toContain('hunter2');
    });

    it('treats a sqlite file of zero bytes as one that was not there', () => {
      const file = path.join(dir, 'zero.sqlite');
      fs.writeFileSync(file, '');
      expect(storeExisted(optionsFor(file))).toBe(false);
    });
  });
});
