import { Global, Logger, Module, OnApplicationShutdown, Provider } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions, MigrationExecutor } from 'typeorm';
import { config } from '../config';
import { ALL_ENTITIES } from './entities';
import { repoToken } from './inject';

/** The slice of better-sqlite3's Database this file uses; the package ships no types. */
interface SqliteHandle {
  pragma(source: string): unknown;
}

/**
 * Pragmas for the sqlite store, applied on every connection before TypeORM
 * uses it.
 *
 * better-sqlite3 is synchronous, so a write is event-loop time in this
 * process. In the default rollback-journal mode with `synchronous = FULL`
 * every autosave writes a journal file and fsyncs twice, and committing takes
 * an exclusive lock, so one learner's save and another's dashboard poll wait on
 * each other: a reader holding a read transaction makes the writer's COMMIT
 * fail outright with SQLITE_BUSY, which is what database.module.spec.ts
 * reproduces. At class load that contention is the difference between a
 * `/health/live` answer of a few milliseconds and one of about a tenth of a
 * second with thirty learners active.
 *
 * WAL makes readers and one writer concurrent, and `synchronous = NORMAL` is
 * the durability level WAL was designed for: a crash of this process cannot
 * corrupt the file, and only an OS-level crash or power cut can lose the last
 * transactions.
 *
 * An in-memory database has no journal to keep, so it is left alone.
 */
export function sqlitePragmas(databasePath: string): (db: SqliteHandle) => void {
  return (db: SqliteHandle) => {
    if (databasePath === ':memory:') return;
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  };
}

/**
 * Pins this process's timezone to UTC, for PostgreSQL. Existing TIMESTAMP
 * columns contain UTC wall times, and node-postgres reads and writes those
 * through the process timezone; a non-UTC host otherwise makes new
 * conversation claims look hours old. The connection's own timezone is pinned
 * in the options below. Called while the options are built, so it runs before
 * any connection opens, the migration CLI's included; a browser's locale is
 * separate.
 */
function applyDatabaseTimezone(): void {
  process.env.TZ = 'UTC';
}

/**
 * The options the running app and the TypeORM CLI open the store with. On
 * PostgreSQL, building them also pins the process timezone (see
 * applyDatabaseTimezone).
 */
export function buildDataSourceOptions(): DataSourceOptions {
  // Production (and any RUN_MIGRATIONS=true deployment) applies versioned
  // migrations instead of letting TypeORM auto-sync the schema: `synchronize`
  // infers DDL from the entities and will happily drop or rewrite a column on
  // a model change, which is unacceptable against real learner data. The two
  // flags are resolved separately in config.ts so that a replica started with
  // RUN_MIGRATIONS=false does neither. openDataSource() below is what acts on
  // them, so that neither runs before anything has looked at the file.
  //
  // An applied migration is frozen by name and by body. TypeORM records each
  // migration's class name in `learnsdlc_migrations` and loads every file in
  // the folder by this glob, so renaming a file or class makes an existing
  // database run it again or out of order, and pointing an old migration at a
  // shared helper lets a later edit to that helper change what it does on a
  // fresh database. A change to the schema is always a new migration.
  const migrationSettings = {
    synchronize: config.schemaSync,
    migrationsRun: config.runMigrations,
    migrations: [path.join(__dirname, '..', 'migrations', '*.{ts,js}')],
    migrationsTableName: 'learnsdlc_migrations',
  };

  if (config.databaseUrl) {
    applyDatabaseTimezone();
    return {
      type: 'postgres',
      url: config.databaseUrl,
      extra: { options: '-c timezone=UTC' },
      entities: ALL_ENTITIES,
      ...migrationSettings,
    };
  }
  if (config.dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
  }
  return {
    type: 'better-sqlite3',
    database: config.dbPath,
    entities: ALL_ENTITIES,
    prepareDatabase: sqlitePragmas(config.dbPath),
    ...migrationSettings,
  };
}

function isSqlite(options: DataSourceOptions): boolean {
  return options.type === 'better-sqlite3' || options.type === 'sqlite';
}

/** What openDataSource did about a sqlite file that predates the migrations. */
export type SqliteAdoption =
  | { action: 'not-sqlite' }
  | { action: 'empty' }
  | { action: 'already-migrated' }
  | { action: 'adopted'; migrations: string[] };

/** What one migration run did, by migration name. */
export interface MigrationOutcome {
  /** The migrations a schema-synced sqlite file recorded as applied without running them; null when no file was adopted. */
  adopted: string[] | null;
  /** The migrations that ran. */
  applied: string[];
}

