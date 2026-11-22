import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describeIfPostgres } from './support/postgres';

/** Real PG16 coverage: a SQLite-only test cannot expose node-postgres parsing
 * timestamp-without-zone values using the API process's local timezone.
 * Every child uses a dedicated connection and only a TEMP table. */
const projectRoot = path.resolve(__dirname, '../../..');

const childSource = String.raw`
require('reflect-metadata');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const initialTimezone = process.env.TZ;
const { buildDataSourceOptions } = require('./apps/api/src/db/database.module');
let source, runner;
(async () => {
  try {
    const options = buildDataSourceOptions();
    assert.equal(options.type, 'postgres');
    // Disable only schema mutation; retain the application's actual driver,
    // entities and connection options, including its timezone contract.
    source = new DataSource({ ...options, synchronize: false, migrationsRun: false, logging: false });
    await source.initialize();
    runner = source.createQueryRunner();
    await runner.connect();
    const connectionTimezone = (await runner.query('SHOW TimeZone'))[0].TimeZone;
    assert.equal(connectionTimezone, 'UTC');
    assert.equal(process.env.TZ, 'UTC');
    await runner.query('CREATE TEMP TABLE learnsdlc_timezone_probe (id integer PRIMARY KEY, "createdAt" timestamp without time zone NOT NULL)');
    const before = Date.now();
    const [clock] = await runner.query('INSERT INTO learnsdlc_timezone_probe (id,"createdAt") VALUES (1,LOCALTIMESTAMP(3)) RETURNING "createdAt"');
    const after = Date.now();
    assert(clock.createdAt instanceof Date);
    assert(clock.createdAt.getTime() >= before - 2000 && clock.createdAt.getTime() <= after + 2000,
      'A just-created timestamp must not appear hours old or in the future');

    const exact = new Date('2026-09-15T01:02:03.456Z');
    await runner.query('INSERT INTO learnsdlc_timezone_probe (id,"createdAt") VALUES (2,$1),(3,$1)', [exact]);
    const rows = await runner.query('SELECT id,"createdAt" FROM learnsdlc_timezone_probe WHERE id IN (2,3) ORDER BY id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].createdAt.toISOString(), exact.toISOString());
    assert.equal(rows[1].createdAt.getTime(), exact.getTime());
    const [stored] = await runner.query('SELECT to_char("createdAt",\'YYYY-MM-DD HH24:MI:SS.MS\') AS wall FROM learnsdlc_timezone_probe WHERE id=2');
    assert.equal(stored.wall, '2026-09-15 01:02:03.456');
    // This is the timestamp equality + id tie-break used by conversation
    // pagination; feed the driver-decoded Date back into the real SQL query.
    const next = await runner.query('SELECT id FROM learnsdlc_timezone_probe WHERE id IN (2,3) AND "createdAt"=$1 AND id>$2 ORDER BY "createdAt",id', [rows[0].createdAt, 2]);
    assert.deepEqual(next.map(row => row.id), [3]);
    const previous = await runner.query('SELECT id FROM learnsdlc_timezone_probe WHERE id IN (2,3) AND ("createdAt"<$1 OR ("createdAt"=$1 AND id<$2)) ORDER BY "createdAt" DESC,id DESC', [rows[1].createdAt, 3]);
    assert.deepEqual(previous.map(row => row.id), [2]);
    console.log(JSON.stringify({ passed: true, initialTimezone, processTimezone: process.env.TZ,
      connectionTimezone, observedClockOffsetMs: clock.createdAt.getTime() - after,
      exactDate: rows[0].createdAt.toISOString(), forwardCursorIds: next.map(row => row.id), backwardCursorIds: previous.map(row => row.id),
      mutations: 'dedicated connection TEMP table only' }));
  } catch (error) {
    console.log(JSON.stringify({ passed: false, initialTimezone, name: error.name,
      message: error.name === 'AssertionError' ? error.message : 'Database test could not complete',
      code: error.driverError?.code || error.code || null }));
    process.exitCode = 1;
  } finally {
    if (runner) {
      // Explicitly drop before returning this connection to the pool; no
      // permanent table name or learner row is used by this test.
      await runner.query('DROP TABLE IF EXISTS pg_temp.learnsdlc_timezone_probe').catch(() => undefined);
      await runner.release();
    }
    if (source?.isInitialized) await source.destroy();
  }
})();
`;

describeIfPostgres('PostgreSQL UTC timestamp contract across API host timezones', () => {
  it.each(['Asia/Singapore', 'America/Los_Angeles'])('round-trips clock, milliseconds and pagination in a fresh %s process', (timezone) => {
    const child = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', childSource], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        DATABASE_URL: process.env.DATABASE_URL,
        TZ: timezone,
        NODE_ENV: 'production',
        AUTH_PROVIDER: 'local',
        RUN_MIGRATIONS: 'false',
        OPENAI_API_KEY: '',
        TS_NODE_PROJECT: path.join(projectRoot, 'apps/api/tsconfig.json'),
        TS_NODE_TRANSPILE_ONLY: 'false',
      },
      encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
    });
    // Child output is an allowlisted result, never connection strings or raw
    // driver errors. stderr is intentionally not copied into test failures.
    const lines = child.stdout.trim().split('\n').filter(Boolean);
    const result = lines.length ? JSON.parse(lines[lines.length - 1]) as Record<string, unknown> : { passed: false, output: 'No sanitized child result' };
    expect({ exitCode: child.status, result }).toEqual({ exitCode: 0, result: expect.objectContaining({
      passed: true, initialTimezone: timezone, processTimezone: 'UTC', connectionTimezone: 'UTC',
      exactDate: '2026-09-15T01:02:03.456Z', forwardCursorIds: [3], backwardCursorIds: [2],
      mutations: 'dedicated connection TEMP table only',
    }) });
  }, 60000);
});
