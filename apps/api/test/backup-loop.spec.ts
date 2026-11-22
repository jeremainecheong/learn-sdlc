import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { load } from 'js-yaml';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The backup sidecar's loop, run for real.
 *
 * `docker-compose.yml` is the only place this script exists, so the test reads
 * it out of the compose file rather than keeping a copy that could drift: what
 * runs here is byte-for-byte what the container runs, with compose's `$$`
 * unescaped to the `$` the shell sees. `BACKUP_DIR` and `BACKUP_ONCE` are why
 * that is possible (the loop takes its directory from the environment and can
 * be asked for a single pass) and both are also how an operator proves a
 * deployment's backups work without waiting a day.
 *
 * What is being proved: the `find ... -delete` prune runs only inside the
 * success branch. Run at the bottom of every iteration instead, a dump that
 * failed every night would still age the good backups out one at a time, and
 * `BACKUP_KEEP_DAYS` consecutive failures would leave nothing to restore from.
 */

const COMPOSE = join(__dirname, '..', '..', '..', 'docker-compose.yml');

interface ComposeFile {
  services: { backup: { command: string[] } };
}

/** The loop as the container runs it. Compose turns `$$` into `$` before sh sees it. */
function backupScript(): string {
  const doc = load(readFileSync(COMPOSE, 'utf8')) as ComposeFile;
  const command = doc.services.backup.command;
  if (!Array.isArray(command) || command[0] !== 'sh' || command[1] !== '-c') {
    throw new Error('docker-compose.yml: the backup service no longer runs `sh -c <script>`');
  }
  return command[2].replace(/\$\$/g, '$');
}

/** A shell and the arguments that put it in `sh -c <script>` mode. */
interface Shell {
  cmd: string;
  args: string[];
}

/**
 * The image the sidecar runs is postgres:16-alpine, whose /bin/sh is busybox
 * ash and does support `set -o pipefail`, which the loop depends on, because
 * `pg_dump | gzip` exits 0 on a dump that died, and a dump that "succeeded" is
 * exactly what goes on to prune the backups. The host's /bin/sh need not: on
 * Ubuntu it is dash, where `set` is a special builtin, so the unknown option
 * kills the script on its first line and every case here would be testing an
 * empty run. Pick a shell with the container's capability instead of trusting
 * whatever /bin/sh happens to be, and say so plainly if this machine has none.
 */
function pipefailShell(): Shell {
  const candidates: Shell[] = [
    { cmd: 'sh', args: [] }, // ash or bash-as-sh: the container's own shape
    { cmd: 'busybox', args: ['sh'] }, // busybox ash: literally what the image runs
    { cmd: 'bash', args: [] }, // the fallback where /bin/sh is dash
  ];
  // Two things the loop needs from the shell it runs under: `set -o pipefail`,
  // and a `find` that knows `-delete`. The second matters because a busybox
  // shell runs its own applets, and Ubuntu's busybox is built without
  // `-delete` where Alpine's (the image's) has it, so `busybox sh` on a
  // GitHub runner would fail the prune with "find: unrecognized: -delete" and
  // prove nothing about the container.
  const probeScript =
    'set -o pipefail && d=$(mktemp -d) && : > "$d/probe" && ' +
    'find "$d" -name probe -delete && [ ! -e "$d/probe" ] && rmdir "$d"';
  for (const shell of candidates) {
    const probe = spawnSync(shell.cmd, [...shell.args, '-c', probeScript], { stdio: 'ignore' });
    if (probe.status === 0) return shell;
  }
  throw new Error(
    'no shell on this machine supports `set -o pipefail` with a `find -delete`, so the backup ' +
      'loop cannot be run the way postgres:16-alpine runs it; install bash',
  );
}

