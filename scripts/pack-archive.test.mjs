// node --test scripts/pack-archive.test.mjs
// The archive scripts/prove-local.mjs uploads, read back by an independent
// zip reader (Python's zipfile), and the dotenv reader scripts/stack-seed.mjs
// takes the stack's administrator from.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packFiles, zipPackDirectory } from './pack-archive.mjs';
import { readEnvFile } from './stack-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELF = path.join(ROOT, 'apps/api/test/fixtures/upload-packs/shelf');

test('the Shelf pack zips to an archive another reader accepts, byte for byte', () => {
  const files = packFiles(SHELF);
  assert.ok(files.some((f) => f.name === 'project.json'), 'project.json at the archive root');
  assert.deepEqual(files.map((f) => f.name), [...files.map((f) => f.name)].sort());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-pack-'));
  try {
    const archive = path.join(dir, 'shelf.zip');
    fs.writeFileSync(archive, zipPackDirectory(SHELF));
    const read = spawnSync('python3', ['-I', '-c', [
      'import json, sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'print(json.dumps({n: z.read(n).hex() for n in z.namelist()}))',
    ].join('\n'), archive], { encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    const back = JSON.parse(read.stdout);
    assert.deepEqual(Object.keys(back).sort(), files.map((f) => f.name));
    for (const f of files) assert.equal(back[f.name], f.data.toString('hex'), f.name);
    assert.deepEqual(zipPackDirectory(SHELF), zipPackDirectory(SHELF), 'the same directory is the same bytes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readEnvFile reads KEY=value lines and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-env-'));
  try {
    const file = path.join(dir, '.env.verify');
    fs.writeFileSync(file, 'ADMIN_EMAIL=a@b.local\n# a comment\nADMIN_PASSWORD="x y"\nnot a line\n');
    assert.deepEqual(readEnvFile(file), { ADMIN_EMAIL: 'a@b.local', ADMIN_PASSWORD: 'x y' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
