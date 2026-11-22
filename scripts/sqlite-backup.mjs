#!/usr/bin/env node
/**
 * Backup, restore and restore drill for the sqlite store.
 *
 * A class hosted on one laptop keeps a term of work in a single file
 * (`DB_PATH`, data/learnsdlc.sqlite by default). docker-compose.yml's `backup`
 * service only knows how to pg_dump the Postgres container, so without this
 * that file has nothing snapshotting it, nothing pruning it and no rehearsed
 * restore. This is the sqlite half of runbook section 7.
 *
 * It uses sqlite's online backup API, so the API can keep serving while it
 * runs: the copy is a consistent snapshot taken page by page, not a file copy
 * that catches a half-written transaction.
 *
 *   node scripts/sqlite-backup.mjs                       one backup, verified, then prune
 *   node scripts/sqlite-backup.mjs --every 360           the same every six hours, in the foreground
 *   node scripts/sqlite-backup.mjs --drill               back up, restore to a scratch file, compare
 *   node scripts/sqlite-backup.mjs --restore <file.gz> --to data/learnsdlc.sqlite
 *   node scripts/sqlite-backup.mjs --restore <file.gz> --dry-run
 *   node scripts/sqlite-backup.mjs --list
 *
 * Every one of these has an npm name: backup, backup:list, backup:drill and
 * restore (`npm run restore -- <file.gz> [--dry-run]`). Runbook section 7a is
 * the operator's copy of all of it.
 *
 * A backup on the same disk is not a backup. Copy the backup directory off the
 * machine on a schedule; the runbook says how.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as zlib from 'node:zlib';
import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** better-sqlite3 is the API's dependency; npm hoists it to the workspace root. */
function loadDriver() {
  for (const from of [repoRoot, path.join(repoRoot, 'apps', 'api')]) {
    try {
      return createRequire(path.join(from, 'package.json'))('better-sqlite3');
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    'cannot load better-sqlite3. Run npm install at the repository root, or run this script from a checkout ' +
      'rather than a copy.',
  );
}

const PREFIX = 'learnsdlc-';
const SUFFIX = '.sqlite.gz';

function parseArgs(argv) {
  const args = {
    db: process.env.DB_PATH || path.join(repoRoot, 'data', 'learnsdlc.sqlite'),
    out: process.env.BACKUP_DIR || path.join(repoRoot, 'data', 'backups'),
    keepDays: Number(process.env.BACKUP_KEEP_DAYS || 14),
    keepMin: Number(process.env.BACKUP_KEEP_MIN || 3),
    every: 0,
    json: false,
    force: false,
    mode: 'backup',
    restore: '',
    to: '',
    dryRun: false,
    forceSchema: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--db') args.db = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--keep-days') args.keepDays = Number(next());
    else if (arg === '--keep-min') args.keepMin = Number(next());
    else if (arg === '--every') args.every = Number(next());
    else if (arg === '--json') args.json = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force-schema') args.forceSchema = true;
    else if (arg === '--drill') args.mode = 'drill';
    else if (arg === '--list') args.mode = 'list';
    else if (arg === '--restore') {
      // The backup to restore is the first token after this flag that is not
      // an option, so `--restore --dry-run <file>` and `--restore --help` mean
      // what they say. `npm run restore` already passes --restore, so
      // `npm run restore -- --restore <file>` arrives with the flag twice;
      // both spellings work.
      if (args.mode !== 'help') args.mode = 'restore';
    } else if (arg === '--to') args.to = next();
    else if (arg === '--help' || arg === '-h') args.mode = 'help';
    else if (args.mode === 'restore' && !args.restore && !arg.startsWith('-')) args.restore = arg;
    else throw new Error(`unknown option ${arg}. Run with --help.`);
  }
  if (args.mode === 'restore' && !args.restore) {
    throw new Error('Name the backup to restore: npm run restore -- data/backups/<file>.sqlite.gz (npm run backup:list lists them).');
  }
  // A restore with no --to is asking about the database this checkout runs on,
  // which is the only file a dry run could sensibly compare a backup against.
  if (args.mode === 'restore' && !args.to) args.to = args.db;
  args.db = path.resolve(args.db);
  args.out = path.resolve(args.out);
  if (args.to) args.to = path.resolve(args.to);
  if (args.restore) args.restore = path.resolve(args.restore);
  return args;
}

