import { spawnSync } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';

/**
 * Verifies the Lambda runner transport without Docker: a mock HTTP endpoint
 * implements the AWS Lambda Invoke API by delegating every payload to the
 * real runner/lambda_handler.py, and SandboxService is pointed at it in
 * RUNNER_MODE=lambda. The full LocalStack emulation of the same path runs in
 * CI (job: lambda-runner).
 */
describe('SandboxService: lambda transport', () => {
  const runnerDir = path.resolve(__dirname, '..', 'runner');
  const PY_SHIM =
    'import json,sys\nfrom lambda_handler import handler\nprint(json.dumps(handler(json.loads(sys.stdin.read()), None)))';

  let server: http.Server;
  let savedEnv: Record<string, string | undefined>;
  let savedEndpoint: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const py = spawnSync('python3', ['-c', PY_SHIM], {
          input: body,
          cwd: runnerDir,
          encoding: 'utf-8',
          timeout: 60_000,
          // Jest gives each test file its own copy of `process.env`; the
          // child would otherwise inherit the real one, and a NODE_BIN a test
          // sets here would never reach the runner.
          env: { ...process.env },
        });
        if (py.status !== 0) {
          res.writeHead(200, { 'X-Amz-Function-Error': 'Unhandled' });
          res.end(JSON.stringify({ errorMessage: (py.stderr || '').slice(0, 500) }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(py.stdout.trim());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    savedEnv = {
      RUNNER_MODE: process.env.RUNNER_MODE,
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      RUNNER_LAMBDA_FUNCTION: process.env.RUNNER_LAMBDA_FUNCTION,
    };
    process.env.RUNNER_MODE = 'lambda';
    process.env.AWS_ENDPOINT_URL = `http://127.0.0.1:${port}`;
    savedEndpoint = process.env.AWS_ENDPOINT_URL;
    process.env.RUNNER_LAMBDA_FUNCTION = 'learnsdlc-code-runner';
    jest.resetModules();
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function freshService() {
    // config reads env at import time, so re-require after env changes
    const { SandboxService } = require('../src/execution/sandbox.service');
    return new SandboxService();
  }

  it('runs a passing test job through the Lambda invoke path', async () => {
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

  it('surfaces failures from inside the Lambda sandbox', async () => {
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

  /** The same `unavailable` contract, over the Lambda transport. */
  it('reports the runner as unavailable when the function endpoint is unreachable', async () => {
    process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:1';
    jest.resetModules();
    const result = await freshService().execute({
      files: { 'tests/test_x.py': 'import unittest\n' },
      mode: 'tests',
      testPaths: ['tests/test_x.py'],
    });
    expect(result.ok).toBe(false);
    expect(result.exitKind).toBe('unavailable');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
    // The endpoint, the function name and the SDK's own wording stay in the log.
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  /**
   * The function image has no node, so a
   * TypeScript step comes back `unavailable` with the runner's own sentence
   * in stderr: a permanent limit of this transport, which the API must hand
   * on verbatim rather than reduce to "try again in a moment".
   */
  it('carries the runner’s own sentence for a TypeScript step the function cannot run', async () => {
    process.env.AWS_ENDPOINT_URL = savedEndpoint;
    const savedNode = process.env.NODE_BIN;
    // The shim inherits this process's environment: point the runner at no node.
    process.env.NODE_BIN = '/nonexistent/lambda-has-no/node';
    jest.resetModules();
    try {
      const result = await freshService().execute({
        files: { 'x.test.ts': "test('ok', () => { assert.ok(true); });" },
        mode: 'tests',
        testPaths: ['x.test.ts'],
        language: 'typescript',
        harness: 'js',
        transform: { tool: 'esbuild', jsx: 'automatic' },
      });
      expect(result.ok).toBe(false);
      expect(result.exitKind).toBe('unavailable');
      // The runner writes `tests: null` for a job it never ran.
      expect(result.tests ?? undefined).toBeUndefined();
      expect(result.stderr).toContain('this transport cannot run JavaScript');
      expect(result.stderr).not.toContain('/nonexistent');
    } finally {
      if (savedNode === undefined) delete process.env.NODE_BIN;
      else process.env.NODE_BIN = savedNode;
    }
  });
});
