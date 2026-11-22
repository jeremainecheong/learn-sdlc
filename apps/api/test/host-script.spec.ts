import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as ts from 'typescript';
import { adminPasswordRefusal, passwordRuleProblem } from '../src/auth/password-rules';

/**
 * `npm run host` refusing what it must refuse.
 *
 * The script is the other side of the door `assertBindSafety` guards: it binds
 * 0.0.0.0, so a demo account, a local runner or a placeholder secret would each
 * hand the room something it should not have. The API refuses all three at
 * boot; the script refuses them before anything is built, written or started,
 * which is the difference between a sentence you read now and a stack trace
 * you read three minutes into a lab.
 *
 * HOST_DRY_RUN stops the script after the lab card, so nothing here builds a
 * bundle, opens a port or starts a runner. HOST_DATA_DIR keeps the generated
 * signing secret out of the repository being tested.
 */
describe('scripts/host.sh', () => {
  const script = resolve(__dirname, '../../../scripts/host.sh');
  let dataDir = '';

  /** A clean environment: nothing inherited from the jest harness. */
  const run = (env: Record<string, string>, input?: string) =>
    spawnSync('bash', [script], {
      encoding: 'utf8',
      input,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        HOST_DRY_RUN: '1',
        HOST_DATA_DIR: dataDir,
        // No build unless a case makes one, so the result does not depend on
        // whether this checkout has built the API.
        HOST_API_DIST: join(dataDir, 'no-build'),
        LAB_HOST: '192.168.1.24',
        ...env,
      },
    });

  /**
   * The two modules host.sh asks from the API's build, compiled from source
   * into a scratch folder that stands in for apps/api/dist. NODE_PATH lets
   * them find the shared package from there.
   */
  const scratchBuild = (): Record<string, string> => {
    const dist = join(dataDir, 'dist');
    mkdirSync(join(dist, 'auth'), { recursive: true });
    for (const name of ['password-rules', 'common-passwords']) {
      const source = readFileSync(resolve(__dirname, `../src/auth/${name}.ts`), 'utf8');
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      });
      writeFileSync(join(dist, 'auth', `${name}.js`), outputText);
    }
    return { HOST_API_DIST: dist, NODE_PATH: resolve(__dirname, '../../../node_modules') };
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-script-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses to host a class with the demo accounts', () => {
    const { status, stdout } = run({ SEED_DEMO_ACCOUNTS: 'true', JWT_SECRET: 'x'.repeat(48) });
    expect(status).toBe(1);
    expect(stdout).toContain('SEED_DEMO_ACCOUNTS');
    expect(stdout).toContain('admin@learnsdlc.test');
  });

  it('refuses to host a class on a placeholder signing secret', () => {
    const { status, stdout } = run({ JWT_SECRET: 'changeme' });
    expect(status).toBe(1);
    expect(stdout).toContain('JWT_SECRET');
    expect(stdout).toContain('placeholders');
  });

  it('refuses to host a class with the local runner', () => {
    const { status, stdout } = run({ RUNNER_MODE: 'local', JWT_SECRET: 'x'.repeat(48) });
    expect(status).toBe(1);
    expect(stdout).toContain('RUNNER_MODE');
    expect(stdout).toContain('shell on this machine');
  });

  /**
   * The machine running this suite is on a network, so the branch is reached
   * by putting silent stand-ins for the address tools first on PATH: what a
   * laptop that has not joined the room's wifi actually answers.
   */
  it('refuses to host a class this machine has no address for', () => {
    const bin = join(dataDir, 'bin');
    mkdirSync(bin);
    for (const tool of ['route', 'ipconfig', 'hostname']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const { status, stdout } = run({
      JWT_SECRET: 'x'.repeat(48),
      LAB_HOST: '',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });
    expect(status).toBe(1);
    expect(stdout).toContain('This machine has no network address');
    expect(stdout).toContain("Join the room's wifi");
  });

  it('prints the lab card, the learner address and the class-code sentence', () => {
    const { status, stdout } = run({ JWT_SECRET: 'x'.repeat(48) });
    expect(status).toBe(0);
    expect(stdout).toContain('Lab is up.');
    expect(stdout).toContain('Learners open    http://192.168.1.24:3000');
    expect(stdout).toContain('http://192.168.1.24:3000/instructor');
    expect(stdout).toContain('Your class code is on the console under Your classes.');
    expect(stdout).toContain("Plain HTTP on the room's network.");
  });

  it('refuses an administrator password the API would refuse, in its words, before building anything', () => {
    const { status, stdout } = run({ JWT_SECRET: 'x'.repeat(48), ADMIN_PASSWORD: 'short' });
    expect(status).toBe(1);
    expect(stdout).toContain(`${adminPasswordRefusal('it must be 8 to 100 characters')}.`);
    expect(stdout).toContain('Nothing was built or started.');
    expect(stdout).not.toContain('Lab is up.');
  });

  it('checks the password it prompts for, against the breach list too when the API is built', () => {
    const { status, stdout } = run(
      { ...scratchBuild(), HOST_DRY_RUN: '0', JWT_SECRET: 'x'.repeat(48), ADMIN_EMAIL: 'host@learnsdlc.test' },
      'password123\n',
    );
    expect(status).toBe(1);
    expect(stdout).toContain(`${adminPasswordRefusal(passwordRuleProblem('password123') as string)}.`);
    expect(stdout).toContain('appears in public breach lists');
    expect(stdout).toContain('Nothing was built or started.');
  });

  it('goes on with an administrator password the API accepts', () => {
    const { status, stdout } = run({
      ...scratchBuild(),
      JWT_SECRET: 'x'.repeat(48),
      ADMIN_PASSWORD: 'A-long-and-uncommon-one-7',
    });
    expect(status).toBe(0);
    expect(stdout).toContain('Lab is up.');
  });

  /** A generated secret is a credential, so it is written like one. */
  it('generates a signing secret once and keeps it 0600', () => {
    const first = run({});
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Treat that file as a password.');

    const envFile = join(dataDir, 'host.env');
    expect(existsSync(envFile)).toBe(true);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    // The second run reads it back rather than signing everybody out again.
    const second = run({});
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain('Treat that file as a password.');
  });

  /**
   * The checks of the machine itself, which run after the lab card and before
   * anything is built. Stand-ins on PATH answer for Python and Node, so each
   * case reaches exactly one refusal and stops there.
   */
  describe('refuses, before building anything, a machine that cannot host a class', () => {
    /**
     * A folder of stand-ins that comes first on PATH: every Python name
     * find_python tries answers the version probe with `pythonStatus`, and
     * runner-status.py prints `isolation`.
     */
    const machine = (pythonStatus: 0 | 1, isolation = 'ok'): Record<string, string> => {
      const bin = join(dataDir, 'machine-bin');
      mkdirSync(bin, { recursive: true });
      const python = [
        '#!/bin/sh',
        'case "$*" in',
        `  *runner-status.py*) echo "${isolation}"; exit 0 ;;`,
        'esac',
        `exit ${pythonStatus}`,
        '',
      ].join('\n');
      for (const name of ['python3.11', 'python3', 'python3.12', 'python3.13']) {
        writeFileSync(join(bin, name), python, { mode: 0o755 });
      }
      writeFileSync(join(bin, 'node22-stand-in'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'not-node22'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      return {
        ...scratchBuild(),
        HOST_DRY_RUN: '0',
        JWT_SECRET: 'x'.repeat(48),
        ADMIN_EMAIL: 'host@learnsdlc.test',
        ADMIN_PASSWORD: 'A-long-and-uncommon-one-7',
        OPENAI_API_KEY: 'a-key-for-the-presence-check',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        NODE_BIN: join(bin, 'node22-stand-in'),
      };
    };

    it('refuses without Python 3.11, which the sandbox and its pre-baked layer are built for', () => {
      const { status, stdout } = run(machine(1));
      expect(status).toBe(1);
      expect(stdout).toContain('Python 3.11 was not found');
      expect(stdout).not.toContain('Lab is up.');
    });

    it('refuses without a Node 22 for learner JavaScript', () => {
      const env = machine(0);
      const { status, stdout } = run({ ...env, NODE_BIN: join(dataDir, 'machine-bin', 'not-node22') });
      expect(status).toBe(1);
      expect(stdout).toContain('Learner code runs on Node 22, and none was found.');
      expect(stdout).not.toContain('Lab is up.');
    });

    it('refuses a machine whose kernel cannot isolate learner code, and names Landlock', () => {
      const { status, stdout } = run(machine(0, 'unsupported test reason'));
      expect(status).toBe(1);
      expect(stdout).toContain('This machine cannot isolate learner code (the runner says: test reason)');
      expect(stdout).toContain('Landlock');
      expect(stdout).not.toContain('Rebuilding the web app');
      expect(stdout).not.toContain('Lab is up.');
    });

    /**
     * The key check reads the checkout's own .env, so it is proven on the
     * helper with an empty folder standing in for the repository root, and
     * host.sh is held to calling it before the machine checks.
     */
    it('refuses without an AI key, before the machine checks', () => {
      const root = join(dataDir, 'no-env-root');
      mkdirSync(root, { recursive: true });
      const helper = resolve(__dirname, '../../../scripts/ai-key.sh');
      const result = spawnSync('bash', ['-c', 'source "$1"; require_ai_key "$2"; echo reached', '_', helper, root], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('LearnSDLC needs an AI key to start, and none was found.');
      expect(result.stdout).not.toContain('reached');

      const source = readFileSync(script, 'utf8');
      const keyCheck = source.indexOf('require_ai_key "$ROOT"');
      expect(keyCheck).toBeGreaterThan(source.indexOf('if [ "$DRY_RUN" = 1 ]'));
      expect(keyCheck).toBeLessThan(source.indexOf('find_python exact'));
    });
  });
});
