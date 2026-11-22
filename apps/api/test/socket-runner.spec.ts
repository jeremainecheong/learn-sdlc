import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stopOwnedChild } from './owned-child';

/**
 * Verifies the socket transport without Docker: runner/serve.py is started
 * as a plain process on a temporary UNIX socket and SandboxService is pointed
 * at it in RUNNER_MODE=socket: the same shape CI's socket-runner job uses
 * for the full journey. The container hardening around serve.py (no network,
 * read-only rootfs, uid 65534) is the `docker` CI job's business.
 */
describe('SandboxService: socket transport', () => {
  const runnerDir = path.resolve(__dirname, '..', 'runner');
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-runner-'));
  const socketPath = path.join(socketDir, 'runner.sock');

  let runner: ChildProcess;
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedEnv = { RUNNER_MODE: process.env.RUNNER_MODE, RUNNER_SOCKET: process.env.RUNNER_SOCKET };
    runner = spawn('python3', [path.join(runnerDir, 'serve.py')], {
      env: { ...process.env, RUNNER_SOCKET: socketPath },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    runner.stderr?.on('data', (chunk) => (stderr += chunk));

    // --check is the image's HEALTHCHECK; polling it here proves the same probe.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const probe = spawnSync('python3', [path.join(runnerDir, 'serve.py'), '--check'], {
        env: { ...process.env, RUNNER_SOCKET: socketPath },
      });
      if (probe.status === 0) break;
      if (Date.now() > deadline) throw new Error(`runner never became healthy: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    process.env.RUNNER_MODE = 'socket';
    process.env.RUNNER_SOCKET = socketPath;
    jest.resetModules();
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    await stopOwnedChild(runner);
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  function freshService() {
    // config reads env at import time, so re-require after env changes
    const { SandboxService } = require('../src/execution/sandbox.service');
    return new SandboxService();
  }

  it('runs a passing test job over the socket', async () => {
    const result = await freshService().execute({
      files: {
        'tasktrackr/__init__.py': '',
        'tasktrackr/mathy.py': 'def double(n):\n    return n * 2\n',
        'tests/test_mathy.py':
          'import unittest\nfrom tasktrackr.mathy import double\n\nclass T(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(double(4), 8)\n',
      },
      mode: 'tests',
      testPaths: ['tests/test_mathy.py'],
    });
    expect(result.ok).toBe(true);
    expect(result.exitKind).toBe('ok');
    expect(result.tests?.passed).toBe(1);
  });

  it('surfaces failures from inside the runner', async () => {
    const result = await freshService().execute({
      files: {
        'tests/test_bad.py':
          'import unittest\n\nclass T(unittest.TestCase):\n    def test_wrong(self):\n        self.assertEqual(1, 2)\n',
      },
      mode: 'tests',
      testPaths: ['tests/test_bad.py'],
    });
    expect(result.ok).toBe(false);
    expect(result.tests?.failed).toBe(1);
  });

  it('runs JavaScript through the same socket', async () => {
    const result = await freshService().execute({
      files: {
        'lib.js': "'use strict';\nmodule.exports = { double: (n) => n * 2 };\n",
        'tests/test_lib.js':
          "'use strict';\nconst { double } = require('../lib');\ntest('double', () => { assert.strictEqual(double(4), 8); });\n",
      },
      mode: 'tests',
      testPaths: ['tests/test_lib.js'],
      language: 'javascript',
    });
    expect(result.ok).toBe(true);
    expect(result.tests?.passed).toBe(1);
  });

  /**
   * A missing socket is an outage, not a verdict: reporting it as
   * `exitKind: 'error'` with the transport's message in stderr would make a
   * runner being down indistinguishable from a learner's failing program, and
   * put an internal socket path in front of the learner.
   */
  it('reports the runner as unavailable when the socket is missing, with no path in the result', async () => {
    const missing = path.join(socketDir, 'nobody-here.sock');
    process.env.RUNNER_SOCKET = missing;
    jest.resetModules();
    try {
      const result = await freshService().execute({
        files: { 'tests/test_x.py': 'import unittest\n' },
        mode: 'tests',
        testPaths: ['tests/test_x.py'],
      });
      expect(result.ok).toBe(false);
      expect(result.exitKind).toBe('unavailable');
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
      expect(result.tests).toBeUndefined();
      // Nothing the learner is shown may name the socket, its directory, or
      // the host's filesystem at all.
      const shown = JSON.stringify(result);
      expect(shown).not.toContain(missing);
      expect(shown).not.toContain(socketDir);
      expect(shown).not.toContain('.sock');
      expect(shown).not.toContain('/');
    } finally {
      process.env.RUNNER_SOCKET = socketPath;
      jest.resetModules();
    }
  });
});
