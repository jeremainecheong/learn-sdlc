import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from '../db/entities';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import { BOOT_SWEEP_DELAY_MS, RetentionService, SWEEP_INTERVAL_MS, type SweepResult } from './retention.service';

/**
 * A boot writes nothing in the window after a start.
 *
 * A deployment step may compare every table before and after a new process
 * starts (per table `count(*)` and
 * `md5(string_agg(md5(row_to_json(t)::text) ORDER BY h))`) and refuse on any
 * change. The process's own boot runs inside that window, so a boot that
 * writes a row would fail such a check (see config/retention.ts).
 *
 * This spec seeds the two kinds of row `RetentionService.sweep()` changes: a
 * `task_resets` copy ranked beyond the newest three of its task state that
 * still holds bytes, and an `ai_cache` row older than the 30-day window, and
 * digests every table of the scratch schema in exactly that shape before
 * and after the service's boot hook.
 *
 * Self-skips without `POSTGRES_TEST_CONFIG`; refuses any database but the
 * loopback cluster's `lsdlc_numbers` / `lsdlc_pgspecs`; works in a scratch
 * schema it drops.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'retention_boot_window';

/** The before-and-after comparison, one row per table: name, count, digest (schema-qualified here). */
async function digests(db: DataSource, schema: string): Promise<Record<string, { count: string; digest: string }>> {
  const names = ((await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema])) as {
    tablename: string;
  }[]).map((row) => row.tablename);
  const out: Record<string, { count: string; digest: string }> = {};
  for (const name of names) {
    const [row] = (await db.query(
      `SELECT count(*)::text AS count, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS digest ` +
        `FROM (SELECT md5(row_to_json(t)::text) h FROM "${schema}"."${name}" t) rows`,
    )) as { count: string; digest: string }[];
    out[name] = row;
  }
  return out;
}

const changed = (
  before: Record<string, { count: string; digest: string }>,
  after: Record<string, { count: string; digest: string }>,
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    .sort();

describePg('the retention sweep against the window after a start (PostgreSQL)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);
  const TASK_STATE = randomUUID();

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    db = await new DataSource({
      ...postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 2 },
    } as never).initialize();
    await db.runMigrations({ transaction: 'all' });
  });

  afterAll(async () => {
    jest.useRealTimers();
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM "task_resets"`);
    await db.query(`DELETE FROM "ai_cache"`);
    // Four copies of one task state, one second apart; the oldest (rank 4) still holds bytes.
    for (let n = 1; n <= 4; n++) {
      await db.query(
        `INSERT INTO "task_resets" ("id", "taskStateId", "userId", "files", "createdAt") ` +
          `VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5))`,
        [randomUUID(), TASK_STATE, 'learner-rtops2', JSON.stringify({ 'src/app.py': `copy ${n}` }), 10 - n],
      );
    }
    // One mentor-cache row a day past the 30-day window.
    await db.query(
      `INSERT INTO "ai_cache" ("cacheKey", "content", "createdAt") VALUES ($1, $2, now() - interval '31 days')`,
      ['rtops2-old', 'a cached reply'],
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('seeds exactly what one sweep would change (the fixture is live)', async () => {
    const service = new RetentionService(db);
    // A sweep called directly (not the boot hook) shows the seeds are in reach.
    const before = await digests(db, schema);
    expect(await service.sweep()).toEqual({ cacheEntries: 1, resetCopies: 1 });
    expect(changed(before, await digests(db, schema))).toEqual(['ai_cache', 'task_resets']);
  });

  it('a boot makes no row change within the window after a start', async () => {
    // Only the timers are faked: the database I/O keeps its real event loop.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date', 'hrtime', 'performance'] });
    const service = new RetentionService(db);
    const before = await digests(db, schema);
    await service.onApplicationBootstrap();
    const after = await digests(db, schema);
    service.onApplicationShutdown();
    expect(changed(before, after)).toEqual([]);
  });

  /**
   * GREEN half (after the fix). The longest the pair can take from the
   * candidate's start to its after-digest: its maintenance alarm (1,800 s),
   * plus the rest of a `ready()` whose probe swallowed that alarm (`TimeoutError`
   * is an `OSError`): its 180 s deadline and one poll's overrun (434 s), plus
   * the after-digest's two `psql` (16 s) = 2,430 s. The pytest guard
   * `test_rx_retention_cutover_20261002.py` derives it from the pair, its v21
   * base and `app_admission.py`, and holds this constant equal to it.
   */
  const PAIR_CUTOVER_WINDOW_MS = 2_430_000;

  it('holds the first sweep past the whole window, then sweeps with today\'s results and daily after', async () => {
    expect(BOOT_SWEEP_DELAY_MS).toBeGreaterThanOrEqual(2 * PAIR_CUTOVER_WINDOW_MS);
    expect(SWEEP_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date', 'hrtime', 'performance'] });
    const service = new RetentionService(db);
    const runs: Promise<SweepResult>[] = [];
    const sweepAndLog = service.sweepAndLog.bind(service);
    jest.spyOn(service, 'sweepAndLog').mockImplementation(() => {
      const run = sweepAndLog();
      runs.push(run);
      return run;
    });
    const before = await digests(db, schema);

    await service.onApplicationBootstrap();
    jest.advanceTimersByTime(PAIR_CUTOVER_WINDOW_MS);
    expect(runs).toHaveLength(0);
    expect(changed(before, await digests(db, schema))).toEqual([]);
    jest.advanceTimersByTime(BOOT_SWEEP_DELAY_MS - PAIR_CUTOVER_WINDOW_MS - 1);
    expect(runs).toHaveLength(0);

    jest.advanceTimersByTime(1);
    expect(runs).toHaveLength(1);
    expect(await runs[0]).toEqual({ cacheEntries: 1, resetCopies: 1 });
    expect(changed(before, await digests(db, schema))).toEqual(['ai_cache', 'task_resets']);

    jest.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(runs).toHaveLength(2);
    expect(await runs[1]).toEqual({ cacheEntries: 0, resetCopies: 0 });

    // (the pool's own idle timer is faked too, so the count is of sweeps, not of timers)
    service.onApplicationShutdown();
    jest.advanceTimersByTime(2 * SWEEP_INTERVAL_MS);
    expect(runs).toHaveLength(2);
  });
});
