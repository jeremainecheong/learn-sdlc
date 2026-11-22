// The backup script's command line: the token after --restore is the backup
// only when it is not an option.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sqlite-backup.mjs');
const run = (...args) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-backup-args-'));
  try {
    return spawnSync(process.execPath, [SCRIPT, '--db', path.join(scratch, 'none.sqlite'), '--out', scratch, ...args], {
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

test('--restore --help prints the help instead of restoring a file named --help', () => {
  const result = run('--restore', '--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sqlite backup, restore and restore drill/);
});

test('--restore --dry-run with no file asks for the backup instead of taking --dry-run as one', () => {
  const result = run('--restore', '--dry-run');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Name the backup to restore/);
});

test('the backup may follow the options, and the flag may come twice', () => {
  const result = run('--restore', '--restore', '--dry-run', 'no-such-backup.sqlite.gz');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /no-such-backup\.sqlite\.gz/);
  assert.doesNotMatch(result.stderr + result.stdout, /unknown option/);
});
