// node --test scripts/local-run.test.mjs
// What the Compose files, the CI workflow and the local-run scripts promise
// each other, read from the files themselves: no Docker is started.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * The variables a Compose file refuses to start without: every `${NAME:?...}`
 * or `${NAME?...}`. `$${...}` is Compose's escape for a literal `${` inside a
 * command, so it is skipped.
 */
function requiredVariables(text) {
  return new Set([...text.matchAll(/(?<!\$)\$\{([A-Z_][A-Z0-9_]*):?\?/g)].map((m) => m[1]));
}

/** The names the local stack writes into .env.verify on its first start (scripts/stack.sh). */
function envVerifyNames() {
  const script = read('scripts/stack.sh');
  const block = script.slice(script.indexOf('const settings = {'), script.indexOf('};', script.indexOf('const settings = {')));
  assert.ok(block.length > 0, 'scripts/stack.sh still writes .env.verify from a settings object');
  return new Set([...block.matchAll(/\b([A-Z][A-Z0-9_]+):/g)].map((m) => m[1]));
}

/** The env block of the CI step with this name. */
function ciStepEnv(name) {
  const lines = read('.github/workflows/ci.yml').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `ci.yml has the step "${name}"`);
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^\s+(run|uses):/.test(line) || /^\s+- /.test(line)) break;
    const match = /^\s+([A-Z][A-Z0-9_]*):/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

test('docker-compose.yml takes the database password only from the environment, never from a published default', () => {
  const compose = read('docker-compose.yml');
  const uses = [...compose.matchAll(/\$\{POSTGRES_PASSWORD([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(uses.length >= 3, 'the postgres, api and backup services all read POSTGRES_PASSWORD');
  for (const use of uses) assert.match(use, /^:\?/, `\${POSTGRES_PASSWORD${use}} must refuse to start when it is unset`);
  assert.doesNotMatch(compose, /learnsdlc-dev/);
});

test('every variable docker-compose.yml requires is one the local stack writes into .env.verify', () => {
  const written = envVerifyNames();
  for (const name of requiredVariables(read('docker-compose.yml'))) {
    assert.ok(written.has(name), `scripts/stack.sh writes ${name} into .env.verify`);
  }
});

test('the CI job that resolves docker-compose.yml sets every variable the file requires', () => {
  const env = ciStepEnv('Compose file resolves with the production variables');
  for (const name of requiredVariables(read('docker-compose.yml'))) {
    assert.ok(env.has(name), `ci.yml's docker job sets ${name} before docker compose config`);
  }
});

/** The Compose project scripts/stack.sh uses, given this environment. */
function stackProject(env) {
  const line = read('scripts/stack.sh').split('\n').find((l) => l.startsWith('PROJECT='));
  assert.ok(line, 'scripts/stack.sh sets PROJECT on a line of its own');
  const result = spawnSync('bash', ['-c', `${line}\nprintf %s "$PROJECT"`], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('the local stack is the Compose project learnsdlc unless LEARNSDLC_STACK_PROJECT names another', () => {
  const { LEARNSDLC_STACK_PROJECT: _ignored, ...env } = process.env;
  assert.equal(stackProject(env), 'learnsdlc');
  assert.equal(stackProject({ ...env, LEARNSDLC_STACK_PROJECT: 'second-checkout' }), 'second-checkout');
});

test("stack.sh's help says where a stack started under the earlier project name keeps its data", () => {
  const help = spawnSync('bash', [path.join(ROOT, 'scripts/stack.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /LEARNSDLC_STACK_PROJECT/);
  assert.match(help.stdout, /learnsdlc-redesign/);
});

test('npm run demo opens the database it finds and never backs it up and deletes it on start', () => {
  const demo = read('scripts/demo.sh');
  assert.doesNotMatch(demo, /rm -f "\$DB_PATH"/);
  assert.doesNotMatch(demo, /pack-2\.0\.0-reset/);
  assert.equal(demo.split('\n').filter((line) => line.trim() === 'mkdir -p "$ROOT/data"').length, 1);
});

/** `image:` values in a YAML file, by repository name (the part before the tag). */
function imagesIn(file) {
  return [...read(file).matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)].map((m) => m[1]);
}
const repositoryOf = (image) => image.split('@')[0].split(':')[0];

test('the Compose files and CI run the postgres, redis and caddy images the reference deployment pins by digest', () => {
  const pinned = new Map(imagesIn('infra/preview/compose.yaml').filter((i) => i.includes('@sha256:')).map((i) => [repositoryOf(i), i]));
  assert.deepEqual([...pinned.keys()].sort(), ['caddy', 'postgres', 'redis']);
  for (const file of ['docker-compose.yml', 'docker-compose.localstack.yml', '.github/workflows/ci.yml']) {
    for (const image of imagesIn(file)) {
      const pin = pinned.get(repositoryOf(image));
      if (pin) assert.equal(image, pin, `${file} runs ${repositoryOf(image)} at the reference deployment's digest`);
    }
  }
});

test('bash scripts/start.sh migrates the store and names its runner socket after the API port', () => {
  const start = read('scripts/start.sh');
  assert.match(start, /^export RUN_MIGRATIONS="\$\{RUN_MIGRATIONS:-true\}"$/m);
  assert.match(start, /runner-\$API_PORT\.sock/);
  assert.match(start, /^export WEB_ORIGIN="\$\{WEB_ORIGIN:-http:\/\/localhost:\$WEB_PORT\}"$/m);
  assert.match(start, /^export NEXT_PUBLIC_API_URL="\$\{NEXT_PUBLIC_API_URL:-http:\/\/localhost:\$API_PORT\}"$/m);
});

test('a Node script run by hand finds the stack on the ports .env.verify keeps when its environment names none', async () => {
  const { stackPort } = await import('./lib/endpoints.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-ports-'));
  try {
    const file = path.join(scratch, '.env.verify');
    fs.writeFileSync(file, 'STACK_API_PORT=4180\nSTACK_WEB_PORT="3180"\n');
    assert.equal(stackPort('STACK_API_PORT', '4080', {}, file), '4180');
    assert.equal(stackPort('STACK_WEB_PORT', '3080', {}, file), '3180');
    assert.equal(stackPort('STACK_API_PORT', '4080', { STACK_API_PORT: '4280' }, file), '4280');
    assert.equal(stackPort('STACK_API_PORT', '4080', {}, path.join(scratch, 'absent')), '4080');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('each build that compiles with tsc empties its output folder first, so a compiled file whose source is gone cannot run', () => {
  // tsc never removes an output whose source was deleted or renamed, and the API
  // runs every migration it finds in its compiled folder.
  for (const workspace of ['apps/api', 'packages/shared']) {
    const steps = JSON.parse(read(`${workspace}/package.json`)).scripts.build.split('&&').map((step) => step.trim());
    assert.match(steps.at(-1), /^tsc -p /, `${workspace} compiles with tsc as the last step of its build`);
    assert.ok(steps.length > 1, `${workspace} runs a step before tsc`);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'build-output-'));
    try {
      const stale = path.join(scratch, 'dist', 'migrations', '1-Stale.js');
      fs.mkdirSync(path.dirname(stale), { recursive: true });
      fs.writeFileSync(stale, '');
      const ran = spawnSync(steps.slice(0, -1).join(' && '), {
        cwd: scratch,
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
      });
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(fs.existsSync(stale), false, `${workspace}'s build removes what an earlier build left in dist`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});
