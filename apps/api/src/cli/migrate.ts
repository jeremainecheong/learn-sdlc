import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import type { DataSourceOptions } from 'typeorm';
import { pluralWord } from '@learnsdlc/shared';
import { REPO_ROOT_MARKER, findUp } from '../config/paths';
import { buildDataSourceOptions, openDataSource, type MigrationOutcome } from '../db/database.module';
import { runCli } from './run';

/**
 * Bring the store's schema to the latest migration, and say what that took.
 *
 *   npm run db:migrate -w @learnsdlc/api
 *
 * scripts/demo.sh runs this as a step of its own, before anything binds a
 * port. The API would do the same work on boot (RUN_MIGRATIONS=true), but a
 * file that needs a person (one written before migrations existed and since
 * altered) is then a message on a terminal instead of a stack that half
 * started and a log nobody is watching.
 *
 * Nothing here decides anything about the schema. openDataSource
 * (db/database.module.ts) already carries the whole story: the WAL warning, the
 * fake run that adopts a file written by schema sync, and the refusal that
 * names the first statement that differs.
 *
 * Exit codes: 0 done, 2 bad usage, 3 the store needs a person, 70 an
 * unexpected failure (cli/run.ts).
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run db:migrate -w @learnsdlc/api`);
  process.exit(2);
}

/** The store as a person would name it: the repository-relative file, or the Postgres database. */
export function describeStore(options: DataSourceOptions): string {
  if (options.type === 'postgres') {
    const url = String((options as { url?: unknown }).url ?? '');
    try {
      const parsed = new URL(url);
      return `the postgres database ${parsed.pathname.replace(/^\//, '')} on ${parsed.host}`;
    } catch {
      return 'the postgres database';
    }
  }
  const file = String((options as { database?: unknown }).database ?? '(unnamed)');
  if (file === ':memory:' || !path.isAbsolute(file)) return file;
  const root = findUp(__dirname, REPO_ROOT_MARKER);
  const relative = root ? path.relative(root, file) : file;
  return relative.startsWith('..') ? file : relative;
}

/**
 * Whether there was a store here before this run. A sqlite file of zero bytes
 * is one better-sqlite3 has opened and not written, which is nothing.
 */
export function storeExisted(options: DataSourceOptions): boolean {
  if (options.type === 'postgres') return true;
  const file = String((options as { database?: unknown }).database ?? '');
  if (file === ':memory:' || !file) return false;
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function count(n: number, one: string): string {
  return `${n} ${pluralWord(n, one)}`;
}

/** The one line this command prints when it worked. */
export function summarise(store: string, existed: boolean, outcome: MigrationOutcome): string {
  if (outcome.adopted) {
    return (
      `${store} was written before migrations existed and matches the entities exactly, so its ` +
      `${count(outcome.adopted.length, 'migration')} were recorded as applied without being run`
    );
  }
  const n = outcome.applied.length;
  if (n === 0) return `${store} is already at the latest migration`;
  return existed
    ? `${store} brought up to date, ${count(n, 'migration')} applied`
    : `${store} created, ${count(n, 'migration')} applied`;
}

export interface MigrateOutput {
  log: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Open the store with migrations forced on, print one line, and close it.
 * Takes its options rather than reading the environment so a spec can point it
 * at a scratch file.
 */
export async function migrate(
  options: DataSourceOptions,
  out: MigrateOutput = { log: console.log, error: console.error },
): Promise<number> {
  const store = describeStore(options);
  const existed = storeExisted(options);
  let outcome: MigrationOutcome = { adopted: null, applied: [] };
  let dataSource;
  try {
    dataSource = await openDataSource(
      { ...options, migrationsRun: true, synchronize: false } as DataSourceOptions,
      {
        // The adoption and applied lines are folded into the summary line.
        log: () => undefined,
        migrated: (done) => {
          outcome = done;
        },
        // The WAL warning is the operator's, not this command's, so it is said
        // as it is said on boot rather than folded into the summary line.
        warn: (message: string) => out.error(message),
      },
    );
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
  try {
    out.log(summarise(store, existed, outcome));
    return 0;
  } finally {
    await dataSource.destroy().catch(() => undefined);
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.length) usage(`this command takes no arguments, and was given ${argv[0]}`);
  return migrate(buildDataSourceOptions());
}

if (require.main === module) void runCli(() => main(process.argv.slice(2)));