describe('the backup loop in docker-compose.yml', () => {
  let dir = '';
  let bin = '';
  let script = '';
  let shell: Shell = { cmd: 'sh', args: [] };

  /** A dump that was written `days` ago, with the name and the mtime to match. */
  const seedDump = (days: number): string => {
    const when = new Date(Date.now() - days * 86_400_000);
    const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const file = join(dir, `learnsdlc-${stamp}.sql.gz`);
    writeFileSync(file, `pretend dump from ${days} days ago`);
    execFileSync('touch', ['-t', touchStamp(when), file]);
    return file;
  };

  /** `touch -t` wants CCYYMMDDhhmm, in local time. */
  const touchStamp = (when: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
      `${pad(when.getHours())}${pad(when.getMinutes())}`
    );
  };

  /** A `pg_dump` on PATH, so the loop runs against it rather than a database. */
  const stubPgDump = (body: string): void => {
    const file = join(bin, 'pg_dump');
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };

  /** One pass of the loop, and everything it said on either stream. */
  const runOnce = (keepDays = 14): string => {
    const run = spawnSync(shell.cmd, [...shell.args, '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BACKUP_DIR: dir,
        BACKUP_KEEP_DAYS: String(keepDays),
        BACKUP_ONCE: '1',
      },
    });
    if (run.error) throw run.error;
    return `${run.stdout}${run.stderr}`;
  };

  const dumps = (): string[] =>
    execFileSync('sh', ['-c', `ls "${dir}" | grep '^learnsdlc-' || true`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();

  const metric = (name: string): number => {
    const line = readFileSync(join(dir, 'metrics.prom'), 'utf8')
      .split('\n')
      .find((row) => row.startsWith(`${name} `));
    if (!line) throw new Error(`metrics.prom has no ${name}`);
    return Number(line.split(' ')[1]);
  };

  beforeAll(() => {
    script = backupScript();
    shell = pipefailShell();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'learnsdlc-backups-'));
    bin = join(dir, 'bin');
    mkdirSync(bin);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every backup it has when the dump fails, however long the outage runs', () => {
    // The failure this guards against: a rotated password, so pg_dump exits non-zero every
    // night while the directory holds the last good backups.
    stubPgDump('echo "pg_dump: error: connection failed: password authentication failed" >&2\nexit 1');
    const old = [seedDump(40), seedDump(30), seedDump(20)];

    for (let night = 1; night <= 3; night++) {
      const said = runOnce();
      expect(said).toContain(`pg_dump FAILED (${night} in a row); pruned nothing`);
    }

    // All three are older than BACKUP_KEEP_DAYS and all three are still here:
    // the prune never runs on a night that wrote nothing. A prune that ran
    // unconditionally would take exactly these files.
    expect(dumps()).toEqual(old.map((file) => file.split('/').pop()).sort());
    expect(metric('learnsdlc_backup_consecutive_failures')).toBe(3);
    // Nothing was ever written, so there is no last success to report.
    expect(metric('learnsdlc_backup_last_success_seconds')).toBe(0);
  });

  it('prunes only what is past the window, and only on a night it wrote a dump', () => {
    stubPgDump('echo "-- a dump"');
    seedDump(40);
    seedDump(20);
    const inWindow = seedDump(10).split('/').pop();

    const said = runOnce();
    expect(said).toContain('backup: wrote ');

    const left = dumps();
    // The 40 and 20 day old dumps are past a 14 day window; the 10 day old one
    // and tonight's are not. When that is not what happened, say what the loop
    // said and what the directory looked like, because a prune that did not
    // prune is a question about this machine's find, touch and clock.
    if (left.length !== 2) {
      const listing = execFileSync('sh', ['-c', `ls -la --time-style=full-iso "${dir}" 2>/dev/null || ls -laT "${dir}"`], {
        encoding: 'utf8',
      });
      const tools = execFileSync('sh', ['-c', 'command -v find touch date; find --version 2>/dev/null | head -1; date -u; echo "TZ=${TZ:-unset}"'], {
        encoding: 'utf8',
      });
      throw new Error(
        `the prune left ${left.length} files, not 2\n--- the loop said ---\n${said}\n--- the directory ---\n${listing}\n--- the tools ---\n${tools}`,
      );
    }
    expect(left).toHaveLength(2);
    expect(left).toContain(inWindow);
    expect(metric('learnsdlc_backup_consecutive_failures')).toBe(0);
    expect(metric('learnsdlc_backup_last_success_seconds')).toBeGreaterThan(0);
  });

  it('clears the run of failures once a dump succeeds', () => {
    stubPgDump('exit 1');
    runOnce();
    runOnce();
    expect(metric('learnsdlc_backup_consecutive_failures')).toBe(2);

    stubPgDump('echo "-- a dump"');
    runOnce();
    expect(metric('learnsdlc_backup_consecutive_failures')).toBe(0);
  });

  it('carries the failure count and the last success across a restart', () => {
    stubPgDump('echo "-- a dump"');
    runOnce();
    const success = metric('learnsdlc_backup_last_success_seconds');
    expect(success).toBeGreaterThan(0);

    // Each runOnce is a fresh process, which is what a restarted container is:
    // the numbers come back out of metrics.prom rather than starting at zero
    // and telling the dashboard the backups have never worked.
    stubPgDump('exit 1');
    runOnce();
    expect(metric('learnsdlc_backup_consecutive_failures')).toBe(1);
    expect(metric('learnsdlc_backup_last_success_seconds')).toBe(success);
  });

  it('does not prune when the dump reports success but leaves nothing inside the window', () => {
    // The second guard, and the one that survives somebody moving the prune
    // back out of the success branch. pg_dump exits 0 and the file lands, but
    // the file that lands is older than the window: a clock that jumped, a
    // filesystem that lies about mtime, or a dump restored from somewhere
    // else. The directory, not the exit code, is what is asked.
    stubPgDump(
      [
        // gzip owns the `> "$f.part"` redirection and creates the file when
        // the pipeline starts, so wait for it rather than racing it.
        'n=0',
        'while :; do',
        '  set -- "$BACKUP_DIR"/*.part',
        '  [ -f "$1" ] && break',
        '  n=$((n + 1)); [ "$n" -ge 100 ] && break',
        '  sleep 0.05',
        'done',
        // Unlink and recreate: gzip keeps writing to the inode it opened, so
        // what `mv` renames afterwards is this empty, back-dated file.
        'for part in "$BACKUP_DIR"/*.part; do',
        '  rm -f "$part"; : > "$part"; touch -t 200001010000 "$part"',
        'done',
        'echo "-- a dump"',
      ].join('\n'),
    );
    const old = [seedDump(40), seedDump(30)];

    const said = runOnce();
    expect(said).toContain('no dump inside 14 days, so nothing was pruned');
    // Two seeded dumps plus the back-dated one the stub produced: nothing was
    // deleted, even though the dump said it had worked.
    expect(dumps()).toHaveLength(old.length + 1);
  });
});
