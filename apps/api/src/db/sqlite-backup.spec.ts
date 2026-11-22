import 'reflect-metadata';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { openDataSource, sqlitePragmas } from './database.module';
import { ALL_ENTITIES } from './entities';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'sqlite-backup.mjs');

/**
 * A term of coursework lives in one file; docker-compose's backup service
 * only knows how to pg_dump Postgres. This is the sqlite half of
 * docs/production-runbook.md section 7, and the drill is the same shape as the Postgres one: restore the
 * latest backup into a scratch database and check the row counts.
 */
describe('the sqlite backup script', () => {
  let dir = '';
  let db = '';
  let out = '';

  const run = (args: string[]): string =>
    execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const runJson = <T>(args: string[]): T => JSON.parse(run([...args, '--json'])) as T;

  /** The archives in a backup directory, without the manifests beside them. */
  const archives = (dir: string): string[] =>
    fs.readdirSync(dir).filter((name) => name.endsWith('.sqlite.gz')).sort();

  /** A migrated database with a class's worth of work in it. */
  const seed = async (file: string, learners: number): Promise<DataSource> => {
    const options: DataSourceOptions = {
      type: 'better-sqlite3',
      database: file,
      entities: ALL_ENTITIES,
      synchronize: false,
      migrationsRun: true,
      migrations: [path.join(__dirname, '..', 'migrations', '*.{ts,js}')],
      migrationsTableName: 'learnsdlc_migrations',
      prepareDatabase: sqlitePragmas(file),
    } as DataSourceOptions;
    const dataSource = await openDataSource(options, { log: () => undefined });
    for (let i = 0; i < learners; i++) {
      await dataSource.query(
        `INSERT INTO users ("id","email","passwordHash","displayName") VALUES (?,?,?,?)`,
        [`u${i}`, `learner${i}@class.edu`, 'hash', `Learner ${i}`],
      );
      await dataSource.query(`INSERT INTO enrollments ("id","userId","projectSlug") VALUES (?,?,?)`, [
        `e${i}`,
        `u${i}`,
        'other-pack',
      ]);
    }
    return dataSource;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-a5-backup-'));
    db = path.join(dir, 'learnsdlc.sqlite');
    out = path.join(dir, 'backups');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a verified, compressed backup of a database that is still being written to', async () => {
    const live = await seed(db, 5);
    try {
      // The API has not checkpointed: those five learners exist only in the
      // write-ahead log. A file copy would miss them; the online backup does not.
      const made = runJson<{ file: string; rows: number; counts: Record<string, number> }>([
        '--db',
        db,
        '--out',
        out,
      ]);
      expect(made.counts.users).toBe(5);
      expect(made.counts.enrollments).toBe(5);
      expect(fs.existsSync(made.file)).toBe(true);
      expect(path.basename(made.file)).toMatch(/^learnsdlc-\d{8}T\d{6}Z\.sqlite\.gz$/);
      // nothing half-written is left where a restore could find it
      expect(fs.readdirSync(out).filter((name) => name.includes('.part') || name.includes('.raw'))).toEqual([]);
    } finally {
      await live.destroy();
    }
  });

  it('restores the latest backup into a scratch file and matches every row count', async () => {
    const live = await seed(db, 4);
    await live.destroy();

    const report = runJson<{
      ok: boolean;
      rows: { table: string; live: number; backup: number; restored: number }[];
      mismatched: unknown[];
    }>(['--db', db, '--out', out, '--drill']);

    expect(report.ok).toBe(true);
    expect(report.mismatched).toEqual([]);
    const users = report.rows.find((row) => row.table === 'users');
    expect(users).toEqual({ table: 'users', live: 4, backup: 4, restored: 4 });
    // and the drill cleans up after itself
    expect(fs.existsSync(path.join(dir, 'restored.sqlite'))).toBe(false);
  });

  it('restores over a database file and takes the stale write-ahead log with it', async () => {
    const live = await seed(db, 3);
    await live.destroy();
    const made = runJson<{ file: string }>(['--db', db, '--out', out]);

    const target = path.join(dir, 'restored.sqlite');
    fs.writeFileSync(`${target}-wal`, 'a write-ahead log from the database being replaced');
    const restored = runJson<{ rows: number; counts: Record<string, number> }>([
      '--restore',
      made.file,
      '--to',
      target,
      '--force',
    ]);

    expect(restored.counts.users).toBe(3);
    // Left in place, sqlite would replay it over the restored pages.
    expect(fs.existsSync(`${target}-wal`)).toBe(false);
  });

  it('refuses to write over a database nobody asked it to replace', async () => {
    const live = await seed(db, 1);
    await live.destroy();
    const made = runJson<{ file: string }>(['--db', db, '--out', out]);

    expect(() => run(['--restore', made.file, '--to', db])).toThrow(/already exists.*--force/s);
    // the live file is untouched
    expect(fs.statSync(db).size).toBeGreaterThan(0);
  });

  it('prunes past the retention window but never leaves the laptop with nothing', async () => {
    const live = await seed(db, 1);
    await live.destroy();
    for (let i = 0; i < 4; i++) run(['--db', db, '--out', out]);
    const aged = archives(out);
    expect(aged).toHaveLength(4);
    // every one of them older than the window
    const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    for (const name of aged) fs.utimesSync(path.join(out, name), longAgo, longAgo);

    const made = runJson<{ pruned: string[] }>(['--db', db, '--out', out, '--keep-days', '14', '--keep-min', '3']);
    expect(made.pruned).toHaveLength(2);
    // the newest three, including the one just written
    expect(archives(out)).toHaveLength(3);
    // and each pruned archive took its manifest with it, so --list never
    // describes a backup nobody can restore.
    expect(fs.readdirSync(out).filter((name) => name.endsWith('.gz.json'))).toHaveLength(3);
  });

  it('says there is nothing there rather than pretending a restore is possible', () => {
    expect(run(['--out', out, '--list'])).toContain(`no backups in ${out}`);
  });

  /**
   * The restore half of runbook section 7a needs four guards: a way to look
   * before leaping, a check that the file fits the build, a refusal to
   * restore over a database the API still has open, and a listing that says
   * more than a name and a size.
   */
  describe('before it writes over a term of coursework', () => {
    /** A restore that reports rather than acts, as JSON. */
    interface DryRun {
      dryRun: boolean;
      written: boolean;
      head: string | null;
      schema: { known: boolean; behind: string[]; ahead: string[] };
      comparison: { table: string; now: number | null; backup: number }[];
    }

    it('says what a restore would do to this database, and writes nothing', async () => {
      const live = await seed(db, 4);
      await live.destroy();
      const made = runJson<{ file: string }>(['--db', db, '--out', out]);

      // The live database moves on after the backup, which is the whole reason
      // an operator wants the two columns side by side.
      const after = await seed(db, 0);
      await after.query(
        `INSERT INTO users ("id","email","passwordHash","displayName") VALUES ('late','late@class.edu','hash','Late')`,
      );
      await after.destroy();
      const before = fs.statSync(db);

      const report = runJson<DryRun>(['--restore', made.file, '--to', db, '--dry-run']);

      expect(report.dryRun).toBe(true);
      expect(report.written).toBe(false);
      expect(report.schema.behind).toEqual([]);
      expect(report.schema.ahead).toEqual([]);
      expect(report.head).toEqual(expect.any(String));
      const users = report.comparison.find((row) => row.table === 'users');
      expect(users).toEqual({ table: 'users', now: 5, backup: 4 });

      // Not "it reported success": the file itself is untouched, to the byte
      // and to the modification time.
      const untouched = fs.statSync(db);
      expect(untouched.size).toBe(before.size);
      expect(untouched.mtimeMs).toBe(before.mtimeMs);
    });

    it('names the migrations a backup is behind, and restores it anyway', async () => {
      const live = await seed(db, 2);
      // A backup taken two releases ago: the rows are there, the last two
      // migrations are not.
      const applied = await live.query(
        `SELECT timestamp FROM learnsdlc_migrations ORDER BY timestamp DESC LIMIT 2`,
      );
      const oldest = Math.min(...applied.map((row: { timestamp: number }) => Number(row.timestamp)));
      await live.query(`DELETE FROM learnsdlc_migrations WHERE timestamp >= ${oldest}`);
      await live.destroy();

      const made = runJson<{ file: string }>(['--db', db, '--out', out]);
      const target = path.join(dir, 'restored.sqlite');
      const report = runJson<DryRun>(['--restore', made.file, '--to', target]);

      expect(report.schema.behind).toHaveLength(2);
      // The file name an operator can go and read, not the class name the
      // migrations table stores.
      expect(report.schema.behind[0]).toMatch(/^\d{10,}-/);
      expect(report.written).toBe(true);
      expect(fs.existsSync(target)).toBe(true);

      const said = run(['--restore', made.file, '--to', target, '--force']);
      expect(said).toContain('migrations behind this build');
      expect(said).toContain('applied on the next boot with RUN_MIGRATIONS=true');
    });

    it('refuses a backup from a newer build unless it is told to accept it', async () => {
      const live = await seed(db, 1);
      // A file from a laptop that is one release ahead of this checkout.
      await live.query(
        `INSERT INTO learnsdlc_migrations ("timestamp","name") VALUES (9999999999999,'D99FromTheFuture9999999999999')`,
      );
      await live.destroy();

      const made = runJson<{ file: string }>(['--db', db, '--out', out]);
      const target = path.join(dir, 'restored.sqlite');

      expect(() => run(['--restore', made.file, '--to', target])).toThrow(
        /from a newer build.*9999999999999-D99FromTheFuture.*Nothing was written/s,
      );
      expect(fs.existsSync(target)).toBe(false);

      const forced = runJson<DryRun>(['--restore', made.file, '--to', target, '--force-schema']);
      expect(forced.written).toBe(true);
      expect(forced.schema.ahead).toEqual(['9999999999999-D99FromTheFuture']);
    });

    it('refuses to restore over a database something still has open', async () => {
      const live = await seed(db, 3);
      const made = runJson<{ file: string }>(['--db', db, '--out', out]);
      try {
        // The API, still running: runbook §7a says to stop it, and the script checks.
        expect(() => run(['--restore', made.file, '--to', db, '--force'])).toThrow(
          /is still being written to\. Stop the API and run this again\./,
        );
      } finally {
        await live.destroy();
      }
      // And once it is stopped, the same command works.
      const done = runJson<{ written: boolean }>(['--restore', made.file, '--to', db, '--force']);
      expect(done.written).toBe(true);
    });

    it('says what is in each backup rather than only its name and size', async () => {
      const live = await seed(db, 6);
      await live.destroy();
      const made = runJson<{ file: string }>(['--db', db, '--out', out]);

      // The manifest is what makes this a read of a few hundred bytes rather
      // than a gunzip of every archive in the directory.
      const manifest = JSON.parse(fs.readFileSync(`${made.file}.json`, 'utf8'));
      expect(manifest.summary).toEqual({ learners: 6, phases: 0 });
      expect(manifest.schemaHead).toEqual(expect.any(String));
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);

      const listing = run(['--out', out, '--list']);
      expect(listing).toContain('6 learners, 0 phases');
      expect(listing).toContain(`head ${manifest.schemaHead}`);

      // A backup taken before manifests existed still lists, by being opened.
      fs.rmSync(`${made.file}.json`);
      expect(run(['--out', out, '--list'])).toContain('6 learners, 0 phases');
    });
  });
});