/**
 * Lets `RUN_MIGRATIONS=true` boot on a sqlite file that was created by schema
 * sync, without rewriting it.
 *
 * A local-first file created by `synchronize` has every table and no
 * `learnsdlc_migrations` table. Migration 1 would then fail on
 * `CREATE TABLE "users"` (`BOOT FAILED: table "users" already exists`) on
 * the morning of a class.
 *
 * A schema that already matches the entities is, by definition, the schema the
 * migrations describe, so the migrations are recorded as applied and nothing is
 * executed against the file (TypeORM calls this a fake run). When the schema
 * does *not* match, the file is older or has been altered by hand, and only a
 * person can say what to do with a term of coursework: the boot stops and names
 * the first statement that differs. Nothing is written either way until the
 * comparison has passed.
 */
export async function adoptSchemaSyncedSqliteFile(
  dataSource: DataSource,
  log: (message: string) => void,
): Promise<SqliteAdoption> {
  if (!isSqlite(dataSource.options)) return { action: 'not-sqlite' };

  const migrationsTable = dataSource.options.migrationsTableName || 'migrations';
  const tables: { name: string }[] = await dataSource.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const names = tables.map((table) => table.name);
  if (names.includes(migrationsTable)) return { action: 'already-migrated' };
  if (names.length === 0) return { action: 'empty' };

  const file = String((dataSource.options as { database?: unknown }).database ?? '(unnamed)');
  const drift = await dataSource.driver.createSchemaBuilder().log();
  if (drift.upQueries.length > 0) {
    throw new Error(
      `refusing to run migrations against ${file}: it holds ${names.length} table(s) written by schema sync ` +
        `and no "${migrationsTable}" table, and its schema no longer matches the entities, so the migrations ` +
        `would fail on a table that already exists. ${drift.upQueries.length} statement(s) differ, the first ` +
        `being: ${drift.upQueries[0].query}. Take a backup with scripts/sqlite-backup.mjs and follow ` +
        `docs/production-runbook.md, section 3a, "adopting a file written before migrations".`,
    );
  }

  const executor = new MigrationExecutor(dataSource);
  // Asked before the fake run, which reports nothing it did not actually execute.
  const adopted = (await executor.getPendingMigrations()).map((migration) => migration.name);
  executor.fake = true;
  await executor.executePendingMigrations();
  log(
    `${file} was written by schema sync and its schema matches the entities exactly, so its ` +
      `${adopted.length} migration(s) were recorded as applied without being run: ${adopted.join(', ')}`,
  );
  return { action: 'adopted', migrations: adopted };
}

/**
 * `journal_mode = WAL` is a request, not a guarantee: sqlite silently stays in
 * rollback-journal mode on a filesystem that cannot support the shared-memory
 * file WAL needs, which is most network shares and some synced folders. That
 * is a configuration the local-first store must not run in, so say so rather
 * than let it pass as if the pragma had taken.
 */
async function warnIfNotWal(dataSource: DataSource, warn: (message: string) => void): Promise<void> {
  const file = String((dataSource.options as { database?: unknown }).database ?? '');
  if (!isSqlite(dataSource.options) || file === ':memory:') return;
  const [row] = await dataSource.query(`PRAGMA journal_mode`);
  const mode = String(row?.journal_mode ?? '').toLowerCase();
  if (mode === 'wal') return;
  warn(
    `${file} is in "${mode}" journal mode rather than WAL. sqlite refuses WAL on most network shares and ` +
      `some synced folders, and without it every autosave blocks every reader on this process's event loop. ` +
      `Move the database to a local disk (docs/production-runbook.md, section 3a).`,
  );
}

/** Every row in every application table, migrations bookkeeping aside. */
async function countRows(dataSource: DataSource, migrationsTable: string): Promise<number> {
  const tables: { name: string }[] = await dataSource.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  let rows = 0;
  for (const table of tables) {
    if (table.name === migrationsTable) continue;
    const [counted] = await dataSource.query(`SELECT count(*) AS n FROM "${table.name}"`);
    rows += Number(counted.n);
  }
  return rows;
}

/**
 * Schema auto-sync, with the one case the local-first store forbids taken out of it.
 *
 * `synchronize` infers DDL from the entity classes, so it closes any gap
 * between a file and a model by rewriting the file: dropping a column that is
 * no longer declared, retyping one that changed. On an empty development
 * database that is a convenience. Against a sqlite file holding a term of
 * coursework it is data loss with no prompt.
 *
 * So: sync a file freely while it is empty, and refuse the moment there are
 * rows and the schema has moved. The supported answer is a migration, which
 * runs on sqlite too (`RUN_MIGRATIONS=true`, docs/production-runbook.md §3a).
 */
