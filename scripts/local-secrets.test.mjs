// node --test scripts/local-secrets.test.mjs
// The secrets a local run generates for itself: setup.sh writes .env's
// JWT_SECRET, every script that starts the product locally makes sure one is
// there, and nothing replaces one once it is real. A secret that changed
// would sign everyone out and redraw every quiz paper in progress.
//
// setup.sh is run for real, in a scratch copy of the repository whose npm,
// Python and pre-bake step are stand-ins, so the test installs and builds
// nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The last JWT_SECRET assignment in a dotenv text, or undefined. */
function jwtSecretIn(text) {
  const lines = text.split('\n').filter((line) => /^\s*JWT_SECRET\s*=/.test(line));
  return lines.length ? lines[lines.length - 1].replace(/^\s*JWT_SECRET\s*=\s*/, '').trim() : undefined;
}

/** Lines with the comments taken out, so a rule is never satisfied by prose about it. */
const code = (source) => source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** A scratch repository: setup.sh and its library, .env.example, and stand-ins for what it installs. */
function scratchRepository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-secrets-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  for (const file of ['scripts/setup.sh', 'scripts/lib/common.sh', '.env.example']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, 'scripts', 'prebake.mjs'), 'process.exit(0);\n');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n[ "$1" = "-v" ] && echo 10.0.0\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'python3.11'),
    '#!/bin/sh\ncase "$*" in *print*) echo 3.11 ;; esac\nexit 0\n',
    { mode: 0o755 },
  );
  return dir;
}

function runSetup(dir) {
  const result = spawnSync('bash', [path.join(dir, 'scripts', 'setup.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${path.join(dir, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: os.homedir(),
    },
  });
  assert.equal(result.status, 0, `setup.sh exited ${result.status}: ${result.stderr}${result.stdout}`);
  return result.stdout + result.stderr;
}

/** Runs one of common.sh's functions in bash and returns its output. */
function common(snippet) {
  const result = spawnSync('bash', ['-c', `. "${path.join(ROOT, 'scripts/lib/common.sh')}"; ${snippet}`], {
    encoding: 'utf8',
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
  });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
}

