import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { RunResult } from '@learnsdlc/shared';
import type { SandboxService as SandboxServiceType } from './sandbox.service';

/**
 * The sandbox's job is to return a verdict about the learner's code, or to say
 * plainly that it could not get one. The two must never be the same thing: a
 * transport failure reported as `exitKind: 'error'` with the socket path in
 * stderr would be scored by the feedback pipeline as the learner failing the
 * rubric, and the learner would read the API's internals.
 *
 * The transports themselves have their own end-to-end suites
 * (test/socket-runner.spec.ts, test/lambda-runner.spec.ts). What is pinned
 * here is the contract every one of them funnels into.
 */
describe('SandboxService.execute: the unavailable outcome', () => {
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-sandbox-'));
  const savedEnv: Record<string, string | undefined> = {
    RUNNER_MODE: process.env.RUNNER_MODE,
    RUNNER_SOCKET: process.env.RUNNER_SOCKET,
    PYTHON_BIN: process.env.PYTHON_BIN,
  };

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  /** config reads env at import time, so the service is required after env changes. */
  function freshService(): SandboxServiceType {
    jest.resetModules();
    const { SandboxService } = require('./sandbox.service');
    return new SandboxService() as SandboxServiceType;
  }

  const job = { files: { 'tests/test_x.py': 'import unittest\n' }, mode: 'tests' as const, testPaths: ['tests/test_x.py'] };

  /** A runner that answers exactly what the test asks it to, over a UNIX socket. */
  async function runnerAnswering(status: number, body: string): Promise<{ result: RunResult; close: () => Promise<void> }> {
    const socketPath = path.join(socketDir, `runner-${Math.random().toString(36).slice(2)}.sock`);
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.RUNNER_MODE = 'socket';
    process.env.RUNNER_SOCKET = socketPath;
    const result = await freshService().execute(job);
    return {
      result,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('reports unavailable, not a failing run, when the local harness cannot start', async () => {
    process.env.RUNNER_MODE = 'local';
    process.env.PYTHON_BIN = path.join(socketDir, 'no-python-here');

    const result = await freshService().execute(job);

    expect(result.exitKind).toBe('unavailable');
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
    expect(result.tests).toBeUndefined();
    // The spawn error names the binary we tried; it belongs in the log only.
    expect(JSON.stringify(result)).not.toContain('no-python-here');
  });

  it('reports unavailable when the runner answers with something that is not a result', async () => {
    // Valid JSON, so JSON.parse succeeds; casting it to RunResult would hand
    // back a verdict with `ok: undefined`, which scores as a fail.
    const { result, close } = await runnerAnswering(200, JSON.stringify({ error: 'worker exploded' }));
    try {
      expect(result.exitKind).toBe('unavailable');
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('exploded');
    } finally {
      await close();
    }
  });

  it('reports unavailable when the runner answers a non-200', async () => {
    const { result, close } = await runnerAnswering(503, 'upstream connect error');
    try {
      expect(result.exitKind).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('upstream');
    } finally {
      await close();
    }
  });

  it('passes a real verdict through untouched, including a failing one', async () => {
    const verdict: RunResult = {
      ok: false,
      exitKind: 'error',
      stdout: 'collected 1 item',
      stderr: 'AssertionError: 1 != 2',
      durationMs: 42,
      tests: { total: 1, passed: 0, failed: 1, errored: 0, cases: [] },
    };
    const { result, close } = await runnerAnswering(200, JSON.stringify(verdict));
    try {
      // A learner's failing code is still a verdict: it keeps its exit kind,
      // its output and its cases.
      expect(result).toEqual(verdict);
    } finally {
      await close();
    }
  });
});

/**
 * The preview half of the transport: five routes on the same
 * socket, and three answers a caller must be able to tell apart: the runner
 * has no session by that id, the runner has no free session, and this
 * deployment cannot preview at all. One thrown error for all three would make
 * an outage look like the learner's app failing to start.
 */
describe('SandboxService: the preview transport', () => {
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-preview-'));
  const savedEnv: Record<string, string | undefined> = {
    RUNNER_MODE: process.env.RUNNER_MODE,
    RUNNER_SOCKET: process.env.RUNNER_SOCKET,
    PREVIEW_ENABLED: process.env.PREVIEW_ENABLED,
    PREVIEW_SESSIONS: process.env.PREVIEW_SESSIONS,
    PREVIEW_SOCKET: process.env.PREVIEW_SOCKET,
  };

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  /** config reads env at import time, so the service is required after env changes. */
  function freshService(): SandboxServiceType {
    jest.resetModules();
    const { SandboxService } = require('./sandbox.service');
    return new SandboxService() as SandboxServiceType;
  }

  interface FakeRunner {
    calls: { route: string; body: Record<string, unknown> }[];
    /** Highest number of /app/start calls in flight at once. */
    peakStarts: number;
    close: () => Promise<void>;
    socketPath: string;
  }

  /** A runner that answers whatever the case tells it to, per route. */
  async function fakeRunner(
    answers: Record<string, { status: number; body: unknown; delayMs?: number }>,
  ): Promise<FakeRunner> {
    const state: FakeRunner = {
      calls: [],
      peakStarts: 0,
      socketPath: path.join(socketDir, `r-${Math.random().toString(36).slice(2)}.sock`),
      close: async () => undefined,
    };
    let starts = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const route = req.url || '';
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {};
        state.calls.push({ route, body });
        if (route === '/app/start') {
          starts += 1;
          state.peakStarts = Math.max(state.peakStarts, starts);
        }
        const answer = answers[route] || { status: 404, body: { error: 'not found' } };
        setTimeout(() => {
          if (route === '/app/start') starts -= 1;
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(answer.body));
        }, answer.delayMs || 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(state.socketPath, resolve));
    state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.RUNNER_MODE = 'socket';
    process.env.RUNNER_SOCKET = state.socketPath;
    return state;
  }

  const job = {
    mode: 'preview' as const,
    files: { 'api/main.py': 'print("hi")\n' },
    service: { command: ['python3', 'api/main.py'], portEnv: 'PORT', health: '/api/health' },
    web: { root: 'web/dist', html: 'web/index.html' },
  };

  const startingView = {
    id: 'sess-1',
    status: 'starting',
    message: null,
    stopReason: null,
    bundleOk: true,
    startedAt: '2026-09-05T10:00:00.000Z',
    readyAt: null,
    expiresAt: '2026-09-05T10:10:00.000Z',
    idleExpiresAt: '2026-09-05T10:05:00.000Z',
    bytesServed: 0,
    console: [],
    cursor: 0,
  };

  describe('which socket a preview lives behind', () => {
    it('is the runner socket under RUNNER_MODE=socket', async () => {
      process.env.RUNNER_MODE = 'socket';
      process.env.RUNNER_SOCKET = '/run/learnsdlc/runner.sock';
      delete process.env.PREVIEW_ENABLED;
      await expect(freshService().previewSocket()).resolves.toBe('/run/learnsdlc/runner.sock');
    });

    it('is nothing on the Lambda transport, where an app has nowhere to keep running', async () => {
      process.env.RUNNER_MODE = 'lambda';
      delete process.env.PREVIEW_ENABLED;
      await expect(freshService().previewSocket()).resolves.toBeNull();
    });

    it('is nothing when an operator has turned the preview off', async () => {
      process.env.RUNNER_MODE = 'socket';
      process.env.PREVIEW_ENABLED = 'false';
      await expect(freshService().previewSocket()).resolves.toBeNull();
      delete process.env.PREVIEW_ENABLED;
    });

    /**
     * serve.py answers `/health` with `ok: false` and its own
     * isolation report on a host that cannot confine learner code (macOS). A
     * local transport that read only `ok` would spawn a second runner beside
     * the one already answering and wait out the full boot deadline, and the
     * learner would get "could not reach its runner" instead of the honest
     * isolation sentence. The runner's own report is the answer, at once.
     */
    it('adopts no local runner that reports it cannot isolate learner code, and says why at once', async () => {
      const runner = await fakeRunner({
        '/health': { status: 200, body: { ok: false, isolation: { status: 'unsupported', mechanism: 'none' } } },
      });
      process.env.RUNNER_MODE = 'local';
      process.env.PREVIEW_SOCKET = runner.socketPath;
      delete process.env.PREVIEW_ENABLED;
      try {
        const service = freshService();
        const transport = require('./sandbox.service') as typeof import('./sandbox.service');
        expect(transport.previewUnsupported()).toBeNull();
        const began = Date.now();
        await expect(service.previewSocket()).resolves.toBeNull();
        expect(Date.now() - began).toBeLessThan(5000);
        expect(transport.previewUnsupported()).toBe('isolation');
        expect(runner.calls.map((call) => call.route)).toEqual(['/health']);
      } finally {
        await runner.close();
        delete process.env.PREVIEW_SOCKET;
      }
    });

    it('adopts a local runner whose health reports it can isolate, and remembers that it can', async () => {
      const runner = await fakeRunner({
        '/health': { status: 200, body: { ok: true, isolation: { status: 'ok', mechanism: 'landlock' } } },
      });
      process.env.RUNNER_MODE = 'local';
      process.env.PREVIEW_SOCKET = runner.socketPath;
      delete process.env.PREVIEW_ENABLED;
      try {
        const service = freshService();
        const transport = require('./sandbox.service') as typeof import('./sandbox.service');
        await expect(service.previewSocket()).resolves.toBe(runner.socketPath);
        expect(transport.previewUnsupported()).toBeNull();
        expect(transport.runnerIsolationStatus()).toEqual({ status: 'ok', mechanism: 'landlock' });
      } finally {
        await runner.close();
        delete process.env.PREVIEW_SOCKET;
      }
    });
  });

  it('starts an app and hands back the runner’s own view of it', async () => {
    const runner = await fakeRunner({ '/app/start': { status: 200, body: startingView } });
    try {
      const session = await freshService().startApp(job);
      expect(session.status).toBe('starting');
      expect(session.id).toBe('sess-1');
      expect(runner.calls[0].route).toBe('/app/start');
      // The pack's own command, unchanged: the API never rewrites what it runs.
      expect(runner.calls[0].body.service).toEqual(job.service);
    } finally {
      await runner.close();
    }
  });

  it('reports a full runner as busy rather than as a failed start', async () => {
    const runner = await fakeRunner({
      '/app/start': { status: 503, body: { error: 'runner busy', reason: 'sessions-full' } },
    });
    try {
      const session = await freshService().startApp(job);
      expect(session.status).toBe('busy');
      expect(session.message).toBe('sessions-full');
    } finally {
      await runner.close();
    }
  });

  it('reports a transport that is not there as unavailable, and never throws', async () => {
    process.env.RUNNER_MODE = 'socket';
    process.env.RUNNER_SOCKET = path.join(socketDir, 'nothing-is-listening.sock');
    const session = await freshService().startApp(job);
    expect(session.status).toBe('unavailable');
    expect(session.id).toBe('');
  });

  it('answers a session the runner has forgotten as stopped, not as an error', async () => {
    const runner = await fakeRunner({ '/app/status': { status: 404, body: { error: 'not found' } } });
    try {
      const session = await freshService().statusApp('sess-gone', 0);
      expect(session.status).toBe('stopped');
      expect(session.id).toBe('sess-gone');
    } finally {
      await runner.close();
    }
  });

  it('passes the console cursor through, so a poll carries only what is new', async () => {
    const runner = await fakeRunner({
      '/app/status': { status: 200, body: { ...startingView, status: 'ready', cursor: 12 } },
    });
    try {
      const session = await freshService().statusApp('sess-1', 7);
      expect(session.cursor).toBe(12);
      expect(runner.calls[0].body).toEqual({ id: 'sess-1', cursor: 7 });
    } finally {
      await runner.close();
    }
  });

  it('swallows a stop of a session that is already gone', async () => {
    const runner = await fakeRunner({ '/app/stop': { status: 404, body: { error: 'not found' } } });
    try {
      await expect(freshService().stopApp('sess-gone')).resolves.toBeUndefined();
    } finally {
      await runner.close();
    }
  });

  it('carries a proxied body both ways as bytes, base64 over the socket', async () => {
    const runner = await fakeRunner({
      '/app/proxy': {
        status: 200,
        body: {
          status: 201,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"id":1}').toString('base64'),
          truncated: false,
        },
      },
    });
    try {
      const answer = await freshService().proxyApp(
        'sess-1',
        'POST',
        '/api/lists',
        { 'content-type': 'application/json' },
        Buffer.from('{"name":"Today"}'),
      );
      expect(answer.status).toBe(201);
      expect(answer.body.toString('utf-8')).toBe('{"id":1}');
      expect(Buffer.from(String(runner.calls[0].body.body), 'base64').toString('utf-8')).toBe(
        '{"name":"Today"}',
      );
    } finally {
      await runner.close();
    }
  });

  it('serves an asset as exact bytes, and reads it as text only when asked', async () => {
    // A PNG header: bytes that are not valid UTF-8, which is what would be
    // corrupted if the door served a decoded string.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const runner = await fakeRunner({
      '/app/asset': {
        status: 200,
        body: { status: 200, contentType: 'image/png', body: png.toString('base64') },
      },
    });
    try {
      const asset = await freshService().assetApp('sess-1', 'icon.png');
      expect(asset.bytes.equals(png)).toBe(true);
      expect(asset.contentType).toBe('image/png');
    } finally {
      await runner.close();
    }
  });

  it('holds one preview slot at a time, so two starts do not build at once', async () => {
    process.env.PREVIEW_SESSIONS = '1';
    const runner = await fakeRunner({
      '/app/start': { status: 200, body: startingView, delayMs: 60 },
    });
    try {
      const service = freshService();
      await Promise.all([service.startApp(job), service.startApp(job)]);
      // Both ran; neither ran while the other was building. This is the bound
      // that stops two previews starving a class of thirty.
      expect(runner.calls.filter((c) => c.route === '/app/start')).toHaveLength(2);
      expect(runner.peakStarts).toBe(1);
    } finally {
      delete process.env.PREVIEW_SESSIONS;
      await runner.close();
    }
  });

  it('names the pre-bake when the runner says it is not built on this machine', async () => {
    const { PREBAKE_MISSING_MESSAGE } = require('./sandbox.service');
    const runner = await fakeRunner({
      '/execute': {
        status: 200,
        body: { ok: false, exitKind: 'error', stdout: '', stderr: PREBAKE_MISSING_MESSAGE, durationMs: 1 },
      },
    });
    try {
      jest.resetModules();
      const mod = require('./sandbox.service');
      const service = new mod.SandboxService();
      await service.probePrebake();
      expect(mod.prebakeStatus().status).toBe('missing');
      expect(mod.prebakeStatus().detail).toContain('npm run prebake');
    } finally {
      await runner.close();
    }
  });

  it('calls the layer stale when it is there but does not import', async () => {
    const runner = await fakeRunner({
      '/execute': {
        status: 200,
        body: {
          ok: false,
          exitKind: 'error',
          stdout: '',
          stderr: '',
          durationMs: 1,
          tests: {
            total: 1,
            passed: 0,
            failed: 0,
            errored: 1,
            cases: [{ name: 'test_probe', status: 'errored', message: "No module named 'flask'" }],
          },
        },
      },
    });
    try {
      jest.resetModules();
      const mod = require('./sandbox.service');
      await new mod.SandboxService().probePrebake();
      expect(mod.prebakeStatus().status).toBe('stale');
      expect(mod.prebakeStatus().detail).toContain('flask');
    } finally {
      await runner.close();
    }
  });
});