export async function synchronizeSchema(
  dataSource: DataSource,
  log: (message: string) => void,
): Promise<'unchanged' | 'synchronized'> {
  const pending = await dataSource.driver.createSchemaBuilder().log();
  if (pending.upQueries.length === 0) return 'unchanged';

  const file = String((dataSource.options as { database?: unknown }).database ?? '(unnamed)');
  if (isSqlite(dataSource.options) && file !== ':memory:') {
    const rows = await countRows(dataSource, dataSource.options.migrationsTableName || 'migrations');
    if (rows > 0) {
      throw new Error(
        `refusing to auto-sync the schema of ${file}: it holds ${rows} row(s), and TypeORM's synchronize ` +
          `would run ${pending.upQueries.length} statement(s) against them, the first being: ` +
          `${pending.upQueries[0].query}. Synchronize infers DDL from the entity classes and drops or ` +
          `retypes a column to make a file match a model, so against real work it is data loss. Boot with ` +
          `RUN_MIGRATIONS=true and a migration for the change (docs/production-runbook.md, section 3a), or ` +
          `move the file aside if it is development data.`,
      );
    }
  }
  await dataSource.synchronize();
  log(`schema auto-sync built ${pending.upQueries.length} statement(s) into an empty ${file}`);
  return 'synchronized';
}

/**
 * One `dataSource.transaction()` at a time, for sqlite only.
 *
 * better-sqlite3 hands TypeORM one connection for every query runner
 * (`AbstractSqliteQueryRunner.connect` returns `this.driver.databaseConnection`;
 * the comment on `release()` says "sqlite do not support multiple connections
 * thus query runners"). Two overlapping transactions therefore do not queue,
 * they destroy each other: the second caller fails with
 * `SqliteError: cannot start a transaction within a transaction` and the first
 * with `Transaction is not started yet`, mid-write.
 *
 * Enrolment (`workflow.service.ts`) carries its own chain for this reason;
 * account deletion and cohort creation do not, and neither should have to.
 * Serialising here makes every caller safe on the one dialect that needs it,
 * and Postgres keeps real concurrent transactions.
 *
 * The chain never carries a rejection forward: one caller's failed transaction
 * must not fail everyone queued behind it.
 */
export function serialiseSqliteTransactions(dataSource: DataSource): DataSource {
  if (!isSqlite(dataSource.options)) return dataSource;
  const original = dataSource.transaction.bind(dataSource) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let queue: Promise<unknown> = Promise.resolve();
  (dataSource as { transaction: unknown }).transaction = (...args: unknown[]) => {
    const run = () => original(...args);
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return dataSource;
}

/**
 * Opens the store the way the application boots it: connect, sync or migrate
 * the schema, and adopt a pre-migration sqlite file if that is what this is.
 *
 * Neither step is left to TypeORM's own `synchronize` and `migrationsRun`,
 * which both fire inside `initialize()` and so give nothing a chance to look at
 * the file first. The flags on the options still decide what happens, so
 * `RUN_MIGRATIONS=false` on a replica runs no migration.
 */
export async function openDataSource(
  options: DataSourceOptions = buildDataSourceOptions(),
  hooks: {
    log?: (message: string) => void;
    warn?: (message: string) => void;
    /** Told what a migration run did: the migrations an adopted file recorded (null when no file was adopted) and those applied. */
    migrated?: (outcome: MigrationOutcome) => void;
  } = {},
): Promise<DataSource> {
  const logger = new Logger('Database');
  const log = hooks.log ?? ((message: string) => logger.log(message));
  const warn = hooks.warn ?? hooks.log ?? ((message: string) => logger.warn(message));
  const runMigrations = options.migrationsRun === true;
  const dataSource = new DataSource({
    ...options,
    migrationsRun: false,
    synchronize: false,
  } as DataSourceOptions);
  await dataSource.initialize();

  try {
    await warnIfNotWal(dataSource, warn);
    if (options.synchronize === true) await synchronizeSchema(dataSource, log);
    if (runMigrations) {
      const adoption = await adoptSchemaSyncedSqliteFile(dataSource, log);
      const applied = await dataSource.runMigrations({ transaction: 'all' });
      if (applied.length) {
        log(`applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`);
      }
      hooks.migrated?.({
        adopted: adoption.action === 'adopted' ? adoption.migrations : null,
        applied: applied.map((m) => m.name),
      });
    }
  } catch (error) {
    // Release the file handle so the message above is the whole story and a
    // supervisor restarting the process does not meet a locked database.
    await dataSource.destroy().catch(() => undefined);
    throw error;
  }
  return serialiseSqliteTransactions(dataSource);
}

const dataSourceProvider: Provider = {
  provide: DataSource,
  useFactory: async () => openDataSource(),
};

const repositoryProviders: Provider[] = ALL_ENTITIES.map((entity) => ({
  provide: repoToken(entity),
  useFactory: (dataSource: DataSource) => dataSource.getRepository(entity),
  inject: [DataSource],
}));

@Global()
@Module({
  providers: [dataSourceProvider, ...repositoryProviders],
  exports: [DataSource, ...ALL_ENTITIES.map((entity) => repoToken(entity))],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