test('setup.sh writes a generated JWT_SECRET into the .env it creates, and a second run keeps it', () => {
  const dir = scratchRepository();
  try {
    const first = runSetup(dir);
    const env = path.join(dir, '.env');
    const secret = jwtSecretIn(fs.readFileSync(env, 'utf8'));
    assert.match(secret ?? '', /^[0-9a-f]{96}$/, 'a 48-byte hex secret');
    assert.match(first, /\.env created from \.env\.example, with a JWT_SECRET generated for this machine/);
    assert.ok(!first.includes(secret), 'the secret is never printed');
    assert.equal(fs.statSync(env).mode & 0o777, 0o600);

    const second = runSetup(dir);
    assert.equal(jwtSecretIn(fs.readFileSync(env, 'utf8')), secret, 'a second run keeps the secret');
    assert.match(second, /\.env already exists \(left untouched\)/);
    assert.ok(!second.includes(secret));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup.sh fills the empty JWT_SECRET of an .env copied from .env.example, and leaves every other line alone', () => {
  const dir = scratchRepository();
  try {
    const env = path.join(dir, '.env');
    const copied = `${fs.readFileSync(path.join(dir, '.env.example'), 'utf8')}OPENAI_API_KEY=the-key\n`;
    fs.writeFileSync(env, copied);
    const out = runSetup(dir);
    const after = fs.readFileSync(env, 'utf8');
    const secret = jwtSecretIn(after);
    assert.match(secret ?? '', /^[0-9a-f]{96}$/);
    assert.match(out, /its JWT_SECRET was empty, so one was generated for this machine/);
    assert.equal(after.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET='), copied);
    runSetup(dir);
    assert.equal(jwtSecretIn(fs.readFileSync(env, 'utf8')), secret);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup.sh replaces a published JWT_SECRET and never a real one', () => {
  const dir = scratchRepository();
  try {
    const env = path.join(dir, '.env');
    fs.writeFileSync(env, 'JWT_SECRET=dev-secret-change-me-in-production\n');
    assert.match(runSetup(dir), /its JWT_SECRET was a published placeholder/);
    assert.match(jwtSecretIn(fs.readFileSync(env, 'utf8')) ?? '', /^[0-9a-f]{96}$/);

    const mine = 'a-secret-this-person-chose-and-wants-to-keep-0123456789';
    fs.writeFileSync(env, `JWT_SECRET=${mine}\n`);
    runSetup(dir);
    assert.equal(fs.readFileSync(env, 'utf8'), `JWT_SECRET=${mine}\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure_env_secret writes a missing key, keeps a real one, and never prints a value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-secrets-'));
  try {
    const file = path.join(dir, 'generated.env');
    const first = common(`ensure_env_secret "${file}" SOME_PASSWORD new_password`);
    assert.equal(first.out, 'written');
    const value = /^SOME_PASSWORD=(.+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
    assert.match(value, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(common(`ensure_env_secret "${file}" SOME_PASSWORD new_password`).out, 'kept');
    assert.equal(fs.readFileSync(file, 'utf8'), `SOME_PASSWORD=${value}\n`);

    fs.writeFileSync(file, 'A=1\nJWT_SECRET=   # set by setup\nB=2');
    assert.equal(common(`ensure_env_secret "${file}" JWT_SECRET`).out, 'written');
    assert.match(fs.readFileSync(file, 'utf8'), /^A=1\nJWT_SECRET=[0-9a-f]{96}\nB=2\n?$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every script that starts the product locally makes sure .env has a JWT_SECRET', () => {
  // npm run demo runs setup.sh when it needs to install or build, and makes
  // sure of the secret itself when it skips setup.sh.
  assert.match(code(read('scripts/setup.sh')), /ensure_env_secret \.env JWT_SECRET/);
  assert.match(code(read('scripts/demo.sh')), /ensure_env_secret \.env JWT_SECRET/);
  // bash scripts/start.sh on its own, unless JWT_SECRET is exported.
  assert.match(code(read('scripts/start.sh')), /ensure_env_secret \.env JWT_SECRET/);
  // npm run host keeps its own in data/host.env, and the Docker stack its
  // own in .env.verify, both from the same generator.
  assert.match(code(read('scripts/host.sh')), /JWT_SECRET="\$\(new_secret/);
  assert.match(code(read('scripts/stack.sh')), /GENERATED_JWT_SECRET="\$\(new_secret\)"/);
  for (const file of ['scripts/setup.sh', 'scripts/demo.sh', 'scripts/start.sh', 'scripts/host.sh', 'scripts/stack.sh']) {
    const generatesWithOpenssl = /="\$\(openssl rand/.test(code(read(file)));
    assert.equal(generatesWithOpenssl, false, `${file} generates secrets with new_secret, not openssl`);
  }
});

/** Runs the block of scripts/stack.sh that writes .env.verify on a first start, into `file`. */
function writeStackEnvFile(file) {
  const script = read('scripts/stack.sh');
  const start = script.indexOf('  GENERATED_JWT_SECRET=');
  const end = script.indexOf(`' "$ENV_FILE"`, start) + `' "$ENV_FILE"`.length;
  assert.ok(start > 0 && end > start, 'scripts/stack.sh writes .env.verify from one generator block');
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail; . "${path.join(ROOT, 'scripts/lib/common.sh')}"; ENV_FILE="${file}"; ${script.slice(start, end)}`],
    {
      encoding: 'utf8',
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, STACK_WEB_PORT: '3080', STACK_API_PORT: '4080', STACK_MAIL_PORT: '5085' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const at = line.indexOf('=');
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

test("the Docker stack generates its demo instructor's password into .env.verify beside its other secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-secrets-'));
  try {
    const first = writeStackEnvFile(path.join(dir, 'first.env'));
    const second = writeStackEnvFile(path.join(dir, 'second.env'));
    assert.equal(fs.statSync(path.join(dir, 'first.env')).mode & 0o777, 0o600);
    assert.match(first.JWT_SECRET, /^[0-9a-f]{96}$/);
    for (const name of ['STACK_INSTRUCTOR_PASSWORD', 'ADMIN_PASSWORD', 'POSTGRES_PASSWORD']) {
      assert.match(first[name], /^[A-Za-z0-9_-]{32}$/, `${name} is a generated password`);
      assert.notEqual(first[name], second[name], `${name} is generated on each machine, never a fixed value`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scripts sign in to the Docker stack as its instructor with the generated password, and print where it is, never the value', async () => {
  const accounts = await import('./lib/demo-accounts.mjs');
  const { demoInstructorAt } = await import('./author-common.mjs');
  const { STACK_API_URL } = await import('./lib/endpoints.mjs');
  assert.equal('STACK_INSTRUCTOR' in accounts, false, 'no fixed password for the stack instructor is exported');
  assert.throws(() => accounts.stackInstructor({}), /STACK_INSTRUCTOR_PASSWORD/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-secrets-'));
  try {
    const file = path.join(dir, '.env.verify');
    fs.writeFileSync(file, 'STACK_INSTRUCTOR_PASSWORD=generated-for-this-machine\n');
    assert.deepEqual(demoInstructorAt(STACK_API_URL, file), {
      email: accounts.DEMO_INSTRUCTOR_EMAIL,
      password: 'generated-for-this-machine',
    });
    // The native demo's instructor anywhere else.
    assert.deepEqual(demoInstructorAt('http://localhost:4000/api/v1', file), {
      email: accounts.DEMO_INSTRUCTOR.email,
      password: accounts.DEMO_INSTRUCTOR.password,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const seed = code(read('scripts/stack-seed.mjs'));
  assert.match(seed, /stackInstructor\(env\)/);
  assert.doesNotMatch(seed, /password \$\{account\.password\}/);
  assert.match(code(read('scripts/prove-local.mjs')), /stackInstructor\(env\)/);
  const stack = code(read('scripts/stack.sh'));
  assert.match(stack, /Instructor {3}\$DEMO_INSTRUCTOR_EMAIL, password STACK_INSTRUCTOR_PASSWORD in \$ENV_FILE/);
  assert.doesNotMatch(stack, /DEMO_INSTRUCTOR_DEFAULT_PASSWORD/);
  assert.match(stack, /ensure_env_secret "\$ENV_FILE" STACK_INSTRUCTOR_PASSWORD new_password/);
});

test('a SEED_PASSWORD the person chose is never printed or put on a command line', () => {
  const marker = 'a-chosen-password-marker-91';
  const shown = (env) =>
    spawnSync('bash', ['-c', '. "$1/scripts/lib/common.sh"; staff_password_shown "$DEMO_INSTRUCTOR_DEFAULT_PASSWORD"', '_', ROOT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
  const chosen = shown({ SEED_PASSWORD: marker });
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.equal(chosen.stdout, 'the SEED_PASSWORD set in your environment');
  assert.ok(!chosen.stdout.includes(marker));
  assert.equal(shown({}).stdout, 'Instructor123!');

  for (const file of ['scripts/setup.sh', 'scripts/demo.sh', 'scripts/demo-selftest.sh']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /\$\{SEED_PASSWORD:-\$DEMO_/, `${file} expands SEED_PASSWORD into printed text or a command line`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/demo-selftest.sh'), 'utf8'), /--data-binary @-/);
});
