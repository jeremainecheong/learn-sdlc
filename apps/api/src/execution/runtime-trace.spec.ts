import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';
import { prebakeStatus, SandboxService } from './sandbox.service';
import { STARTUP_PROBE_STEP_ID, startupProbeOwner } from './startup-probe';

describe('private runtime trace transport', () => {
  const original = { runnerMode: config.runnerMode, runnerSocket: config.runnerSocket, previewEnabled: config.previewEnabled };
  let server: http.Server;
  let directory: string;
  let requests: { route: string; trace: unknown; body: Record<string, unknown> }[];
  let lookupAnswer: unknown;
  let startupOwner: string | undefined;
  const owner = { kind: 'run' as const, ownerId: '61302b28-a4f2-4411-b7c6-e42a2e166633', stepId: 'frontend' };
  const job = { mode: 'tests' as const, files: { 'index.js': 'source-canary' }, testPaths: ['index.js'] };
  const verdict = { ok: false, exitKind: 'timeout', stdout: '', stderr: '', durationMs: 15000 };

  beforeEach(async () => {
    startupOwner = process.env.RUNNER_STARTUP_OWNER_ID;
    delete process.env.RUNNER_STARTUP_OWNER_ID;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-spec-'));
    requests = [];
    lookupAnswer = { found: false, cleanupConfirmed: false };
    config.runnerMode = 'socket';
    config.runnerSocket = path.join(directory, 'runner.sock');
    config.previewEnabled = true;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ route: req.url!, trace: req.headers['x-learnsdlc-trace'] ? JSON.parse(req.headers['x-learnsdlc-trace'] as string) : undefined,
          body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/operation/owner' ? lookupAnswer : req.url === '/app/start' ? { id: 'controller-id', status: 'starting' }
          : { ...verdict, operationId: 'private-operation', vmId: 'private-vm', diagnostics: { private: 'private-canary' } }));
      });
    });
    await new Promise<void>(resolve => server.listen(config.runnerSocket, resolve));
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
    Object.assign(config, original);
    if (startupOwner === undefined) delete process.env.RUNNER_STARTUP_OWNER_ID;
    else process.env.RUNNER_STARTUP_OWNER_ID = startupOwner;
  });

  it('sends generated attempt identity outside source and never returns private metadata', async () => {
    const service = new SandboxService();
    const result = await service.execute({ ...job, trace: { attemptId: 'learner-spoof' } } as typeof job, owner);
    expect(result).toEqual(verdict);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(requests[0].trace).toMatchObject(owner);
    expect((requests[0].trace as { attemptId: string }).attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(requests[0].trace)).not.toContain('source-canary');
    expect(requests[0].body).not.toHaveProperty('ownerId');
    expect(requests[0].body.timeoutSeconds).toBe(config.runTimeoutSeconds);
    expect(requests[0].body.memoryMb).toBe(config.runMemoryMb);
    await service.execute(job, owner);
    expect(requests[1].trace).not.toEqual(requests[0].trace);
  });

  it('an unowned probe cannot derive an owner from learner job fields', async () => {
    await new SandboxService().execute({ ...job, ownerId: owner.ownerId, kind: 'run' } as typeof job);
    expect(requests[0].trace).toBeUndefined();
  });

  it('binds only the fixed startup probe to the operator owner with a fresh attempt each boot', async () => {
    process.env.RUNNER_STARTUP_OWNER_ID = owner.ownerId;
    const originalLimits = [config.runTimeoutSeconds, config.runMemoryMb];
    try {
      config.runTimeoutSeconds = 15;
      config.runMemoryMb = 256;
      await new SandboxService().probePrebake();
      await new SandboxService().probePrebake();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.trace).toMatchObject({ kind: 'run', ownerId: owner.ownerId, stepId: STARTUP_PROBE_STEP_ID });
        expect(request.body).toEqual({
          files: { 'tests/test_probe.py': 'import flask, pytest\n\n\ndef test_probe():\n    assert True\n' },
          mode: 'tests', testPaths: ['tests'], language: 'python', harness: 'pytest', timeoutSeconds: 15, memoryMb: 256,
        });
      }
      expect((requests[0].trace as { attemptId: string }).attemptId).not.toEqual((requests[1].trace as { attemptId: string }).attemptId);
      await new SandboxService().execute({ ...job, env: { RUNNER_STARTUP_OWNER_ID: owner.ownerId }, ownerId: owner.ownerId } as typeof job);
      expect(requests[2].trace).toBeUndefined();
    } finally {
      [config.runTimeoutSeconds, config.runMemoryMb] = originalLimits;
    }
  });

  it('gives ordinary startup probes a fresh server owner when no deployment owner was supplied', async () => {
    await new SandboxService().probePrebake();
    await new SandboxService().probePrebake();
    const traces = requests.map(request => request.trace as { ownerId: string; attemptId: string; stepId: string });
    expect(traces.every(trace => /^[0-9a-f-]{36}$/.test(trace.ownerId) && trace.stepId === STARTUP_PROBE_STEP_ID)).toBe(true);
    expect(traces[0].ownerId).not.toBe(traces[1].ownerId);
    expect(traces[0].attemptId).not.toBe(traces[1].attemptId);
  });

  it('refuses malformed configured startup identity without dispatching or leaking its value', async () => {
    for (const invalid of ['', 'private-canary', owner.ownerId.toUpperCase(), ` ${owner.ownerId}`, `${owner.ownerId}\n`, JSON.stringify(owner)]) {
      process.env.RUNNER_STARTUP_OWNER_ID = invalid;
      expect(() => startupProbeOwner()).toThrow('Invalid platform startup owner');
      await new SandboxService().probePrebake();
      expect(prebakeStatus()).toEqual({ status: 'unknown', detail: 'dependency probe refused because the platform startup identity is invalid' });
      expect(requests).toHaveLength(0);
    }
  });

  it('associates the API preview ID without exposing it to the guest payload', async () => {
    const previewOwner = { kind: 'preview' as const, ownerId: 'a'.repeat(24), stepId: 'app' };
    await new SandboxService().startApp({ mode: 'preview', files: {}, service: { command: ['python3', 'api/main.py'], portEnv: 'PORT', health: '/health' },
      web: { root: 'web', html: 'index.html' } }, previewOwner);
    expect(requests[0].trace).toMatchObject(previewOwner);
    expect(JSON.stringify(requests[0].body)).not.toContain(previewOwner.ownerId);
  });

  it('treats missing owners as unconfirmed and validates exact recovered controller identity', async () => {
    const service = new SandboxService();
    expect(await service.lookupAppOwner('a'.repeat(24))).toEqual({ found: false, cleanupConfirmed: false });
    lookupAnswer = { found: true, runnerId: owner.ownerId, cleanupConfirmed: false, vmId: 'private-vm' };
    expect(await service.lookupAppOwner('a'.repeat(24))).toEqual({ found: true, runnerId: owner.ownerId, cleanupConfirmed: false });
    lookupAnswer = { found: true, runnerId: '../../private', cleanupConfirmed: true };
    await expect(service.lookupAppOwner('a'.repeat(24))).rejects.toThrow('could not be reconciled');
    lookupAnswer = { found: false, cleanupConfirmed: true };
    await expect(service.lookupAppOwner('a'.repeat(24))).rejects.toThrow('could not be reconciled');
    expect(requests.every(request => request.route === '/operation/owner')).toBe(true);
  });
});