const HELP = `sqlite backup, restore and restore drill

  --db <file>          the database to read (default $DB_PATH, else data/learnsdlc.sqlite)
  --out <dir>          where backups are written (default $BACKUP_DIR, else data/backups)
  --keep-days <n>      delete backups older than n days (default $BACKUP_KEEP_DAYS, else 14)
  --keep-min <n>       never prune below this many backups (default 3)
  --every <minutes>    keep running, one backup per interval, until interrupted
  --drill              back up, restore into a scratch file, compare row counts, clean up
  --restore <file.gz>  restore a backup, with --to <file>
  --to <file>          where --restore writes. Stop the API first
  --force              let --restore overwrite an existing file
  --dry-run            with --restore: say what it would do, write nothing
  --force-schema       with --restore: accept a backup from a newer build
  --list               list the backups in --out, newest first
  --json               machine-readable output`;

/** Deletes a database file and the write-ahead log and shared-memory file beside it. */
function removeDatabase(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${file}${suffix}`, { force: true });
}

/** The migrations table TypeORM writes, named once so nothing guesses at it. */
const MIGRATIONS_TABLE = 'learnsdlc_migrations';

/**
 * The migrations this checkout carries, oldest first.
 *
 * The comparison is on the timestamp and nothing else, because the two sides
 * spell the same migration differently: the file is
 * `1788547231884-B9-AuditTombstones.ts` and the row TypeORM writes is
 * `B9AuditTombstones1788547231884`. Both carry the timestamp; only the file
 * carries the name an operator can go and read, which is why the file name is
 * what gets printed. `dist` is read as well as `src` so a built deployment,
 * which has no `src`, still knows what it is on.
 */
function buildMigrations() {
  const dirs = [
    path.join(repoRoot, 'apps', 'api', 'src', 'migrations'),
    path.join(repoRoot, 'apps', 'api', 'dist', 'migrations'),
  ];
  const found = new Map();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.d.ts') || name.endsWith('.map')) continue;
      const match = /^(\d{10,})-(.+)\.(?:ts|js)$/.exec(name);
      if (!match) continue;
      const timestamp = Number(match[1]);
      if (!found.has(timestamp)) found.set(timestamp, `${match[1]}-${match[2]}`);
    }
  }
  return [...found.entries()]
    .map(([timestamp, name]) => ({ timestamp, name }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** `B9AuditTombstones1788547231884` read back as `1788547231884-B9AuditTombstones`. */
function readableMigration(row) {
  const name = String(row.name || '');
  const stem = name.replace(/\d{10,}$/, '');
  return stem ? `${row.timestamp}-${stem}` : `${row.timestamp}`;
}

/** What a database says it has applied, or null when it has no migrations table at all. */
function appliedMigrations(db) {
  try {
    return db
      .prepare(`SELECT timestamp, name FROM "${MIGRATIONS_TABLE}" ORDER BY timestamp ASC`)
      .all()
      .map((row) => ({ timestamp: Number(row.timestamp), name: String(row.name) }));
  } catch {
    // A file written by an earlier release's schema sync has no such table.
    // That is a fact about the file, not an error, and `--force-schema` is how
    // an operator says they know.
    return null;
  }
}

/**
 * How a backup's schema stands against this build: the migrations the build has
 * and the file does not (harmless, they run at the next boot), and the ones the
 * file has and the build does not (not harmless at all: the API would read
 * columns its entities do not declare).
 */
function compareSchema(applied, build) {
  if (!applied) return { known: false, behind: [], ahead: [] };
  const has = new Set(applied.map((row) => row.timestamp));
  const knows = new Set(build.map((row) => row.timestamp));
  return {
    known: true,
    behind: build.filter((row) => !has.has(row.timestamp)).map((row) => row.name),
    ahead: applied.filter((row) => !knows.has(row.timestamp)).map(readableMigration),
  };
}

/**
 * Row counts per table, the sqlite integrity check, the schema the file is on
 * and the two numbers an operator recognises a term by.
 *
 * The schema read lives in here rather than beside it because every caller that
 * wants counts wants to know what schema they are counts of: a restore that
 * checks integrity and then hands back a database two migrations from this
 * build is a restore that boots and 500s on the first read.
 */
function inspect(driver, file) {
  const db = new driver(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => row.name);
    const counts = {};
    for (const table of tables) {
      counts[table] = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
    }
    const migrations = appliedMigrations(db);
    const head = migrations && migrations.length ? migrations[migrations.length - 1].name : null;
    // A count of learners rather than of rows in `users`: staff accounts are in
    // there too, and "28 learners" is what an operator recognises a term by.
    const learners = tables.includes('users')
      ? db.prepare(`SELECT count(*) AS n FROM users WHERE role = 'LEARNER'`).get().n
      : 0;
    return {
      integrity,
      counts,
      migrations,
      head,
      summary: { learners, phases: counts.phase_states ?? 0 },
    };
  } finally {
    db.close();
  }
}

/**
 * Whether something else has this database open.
 *
 * The production runbook (§7a) says "stop the API first"; this checks it, because
 * a restore into a file better-sqlite3 is holding is exactly how a good backup becomes a corrupt
 * database. In WAL mode every open connection holds a shared lock on the shared
 * -memory file for its whole life, so asking for an exclusive lock is a direct
 * question with a direct answer: SQLITE_BUSY means somebody is there.
 */
function inUse(driver, file) {
  if (!fs.existsSync(file)) return false;
  let db = null;
  try {
    db = new driver(file, { fileMustExist: true, timeout: 0 });
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('ROLLBACK');
    return false;
  } catch (error) {
    if (/SQLITE_BUSY|database is locked/i.test(String(error && error.message))) return true;
    // Anything else (a file that is not a database, no permission) is not
    // this question's business and is left to the caller that opens it next.
    return false;
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* the probe is closing either way */
    }
  }
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * A name no backup in this directory already has. The timestamp is to the
 * second because that is what an operator reads; two backups inside one second
 * (a drill, a manual run before an upgrade) must not overwrite each other.
 */
function freeName(dir, at = new Date()) {
  const base = `${PREFIX}${stamp(at)}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${SUFFIX}` : `${base}-${n}${SUFFIX}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
}

