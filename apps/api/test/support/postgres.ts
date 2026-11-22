import { readFileSync } from 'fs';

/**
 * The two switches that let a spec run against PostgreSQL. Without either,
 * the specs they gate are skipped and the suite runs on in-memory SQLite.
 *
 * They mean different things and are kept apart:
 *
 * - `DATABASE_URL` is what the application itself reads. When it is set, the
 *   booted `AppModule` runs on that database, and the end-to-end specs that
 *   only make sense on PostgreSQL run too (`describeIfPostgres`).
 * - `POSTGRES_TEST_CONFIG` names a JSON file, `{ "databaseUrl": "postgres://..." }`,
 *   for the `*.postgres.spec.ts` files (`describePostgres`). Those specs build
 *   scratch schemas on a loopback cluster and run migrations against them, so
 *   they never touch the database the application uses. `GAP_SECURITY_CONFIG`
 *   is read as the same switch, for configurations that already set it.
 */

/** `describe` when `DATABASE_URL` is set, `describe.skip` otherwise. */
export const describeIfPostgres = process.env.DATABASE_URL ? describe : describe.skip;

/** The path of the scratch-cluster config file, or `undefined` when none is set. */
export function postgresConfigPath(): string | undefined {
  return process.env.POSTGRES_TEST_CONFIG || process.env.GAP_SECURITY_CONFIG || undefined;
}

/** `describe` when a scratch-cluster config file is named, `describe.skip` otherwise. */
export const describePostgres = postgresConfigPath() ? describe : describe.skip;

/**
 * The `databaseUrl` the config file holds, or `null` where none is named.
 * It is not checked here: each spec refuses any target but the one it may
 * use, and some accept more than `isolatedPostgresUrl` does.
 */
export function postgresTarget(): string | null {
  const configured = postgresConfigPath();
  if (!configured) return null;
  return JSON.parse(readFileSync(configured, 'utf8')).databaseUrl;
}

/**
 * The isolated PostgreSQL target, or `null` where none is configured (the
 * spec then skips itself). Refuses any host but the loopback cluster and any
 * database but the two scratch ones, so it can never name a shared database.
 */
export function isolatedPostgresUrl(): string | null {
  const databaseUrl = postgresTarget();
  if (databaseUrl === null) return null;
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, '');
  if (url.hostname !== '127.0.0.1' || url.port !== '5494' || !/^lsdlc_(numbers|pgspecs)$/.test(database)) {
    throw new Error('isolated migration target refused');
  }
  return url.toString();
}
