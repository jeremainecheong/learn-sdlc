import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dependencyEnvironment } from './prebake.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-prebake-node-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const runtime = { node: { version: '22' } };
function tool(name, version = 'v22.23.2', exit = 0) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const binary = path.join(directory, 'node');
  // Controlled version-probe doubles only; no learner or dependency execution.
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${exit}\n`, { mode: 0o755 });
  return binary;
}
const valid = tool('learner tools');
test('selects learner Node only for the Node dependency installation', () => {
  const env = { NODE_BIN: valid, PATH: '/application/bin:/usr/bin', APP_MARKER: 'preserved' };
  const saved = { ...env };
  const child = dependencyEnvironment('install-node', runtime, env);
  assert.equal(child.PATH, `${path.dirname(valid)}:/application/bin:/usr/bin`);
  assert.equal(child.APP_MARKER, 'preserved');
  assert.deepEqual(env, saved);
  for (const action of ['install-python', 'install-esbuild', 'prepare', 'locks', 'verify-node', 'verify-python']) {
    assert.deepEqual(dependencyEnvironment(action, runtime, env), saved);
  }
});
test('resolves a symlink to the actual Node distribution directory', () => {
  const alias = path.join(root, 'selected-node');
  fs.symlinkSync(valid, alias);
  assert.equal(dependencyEnvironment('install-node', runtime, { NODE_BIN: alias }).PATH, path.dirname(valid));
});
test('preserves the existing implicit PATH when no learner binary was selected', () => {
  const env = { PATH: '/original/bin' };
  assert.deepEqual(dependencyEnvironment('install-node', runtime, env), env);
});
for (const [name, binary] of [
  ['empty selection', ''], ['relative selection', 'node'], ['missing binary', path.join(root, 'missing')],
  ['directory selection', root], ['wrong Node major', tool('application', 'v24.21.0')],
  ['failed version probe', tool('failed', 'v22.23.2', 1)],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => dependencyEnvironment('install-node', runtime, { NODE_BIN: binary }), /NODE_BIN must name an executable Node.js 22 binary/);
  });
}
test('rejects a non-executable binary', () => {
  const binary = tool('not executable');
  fs.chmodSync(binary, 0o644);
  assert.throws(() => dependencyEnvironment('install-node', runtime, { NODE_BIN: binary }), /NODE_BIN/);
});
test('does not inherit Node preload flags into the bounded version probe', () => {
  const result = dependencyEnvironment('install-node', { node: { version: process.versions.node.split('.')[0] } }, {
    NODE_BIN: process.execPath, NODE_OPTIONS: '--invalid-node-option-for-prebake-test', NODE_PATH: '/unrelated',
  });
  assert.equal(result.PATH, path.dirname(fs.realpathSync(process.execPath)));
});
test('an invalid explicit learner binary fails a real CLI build before runtime writes', () => {
  const target = path.join(root, 'must-not-be-created');
  const command = fileURLToPath(new URL('./prebake.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, 'build'], { encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, HOME: root, NODE_BIN: path.join(root, 'missing-node'), RUNNER_RUNTIME_DIR: target } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NODE_BIN must name an executable Node.js 22 binary/);
  assert.equal(fs.existsSync(target), false);
});
test('manifest writes the record the runner image checks, and installs nothing', () => {
  const target = path.join(root, 'manifest-only');
  const command = fileURLToPath(new URL('./prebake.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, HOME: root, RUNNER_RUNTIME_DIR: target };
  const written = spawnSync(process.execPath, [command, 'manifest'], { encoding: 'utf8', timeout: 30000, env });
  assert.equal(written.status, 0, written.stderr);
  const printed = spawnSync(process.execPath, [command, 'print'], { encoding: 'utf8', timeout: 30000, env });
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  assert.equal(manifest.digest, printed.stdout.trim());
  assert.ok(manifest.dependencyLocks && Object.keys(manifest.dependencyLocks).length > 0);
  assert.deepEqual(fs.readdirSync(target), ['manifest.json']);
  const again = spawnSync(process.execPath, [command, 'manifest'], { encoding: 'utf8', timeout: 30000, env });
  assert.match(again.stdout, /already records the packs/);
});