/* -------------------- latency programme, step 1 -------------------------- */

/**
 * `sandbox_execution_duration_seconds` measures how long one sandbox execution
 * takes as the API waits for it (the ~2.5 s a fresh machine costs and the
 * queue behind the runner slots), from the running product. Beyond
 * the number it has two jobs: it must say what the execution was for from a
 * set of labels fixed in code, and it must never be able to fail the execution
 * it is watching.
 */
describe('SandboxService.execute: the execution histogram', () => {
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-sandbox-timing-'));
  const savedEnv: Record<string, string | undefined> = {
    RUNNER_MODE: process.env.RUNNER_MODE,
    RUNNER_SOCKET: process.env.RUNNER_SOCKET,
    PYTHON_BIN: process.env.PYTHON_BIN,
  };

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  type Metrics = typeof import('../observability/metrics');

  /**
   * The service and the metrics module it just bound to, from one reset: the
   * registry is a module singleton, so the instance the service observes on is
   * only the one that was loaded beside it.
   */
  function freshPair(): { service: SandboxServiceType; metrics: Metrics } {
    jest.resetModules();
    const { SandboxService } = require('./sandbox.service');
    return {
      service: new SandboxService() as SandboxServiceType,
      metrics: require('../observability/metrics') as Metrics,
    };
  }

  /** Every series the histogram has counted, as `{purpose, outcome} -> count`. */
  async function counted(metrics: Metrics): Promise<Record<string, number>> {
    const snapshot = await metrics.sandboxExecutionDuration.get();
    const rows: Record<string, number> = {};
    for (const row of snapshot.values) {
      if (row.metricName !== 'sandbox_execution_duration_seconds_count') continue;
      rows[`${row.labels.purpose}/${row.labels.outcome}`] = row.value;
    }
    return rows;
  }

  const job = { files: { 'tests/test_x.py': 'import unittest\n' }, mode: 'tests' as const, testPaths: ['tests/test_x.py'] };

  const verdict: RunResult = {
    ok: false,
    exitKind: 'error',
    stdout: '',
    stderr: 'SyntaxError',
    durationMs: 1200,
  };

  /** A runner on a socket of its own, answering `/execute` with one body. */
  async function runner(body: unknown): Promise<{ socketPath: string; close: () => Promise<void> }> {
    const socketPath = path.join(socketDir, `r-${Math.random().toString(36).slice(2)}.sock`);
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.RUNNER_MODE = 'socket';
    process.env.RUNNER_SOCKET = socketPath;
    return { socketPath, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('counts one execution, by what it was for and by how the run ended', async () => {
    const fake = await runner(verdict);
    try {
      const { service, metrics } = freshPair();

      // No trace owner: this is the shape a graded submission sends
      // (feedback.service.ts runSandbox).
      await service.execute(job);

      expect(await counted(metrics)).toEqual({ 'grading/error': 1 });
    } finally {
      await fake.close();
    }
  });

  it('tells a learner’s Run press and the platform’s own probe apart by the trace owner', async () => {
    const fake = await runner({ ...verdict, ok: true, exitKind: 'ok', stderr: '' });
    try {
      const { service, metrics } = freshPair();

      // The owner execution.service.ts sends on a Run press, and the probe's
      // own identity, which is platform work and not a learner waiting.
      await service.execute(job, { kind: 'run', ownerId: '11111111-2222-4333-8444-555555555555', stepId: 'api' });
      await service.probePrebake();

      expect(await counted(metrics)).toEqual({ 'run/ok': 1, 'probe/ok': 1 });
    } finally {
      await fake.close();
    }
  });

  it('counts a transport that never answered as unavailable, and still returns the result', async () => {
    process.env.RUNNER_MODE = 'socket';
    process.env.RUNNER_SOCKET = path.join(socketDir, 'nothing-is-listening.sock');
    const { service, metrics } = freshPair();

    const result = await service.execute(job);

    expect(result.exitKind).toBe('unavailable');
    expect(await counted(metrics)).toEqual({ 'grading/unavailable': 1 });
  });

  it('never lets the measurement itself fail a learner’s job', async () => {
    const fake = await runner(verdict);
    try {
      const { service, metrics } = freshPair();
      jest.spyOn(metrics.sandboxExecutionDuration, 'observe').mockImplementation(() => {
        throw new Error('the registry refused this series');
      });

      // A verdict about the learner's code, unchanged: the histogram is an
      // observation, and an observation may not cost a submission.
      await expect(service.execute(job)).resolves.toEqual(verdict);
    } finally {
      jest.restoreAllMocks();
      await fake.close();
    }
  });

  it('keeps the outcome label inside the five exit kinds the contract declares', async () => {
    // `parseResult` checks that `exitKind` is a string and no more, so the
    // union is a compile-time cast over a value the runner chose. A label
    // value is a series name the registry then keeps for the life of the
    // process, so whether this family stays at fifteen series cannot be the
    // runner's decision to make.
    const rogue = 'killed: /run/sandbox/9 exceeded its cgroup';
    const fake = await runner({ ...verdict, exitKind: rogue });
    try {
      const { service, metrics } = freshPair();

      const result = await service.execute(job);

      // What the caller gets back is untouched: narrowing the result would
      // change what every scorer downstream reads, and only the series is
      // bounded here.
      expect(result.exitKind).toBe(rogue);
      expect(await counted(metrics)).toEqual({ 'grading/error': 1 });
    } finally {
      await fake.close();
    }
  });

  it('refuses a prototype key, an empty string or a paragraph as an exit kind', () => {
    const { boundedExitKind } = require('./sandbox.service') as typeof import('./sandbox.service');

    // The five the contract declares pass through untouched.
    for (const kind of ['ok', 'timeout', 'memory', 'error', 'unavailable'] as const) {
      expect(boundedExitKind(kind)).toBe(kind);
    }
    // Everything else is the runner's word, and reads as the run having ended
    // in an error, which is the only thing we can honestly say about it.
    for (const rogue of ['__proto__', 'constructor', 'toString', '', 'OK', 'x'.repeat(5000)]) {
      expect(boundedExitKind(rogue)).toBe('error');
    }
  });

  it('cannot observe a negative duration when the clock is stepped backwards', async () => {
    const fake = await runner({ ...verdict, ok: true, exitKind: 'ok', stderr: '' });
    try {
      const { service, metrics } = freshPair();
      // A machine whose clock is adjusted mid-job: every reading is earlier
      // than the one before it, whichever clock the measurement reads. A
      // negative observation is one a histogram's `_sum` never recovers from,
      // and it makes every quantile over that series wrong for the life of the
      // process.
      let falling = 1_700_000_000_000;
      const backwards = () => (falling -= 5_000);
      jest.spyOn(Date, 'now').mockImplementation(backwards);
      jest.spyOn(performance, 'now').mockImplementation(backwards);

      await service.execute(job);
      jest.restoreAllMocks();

      const snapshot = await metrics.sandboxExecutionDuration.get();
      const sum = snapshot.values.find(
        (row) => row.metricName === 'sandbox_execution_duration_seconds_sum',
      );
      expect(sum?.value).toBe(0);
    } finally {
      jest.restoreAllMocks();
      await fake.close();
    }
  });
});

/* ------------------- the runner's own refusal sentence ------------------ */

/**
 * The Lambda invoke path, with the SDK client stubbed: what the function
 * answers is either a result (including an `unavailable` one whose stderr
 * is the runner's sentence about a job it cannot run here, which must reach
 * the caller verbatim) or lambda_handler.py's own `{error}` envelope, which
 * is no result and is named as the handler's refusal in the log.
 */
describe('SandboxService.execute: the Lambda transport keeps the runner’s sentence', () => {
  const savedEnv: Record<string, string | undefined> = {
    RUNNER_MODE: process.env.RUNNER_MODE,
    RUNNER_LAMBDA_FUNCTION: process.env.RUNNER_LAMBDA_FUNCTION,
  };

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
  });

  const job = {
    files: { 'x.test.ts': "test('ok', () => { assert.ok(true); });" },
    mode: 'tests' as const,
    testPaths: ['x.test.ts'],
    language: 'typescript' as const,
  };

  /** A service whose Lambda client answers exactly this payload. */
  function lambdaAnswering(payload: string): { service: SandboxServiceType; send: jest.Mock; log: string[] } {
    process.env.RUNNER_MODE = 'lambda';
    process.env.RUNNER_LAMBDA_FUNCTION = 'learnsdlc-code-runner';
    jest.resetModules();
    const { SandboxService } = require('./sandbox.service');
    const service = new SandboxService() as SandboxServiceType;
    const send = jest.fn(async () => ({ Payload: Buffer.from(payload, 'utf-8') }));
    (service as unknown as { lambdaClient: unknown }).lambdaClient = { send };
    const log: string[] = [];
    (service as unknown as { logger: { error: (m: string) => void } }).logger = {
      error: (m: string) => log.push(m),
    } as never;
    return { service, send, log };
  }

  it('passes an unavailable result and its sentence through untouched', async () => {
    const sentence = 'this transport cannot run JavaScript: there is no node here.';
    const fromRunner: RunResult = { ok: false, exitKind: 'unavailable', stdout: '', stderr: sentence, durationMs: 0 };
    const { service, send } = lambdaAnswering(JSON.stringify(fromRunner));

    const result = await service.execute(job);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual(fromRunner);
    expect(result.stderr).toBe(sentence);
  });

  it('reads the handler’s {error} envelope as no result and logs only a bounded category', async () => {
    const { service, log } = lambdaAnswering(JSON.stringify({ error: 'preview is not available on this transport' }));

    const result = await service.execute(job);

    expect(result.exitKind).toBe('unavailable');
    expect(result.ok).toBe(false);
    // No sentence: an envelope is the transport's answer, not the runner's
    // sentence for the learner. The log records the category without copying
    // provider prose that could contain source, environment or credentials.
    expect(result.stderr).toBe('');
    expect(log.join('\n')).toContain('category=lambda-handler-refusal');
    expect(log.join('\n')).not.toContain('preview is not available on this transport');
  });
});