async function gzipFile(from, to) {
  await pipeline(createReadStream(from), createGzip({ level: 6 }), createWriteStream(to));
}

async function gunzipFile(from, to) {
  await pipeline(createReadStream(from), createGunzip(), createWriteStream(to));
}

/** The sidecar beside an archive: what was in it, without opening it. */
const manifestPath = (archive) => `${archive}.json`;

function readManifest(archive) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(archive), 'utf8'));
  } catch {
    // Optional on read: a backup taken before this manifest existed has none,
    // and every caller falls back to opening the archive, which is what they
    // all did before.
    return null;
  }
}

/** Every backup in the directory, newest first, with its manifest when it has one. */
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
    .map((name) => {
      const file = path.join(dir, name);
      const stats = fs.statSync(file);
      return {
        file,
        name,
        bytes: stats.size,
        modified: stats.mtime.toISOString(),
        manifest: readManifest(file),
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * What a backup holds, from its manifest when there is one and by opening it
 * when there is not. Reading an archive costs a gunzip and a scratch file, so
 * it happens once per archive that predates the manifest and never again.
 */
function describeBackup(driver, entry) {
  if (entry.manifest) return entry.manifest;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-read-'));
  const scratch = path.join(scratchDir, 'backup.sqlite');
  try {
    const gunzip = zlib.gunzipSync(fs.readFileSync(entry.file));
    fs.writeFileSync(scratch, gunzip);
    const read = inspect(driver, scratch);
    return {
      takenAt: entry.modified,
      schemaHead: read.head,
      tables: Object.keys(read.counts).length,
      rows: Object.values(read.counts).reduce((total, n) => total + n, 0),
      counts: read.counts,
      summary: read.summary,
      bytes: entry.bytes,
      sha256: null,
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * One verified backup. The copy is written beside its destination and renamed
 * only once sqlite has read it back intact, so a half-written file is never
 * mistaken for a backup, and an interrupted run leaves nothing behind that the
 * next restore could pick up.
 */
async function backup(driver, args) {
  if (!fs.existsSync(args.db)) throw new Error(`no database at ${args.db}`);
  fs.mkdirSync(args.out, { recursive: true });
  const finalPath = path.join(args.out, freeName(args.out));
  const rawPath = `${finalPath}.raw`;
  const partPath = `${finalPath}.part`;

  const source = new driver(args.db, { readonly: true, fileMustExist: true });
  try {
    await source.backup(rawPath);
  } finally {
    source.close();
  }

  let verified;
  try {
    // The copy inherits WAL mode from the source, which would leave its
    // contents split across a file the gzip does not include. Folding it back
    // to a rollback journal makes the archive one self-contained file.
    const copy = new driver(rawPath, { fileMustExist: true });
    try {
      copy.pragma('journal_mode = DELETE');
    } finally {
      copy.close();
    }
    verified = inspect(driver, rawPath);
    if (verified.integrity !== 'ok') {
      throw new Error(`the copy failed its integrity check: ${verified.integrity}`);
    }
    await gzipFile(rawPath, partPath);
    fs.renameSync(partPath, finalPath);
  } catch (error) {
    removeDatabase(rawPath);
    fs.rmSync(partPath, { force: true });
    throw error;
  }
  removeDatabase(rawPath);

  const rows = Object.values(verified.counts).reduce((total, n) => total + n, 0);
  const bytes = fs.statSync(finalPath).size;
  // Written after the archive is in place, and read back as optional: --list
  // and --restore both answer without it, they just have to open the archive to
  // do it. Its whole job is to make "what is in this file" a read of 400 bytes.
  const manifest = {
    takenAt: new Date().toISOString(),
    schemaHead: verified.head,
    tables: Object.keys(verified.counts).length,
    rows,
    counts: verified.counts,
    summary: verified.summary,
    bytes,
    sha256: createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex'),
  };
  fs.writeFileSync(manifestPath(finalPath), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    file: finalPath,
    bytes,
    tables: manifest.tables,
    rows,
    counts: verified.counts,
    head: verified.head,
    summary: verified.summary,
    pruned: prune(args),
  };
}

/**
 * Deletes backups past the retention window, never taking the directory below
 * keepMin files: a laptop that was shut for a month should still have its last
 * few backups when it comes back.
 */
function prune(args) {
  const backups = listBackups(args.out);
  const cutoff = Date.now() - args.keepDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const entry of backups.slice(args.keepMin)) {
    if (Date.parse(entry.modified) < cutoff) {
      fs.rmSync(entry.file, { force: true });
      // The manifest describes a file that is gone; leaving it behind would
      // make --list report a backup nobody can restore.
      fs.rmSync(manifestPath(entry.file), { force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

/**
 * Restores a backup over a database file, or says what restoring it would do.
 *
 * Four things happen before a single byte is written, and each of them is a way
 * a restore can go wrong:
 *
 * 1. **Is anything holding the target open.** The runbook (§7a) says "stop the
 *    API first", and this checks it. A restore into a file better-sqlite3 has
 *    open is how a good backup becomes a corrupt database.
 * 2. **Does the backup fit this build.** Integrity and row counts say the file
 *    is a database; they say nothing about whether its columns are the ones
 *    this build's entities declare. A backup from a newer build is refused, and
 *    one from an older build is allowed with its pending migrations named.
 * 3. **Was this asked for.** The --force check.
 * 4. **The stale write-ahead log beside the target goes with it.** sqlite would
 *    otherwise replay the old log over the restored pages.
 *
 * `dryRun` is an argument rather than a caller's promise not to write: the
 * function returns before the rename, so there is no path through it that can
 * write while it is set.
 */
async function restore(driver, args) {
  if (!args.restore) throw new Error('--restore needs the backup file to read');
  if (!args.to) throw new Error('--restore needs --to, the database file to write');
  if (!fs.existsSync(args.restore)) throw new Error(`no backup at ${args.restore}`);
  if (inUse(driver, args.to)) {
    throw new Error(`${args.to} is still being written to. Stop the API and run this again.`);
  }
  if (fs.existsSync(args.to) && !args.force && !args.dryRun) {
    throw new Error(
      `${args.to} already exists. Stop the API, move that file aside, and re-run, or pass --force to replace it.`,
    );
  }
  fs.mkdirSync(path.dirname(args.to), { recursive: true });
  const partPath = `${args.to}.restore-part`;
  try {
    await gunzipFile(args.restore, partPath);
    const verified = inspect(driver, partPath);
    if (verified.integrity !== 'ok') {
      throw new Error(`the backup failed its integrity check: ${verified.integrity}`);
    }

    const schema = compareSchema(verified.migrations, buildMigrations());
    if (schema.ahead.length && !args.forceSchema) {
      throw new Error(
        `this backup is from a newer build. It carries ${schema.ahead.length} migration` +
          `${schema.ahead.length === 1 ? '' : 's'} this build does not have:\n  ` +
          `${schema.ahead.join('\n  ')}\n` +
          'upgrade this checkout first, or pass --force-schema to restore anyway and accept that ' +
          'the API will read columns it does not declare. Nothing was written.',
      );
    }

    const live = fs.existsSync(args.to) ? inspect(driver, args.to) : null;
    const tables = [
      ...new Set([...Object.keys(verified.counts), ...Object.keys(live ? live.counts : {})]),
    ].sort();
    const comparison = tables.map((table) => ({
      table,
      now: live ? live.counts[table] ?? 0 : null,
      backup: verified.counts[table] ?? 0,
    }));
    const rows = Object.values(verified.counts).reduce((total, n) => total + n, 0);
    const report = {
      from: args.restore,
      to: args.to,
      tables: Object.keys(verified.counts).length,
      rows,
      counts: verified.counts,
      head: verified.head,
      summary: verified.summary,
      schema,
      comparison,
      dryRun: Boolean(args.dryRun),
      written: false,
    };

    if (args.dryRun) {
      // Before the rename, and the only return between the gunzip and it.
      removeDatabase(partPath);
      return report;
    }

    for (const sidecar of ['-wal', '-shm', '-journal']) fs.rmSync(`${partPath}${sidecar}`, { force: true });
    fs.renameSync(partPath, args.to);
    for (const sidecar of ['-wal', '-shm', '-journal']) fs.rmSync(`${args.to}${sidecar}`, { force: true });
    return { ...report, written: true };
  } catch (error) {
    removeDatabase(partPath);
    throw error;
  }
}

/**
 * The drill: take a backup, restore it into a scratch file next to nothing,
 * compare the restored row counts against the counts read out of the backup,
 * and delete the scratch file. Nothing touches the live database.
 *
 * The live counts are reported beside them so the operator can see the shape
 * of the term, but they are not what passes or fails: a live database written
 * to during the drill legitimately moves ahead of its own snapshot.
 */
async function drill(driver, args) {
  const made = await backup(driver, args);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-drill-'));
  const scratch = path.join(scratchDir, 'restored.sqlite');
  try {
    // Explicitly not a dry run, whatever the caller passed: a drill that wrote
    // nothing would prove nothing.
    const restored = await restore(driver, {
      ...args,
      restore: made.file,
      to: scratch,
      force: true,
      dryRun: false,
    });
    const live = inspect(driver, args.db).counts;
    const tables = [...new Set([...Object.keys(made.counts), ...Object.keys(restored.counts)])].sort();
    const rows = tables.map((table) => ({
      table,
      live: live[table] ?? 0,
      backup: made.counts[table] ?? 0,
      restored: restored.counts[table] ?? 0,
    }));
    const mismatched = rows.filter((row) => row.backup !== row.restored);
    return { backup: made.file, scratch, rows, mismatched, ok: mismatched.length === 0 };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log(HELP);
    return 0;
  }
  // A flag that only means anything to a restore, arriving without one, would
  // otherwise quietly take a backup.
  if (args.mode === 'backup' && (args.dryRun || args.forceSchema || args.to)) {
    throw new Error(
      '--dry-run, --force-schema and --to belong to a restore. Name the backup as well: ' +
        'npm run restore -- data/backups/<file>.sqlite.gz --dry-run',
    );
  }
  const driver = loadDriver();

  if (args.mode === 'list') {
    // A name and a size say nothing about whether a file is the one to reach
    // for. The schema it is on and the size of the class in it do.
    const backups = listBackups(args.out).map((entry) => ({
      ...entry,
      manifest: describeBackup(driver, entry),
    }));
    if (args.json) console.log(JSON.stringify({ dir: args.out, backups }, null, 2));
    else if (!backups.length) console.log(`no backups in ${args.out}`);
    else
      for (const entry of backups) {
        const held = entry.manifest;
        const head = held && held.schemaHead ? `   head ${held.schemaHead}` : '';
        const size =
          held && held.summary
            ? `   ${held.summary.learners} learners, ${held.summary.phases} phases`
            : '';
        console.log(
          `${entry.modified}  ${humanBytes(entry.bytes).padStart(9)}  ${entry.name}${head}${size}`,
        );
      }
    return 0;
  }

  if (args.mode === 'restore') {
    const done = await restore(driver, args);
    if (args.json) {
      console.log(JSON.stringify(done, null, 2));
      return 0;
    }
    if (done.schema.known && done.schema.behind.length) {
      const n = done.schema.behind.length;
      console.log(`restore: the backup is ${n} migration${n === 1 ? '' : 's'} behind this build:`);
      for (const name of done.schema.behind) console.log(`  ${name}`);
      console.log('restore: they will be applied on the next boot with RUN_MIGRATIONS=true. Continuing.');
    } else if (!done.schema.known) {
      console.log(
        'restore: the backup has no migrations table, so it was written by schema sync rather than ' +
          'by a migration. Nothing here can say whether it fits this build.',
      );
    } else if (done.dryRun) {
      console.log(
        `restore: the backup is intact and its schema matches this build (head ${done.head}).`,
      );
    }

    if (done.dryRun) {
      console.log(`restore: it would replace ${done.to}`);
      console.log('');
      console.log('table'.padEnd(22) + 'now'.padStart(9) + 'backup'.padStart(9));
      for (const row of done.comparison) {
        console.log(
          row.table.padEnd(22) +
            String(row.now === null ? '-' : row.now).padStart(9) +
            String(row.backup).padStart(9),
        );
      }
      console.log('');
      console.log('restore: nothing was written. Re-run without --dry-run to do it.');
      return 0;
    }
    console.log(`restored ${done.rows} rows across ${done.tables} tables into ${done.to}`);
    return 0;
  }

  if (args.mode === 'drill') {
    const report = await drill(driver, args);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`drill: restored ${path.basename(report.backup)} into a scratch file`);
      console.log('table'.padEnd(22) + 'live'.padStart(8) + 'backup'.padStart(9) + 'restored'.padStart(10));
      for (const row of report.rows) {
        console.log(
          row.table.padEnd(22) + String(row.live).padStart(8) + String(row.backup).padStart(9) + String(row.restored).padStart(10),
        );
      }
      console.log(
        report.ok
          ? 'drill passed: every table restored with the row count the backup holds'
          : `drill FAILED: ${report.mismatched.map((row) => row.table).join(', ')} did not restore intact`,
      );
    }
    return report.ok ? 0 : 1;
  }

  const runOnce = async () => {
    const made = await backup(driver, args);
    if (args.json) console.log(JSON.stringify(made));
    else {
      console.log(
        `backup: wrote ${made.file} (${humanBytes(made.bytes)}, ${made.rows} rows across ${made.tables} tables` +
          `${made.head ? `, head ${made.head}` : ''})`,
      );
      if (made.pruned.length) console.log(`backup: pruned ${made.pruned.length} older than ${args.keepDays} days`);
    }
  };

  await runOnce();
  if (args.every > 0) {
    console.log(`backup: next in ${args.every} minutes. A backup on the same disk is not a backup: copy ${args.out} off this machine.`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, args.every * 60 * 1000));
      try {
        await runOnce();
      } catch (error) {
        console.error(`backup: FAILED ${error.message}`);
      }
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`backup: ${error.message}`);
    process.exit(1);
  });
